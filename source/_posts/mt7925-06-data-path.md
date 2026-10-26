---
title: MT7925 驱动学习 06：数据通路（TX/RX 队列、TXWI/RXD、token 与 TX_FREE）
date: 2026-09-13 18:00:00
tags:
  - MT7925
  - 数据通路
  - DMA
categories:
  - 无线网络
  - WiFi
---

## 文档概述

本文梳理 MT7925 收发包的完整软件路径：队列划分与尺寸、TX 侧 TXWI 构造与 token 生命周期、RX 侧从 DMA ring 到 `mt76_rx()` 的解析流程，以及 MLO 在数据通路上的体现（per-link wcid / WTBL）。

---

## 一、队列与描述符总览

| 队列 | 编号 | 尺寸 | 用途 |
| --- | --- | --- | --- |
| `MT7925_TXQ_BAND0` | 0 | `MT7925_TX_RING_SIZE = 2048` | 数据帧（AC 队列映射到此） |
| `MT7925_TXQ_MCU_WM` | 15 | `MT7925_TX_MCU_RING_SIZE = 256` | MCU 命令 |
| `MT7925_TXQ_FWDL` | 16 | `MT7925_TX_FWDL_RING_SIZE = 128` | 固件下载（`MCU_CMD(FW_SCATTER)`） |
| `MT7925_RXQ_MCU_WM` | 0 | `MT7925_RX_MCU_RING_SIZE = 512` | MCU 事件 + TXS |
| `MT7925_RXQ_BAND0` | 2 | `MT7925_RX_RING_SIZE = 1536` | 数据帧 |
| `MT7925_TOKEN_SIZE` | — | 8192 | 在飞 MSDU 的硬件 token 池 |

TXWI 组成：`MT_TXD_SIZE + sizeof(struct mt76_connac_hw_txp)`（`drv_ops.txwi_size`）。

```plaintext
  skb headroom                        payload
 ┌──────────────┬──────────────┬────────────────────┐
 │  MT_TXD      │  HW TXP      │ 802.11 / 802.3 数据 │
 │ (MAC 控制信息)│ (DMA 描述)   │                    │
 └──────────────┴──────────────┴────────────────────┘
        ↑ txwi_size 由 drv_ops.txwi_size 决定，USB 侧换成 MT_SDIO_TXD_SIZE
```

---

## 二、RX 路径：从 DMA ring 到 mac80211

### 2.1 分流第一层：`mt7925_rx_check()`

NAPI 轮询时 mt76 框架先调 `rx_check()` 判断"这一批要不要交给 `rx_skb()`"；MT7925 借它顺手把两类不需要 skb 的**回收信息**处理掉：

```c
switch (type) {
case PKT_TYPE_TXRX_NOTIFY:
	/* PKT_TYPE_TXRX_NOTIFY can be received only by mmio devices */
	mt7925_mac_tx_free(dev, data, len); /* mmio */
	return false;
case PKT_TYPE_TXS:
	for (rxd += 4; rxd + 12 <= end; rxd += 12)
		mt7925_mac_add_txs(dev, rxd);
	return false;
default:
	return true;
}
```

- `PKT_TYPE_TXRX_NOTIFY`（TX 完成）与 `PKT_TYPE_TXS`（每帧发送状态）**只在 mmio 设备（PCIe）上出现**，USB 走的是 `mt7925_usb_sdio_tx_status_data` 回调。
- 返回 `false` 表示"这一批我已经处理完了，别再建 skb"，是省内存的关键优化。

### 2.2 分流第二层：`mt7925_queue_rx_skb()`

```c
switch (type) {
case PKT_TYPE_TXRX_NOTIFY:
	mt7925_mac_tx_free(dev, skb->data, skb->len);
	napi_consume_skb(skb, 1);
	break;
case PKT_TYPE_RX_EVENT:
	mt7925_mcu_rx_event(dev, skb);
	break;
case PKT_TYPE_TXS:
	for (rxd += 2; rxd + 8 <= end; rxd += 8)
		mt7925_mac_add_txs(dev, rxd);
	dev_kfree_skb(skb);
	break;
case PKT_TYPE_NORMAL_MCU:
case PKT_TYPE_NORMAL:
	if (!mt7925_mac_fill_rx(dev, skb)) {
		mt76_rx(&dev->mt76, q, skb);
		return;
	}
	fallthrough;
default:
	dev_kfree_skb(skb);
	break;
}
```

四条路径对应四种"包"：

| PKT_TYPE | 含义 | 去向 |
| --- | --- | --- |
| `NORMAL` / `NORMAL_MCU` | 真正的 802.11 数据帧 | `mt7925_mac_fill_rx()` → `mt76_rx()` → mac80211 |
| `RX_EVENT` | MCU 事件 | `mt7925_mcu_rx_event()` |
| `TXS` | 每个 MSDU 的发送状态（速率/重传/ACK RSSI） | `mt7925_mac_add_txs()` → 统计 |
| `TXRX_NOTIFY` | TX 完成 + token 释放信息 | `mt7925_mac_tx_free()` |

**skb 所有权约定**：只有 `NORMAL*` 成功后 skb 被交给 mac80211（`return`，不再释放），其余分支都在这里释放。`RX_EVENT` 比较特殊——释放与否由 `mt7925_mcu_uni_rx_unsolicited_event()` 内部决定。

### 2.3 RXD 解析：`mt7925_mac_fill_rx()`

MT7925 的 RX 头**没有 C 结构体**，就是裸的 32bit 字 + 位域宏：

```c
	__le32 *rxd = (__le32 *)skb->data;
	/* 通过 MT_RXD0_* / MT_RXD1_* / MT_RXD2_* 宏取字段 */
```

`mt7925_mac_fill_rx()` 负责把硬件头部翻译成 mac80211 能懂的信息，主要工作：

| 步骤 | 内容 |
| --- | --- |
| 取长度/类型 | `MT_RXD0_LENGTH`、`MT_RXD2_NORMAL_...` 判断 frame control / 帧类型 |
| 找 wcid | `MT_RXD1_NORMAL_WLAN_IDX` → `mt76_rx_status.wcid`；MLO 下还要取 link id 找到正确的 `mlink` |
| 802.3 转换 | 若硬件做了 `hdr_trans`（把 802.11 头转成 802.3），调用 `mt7925_reverse_frag0_hdr_trans()` 之类做还原 |
| 加解密状态 | 从 RXD 的 PN/IV 字段填 `status->flag`（`RX_FLAG_DECRYPTED`）、`status->pn`，交给 mac80211 的 `ieee80211_rx()` 做重放检查 |
| 速率信息 | `mt7925_mac_fill_rx_rate()` 从 RXD 的 RXV 里算 `rate->mcs/nss/bw/he/eht`，转成 mac80211 的 `ieee80211_rx_status` |
| 质量信息 | RSSI/SNR、`signal`、`chains`，来自 RXD 的 P-RXV 字段 |
| AMSDU | 因为开了 `MT_MDP_DCR0_DAMSDU_EN`，硬件已去聚合，驱动直接按 MSDU 处理 |

最后 `mt76_rx()` 统一走一遍 BA 会话检查（`mt76_rx_aggr_check`）、`ieee80211_rx_*` 上报，并把 airtime 累计到 survey。

---

## 三、TX 路径：从 mac80211 到 DMA

### 3.1 上半段（公共）

```plaintext
mac80211 (选取 sta/rate，做聚合与 BA 决策)
   → ops->tx = mt792x_tx()
        ├─ 选 wcid（mlink->wcid），MLO 下由 mac80211 指定 link
        ├─ 分配 TXWI（token 机制：mt76_token_get()）
        ├─ drv_ops.tx_prepare_skb()        ★ 芯片差异点
        └─ mt76_txq_schedule() → 填 DMA 描述符提交
```

### 3.2 `tx_prepare_skb`：PCIe 与 USB 分道

| 版本 | 函数 | 特点 |
| --- | --- | --- |
| PCIe | `mt7925e_tx_prepare_skb()`（`pci_mac.c`） | 把 TXWI **写进 DMA 缓冲**（`mt76_dma_tx_queue_skb` 的 txwi 位置），无需额外拷贝 |
| USB | `mt7925_usb_sdio_tx_prepare_skb()`（`mac.c`） | 因为 USB 要自带 802.3/802.11 头与 SDIO 头部，用 `mt7925_usb_sdio_write_txwi()` 组包 |
| 完成回调 | PCIe：`mt76_connac_tx_complete_skb`；USB：`mt7925_usb_sdio_tx_complete_skb` | 回收 skb/urb |

### 3.3 `mt7925_mac_write_txwi()`：真正写 TXWI

`mac.c` 里按协议头分两个函数，再由 `mt7925_mac_write_txwi()` 统一：

```text
mt7925_mac_write_txwi_8023()    /* WDS/以太网封装（AP 模式发往客户端） */
mt7925_mac_write_txwi_80211()   /* 原生 802.11 帧（管理帧、EAPOL 等） */
        ↘            ↙
      mt7925_mac_write_txwi()
```

写进去的关键字段：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `TX_BYTES` | skb->len | 帧长 |
| `PKT_FMT` / `HDR_FORMAT` | 帧类型 | 802.11 / 802.3 / CMD |
| `WLAN_IDX` | `wcid->idx` | **WTBL 索引**，硬件靠它找 STA 的密钥/BA/速率 |
| `OMAC` / `BAND` / `WMM` | `mt792x_bss_conf.mt76` | 来自 `link_id` 对应的链路配置 |
| `Q_IDX` | AC 队列 | 与 WMM AC 的 EDCA 参数对应 |
| 加密相关 | `wcid` 的 key | 硬件加密时置对应位 |
| MLO 相关 | `mlink` / `mconf` | MLO 下必须用**链路**的 omac/band 而不是默认链路 |

写完 TXWI 后 `mt7925_tx_check_aggr()` 会检查是否需要建立/维护 BA 聚合相关信息（如 tid 与 wcid 的对应）。

### 3.4 TX 完成：`mt7925_mac_tx_free()`

这是数据通路里最值得逐行读的函数：

```c
static void mt7925_mac_tx_free(struct mt792x_dev *dev, void *data, int len)
{
	/* clean DMA queues and unmap buffers first */
	mt76_queue_tx_cleanup(dev, dev->mphy.q_tx[MT_TXQ_PSD], false);
	mt76_queue_tx_cleanup(dev, dev->mphy.q_tx[MT_TXQ_BE], false);

	if (WARN_ON_ONCE(le32_get_bits(tx_free[1], MT_TXFREE1_VER) < 4))
		return;                        /* ① 版本检查 */

	total = le32_get_bits(tx_free[0], MT_TXFREE0_MSDU_CNT);
	for (cur_info = &tx_free[2]; count < total; cur_info++) {
		info = le32_to_cpu(*cur_info);
		if (info & MT_TXFREE_INFO_PAIR) {   /* ② 新的 wcid 对 */
			idx = FIELD_GET(MT_TXFREE_INFO_WLAN_ID, info);
			wcid = rcu_dereference(dev->mt76.wcid[idx]);
			sta = wcid_to_sta(wcid);
			if (!sta)
				continue;

			mlink = container_of(wcid, struct mt792x_link_sta, wcid);
			spin_lock_bh(&mdev->sta_poll_lock);
			if (list_empty(&mlink->wcid.poll_list))
				list_add_tail(&mlink->wcid.poll_list, &mdev->sta_poll_list);
			spin_unlock_bh(&mdev->sta_poll_lock);
			continue;
		}

		if (info & MT_TXFREE_INFO_HEADER) {  /* ③ 重传/失败计数 */
			wcid->stats.tx_retries += FIELD_GET(MT_TXFREE_INFO_COUNT, info) - 1;
			wcid->stats.tx_failed  += !!FIELD_GET(MT_TXFREE_INFO_STAT, info);
			continue;
		}

		for (i = 0; i < 2; i++) {            /* ④ 一个 32bit 里塞两个 MSDU id */
			msdu = (info >> (15 * i)) & MT_TXFREE_INFO_MSDU_ID;
			if (msdu == MT_TXFREE_INFO_MSDU_ID)
				continue;
			count++;
			txwi = mt76_token_release(mdev, msdu, &wake);
			if (!txwi)
				continue;
			mt7925_txwi_free(dev, txwi, sta, wcid, &free_list);
		}
	}

	mt7925_mac_sta_poll(dev);                /* ⑤ 更新每 STA 的速率/airtime */
	if (wake)
		mt76_set_tx_blocked(&dev->mt76, false);
	mt76_worker_schedule(&dev->mt76.tx_worker);
	list_for_each_entry_safe(skb, tmp, &free_list, list) {
		skb_list_del_init(skb);
		napi_consume_skb(skb, 1);
	}
}
```

五个要点：

1. **先清 DMA 队列**（PSD/BE）：TX_FREE 事件到达时，硬件已完成 DMA，驱动要先把 ring 上的描述符回收，才能安全释放 skb。
2. **`MT_TXFREE1_VER < 4` 直接返回**：硬件格式版本校验，不匹配说明固件/驱动不配套（会 `WARN_ON_ONCE` 一次）。
3. **压缩编码**：`MT_TXFREE_INFO_*` 是一套"变长记录"：带 `PAIR` 位的记录给出一个新的 wcid，后续记录沿用这个 wcid；带 `HEADER` 位的是重传/失败统计；其余记录每个 32bit 打包 2 个 MSDU id（每个 15bit）。
4. **`container_of(wcid, struct mt792x_link_sta, wcid)`**：因为 `wcid` 是 `mt792x_link_sta` 的首成员，所以从 wcid 指针能一步拿到链路对象，再挂到 `sta_poll_list` 供后续统一 poll。**MLO 下"每个链路一个 wcid"，这条路径天然按链路统计。**
5. **`mt76_token_release()` 是"发得出去"的开关**：token 用满时 `mt792x_tx()` 会置 `MT76_TX_BLOCKED`，只有 TX_FREE 归还 token 并 `mt76_set_tx_blocked(false)` 后才恢复发包。**现象是"能连上但传不动"，通常就是 token 泄漏或 TX_FREE 没被处理。**

### 3.5 TXS：每帧发送结果

```c
mt7925_mac_add_txs(dev, rxd)   /* 解析一条 TXS 记录 */
    → mt7925_mac_add_txs_skb(dev, wcid, pid, ...)
         ├─ 取 ack 信号（ack_signal）、速率、重传次数、airtime
         ├─ ewma 平滑：dev->mphy.avg_ack_signal / mlink->avg_ack_signal
         └─ 供 rate 上报（mac80211 的 TX 状态上报）
```

`mt7925_mac_sta_poll()` 则把这些按 STA 累计起来（`airtime_ac`、`tx_retries`…），最终喂给 `get_survey`、`sta_statistics` 与 `mt792x_get_et_stats`。

---

## 四、MLO 在数据通路上的体现

| 环节 | 具体表现 |
| --- | --- |
| wcid | **每条链路一个 wcid**（`mt792x_link_sta.wcid`），`wcid->link_id` 标明属于哪条链路 |
| WTBL | 每个 wcid 对应一个 WTBL 表项，硬件按 `WLAN_IDX` 找地址/密钥/BA |
| TXWI | `OMAC`/`BAND`/`WMM` 取自 `link_id` 对应的 `mt792x_bss_conf`，而不是默认链路 |
| RX | RXD 里的 wlan idx + link 信息定位到具体链路的 `mlink`，再做 PN/BA 检查 |
| 统计 | TX_FREE/TXS 是按 wcid 归集的，因此 MLO 的每链路统计是天然分开的 |
| 排序 | 硬件不做重排序（AMPDU Reordering 仍在 mac80211 的 BA 会话里），MLO 的乱序由 mac80211 统一处理 |

---

## 五、通路全景

```plaintext
发包
  mac80211 ──► mt792x_tx ──► token 分配 ──► tx_prepare_skb ──► write_txwi ──► DMA ring
                                                                                 │
                                                       ┌─────────────────────────┘
                                                       ▼
                                            TX_FREE 事件（TXRX_NOTIFY）
                                                       ├─ mt76_queue_tx_cleanup(PSD/BE)
                                                       ├─ token release
                                                       └─ mt7925_txwi_free → napi_consume_skb
收包
  DMA ring ──► mt7925_rx_check（分流 TXS/TX_FREE）
                  └─► mt7925_queue_rx_skb
                         ├─ NORMAL*  ──► mt7925_mac_fill_rx ──► mt76_rx ──► mac80211
                         ├─ RX_EVENT ──► mt7925_mcu_rx_event
                         ├─ TXS      ──► mt7925_mac_add_txs（速率/ACK 信号）
                         └─ TXRX_NOTIFY ──► mt7925_mac_tx_free（token 回收）
```

---

## 六、问题排查速查

| 现象 | 落点 | 说明 |
| --- | --- | --- |
| 能关联但吞吐为 0 / 很快卡住 | `mt76_token_release()` + `MT76_TX_BLOCKED` | token 被耗尽没回收（TX_FREE 丢失、队列清理异常） |
| `WARN_ON_ONCE(MT_TXFREE1_VER < 4)` | `mt7925_mac_tx_free()` | 固件与驱动版本不匹配（TX_FREE 格式变了） |
| 速率/信号强度显示不对 | `mt7925_mac_fill_rx_rate()` / `mt7925_mac_add_txs()` | RXD/TXS 解析与 `mt792x` 转换链；先确认 TXS 是否到达 |
| 收包但上层收不到 | `mt7925_mac_fill_rx()` 返回非 0 | wcid 查不到（WTBL 未建）、PN 校验失败、hdr_trans 转换异常 |
| skb 泄漏（`slabinfo` 里 skb 一直涨） | `mt7925_queue_rx_skb()` / `mt7925_mcu_uni_rx_unsolicited_event()` | skb 所有权分支写错，尤其是 `RX_EVENT` 与 `SCAN_DONE`/`COREDUMP` |
| 只有一条链路有流量 | TXWI 的 omac/band | 用了默认链路而不是 `link_id` 指定的链路 |

配套命令：

```bash
# 看每 STA 的速率/airtime（mt792x 公共 debugfs）
cat /sys/kernel/debug/ieee80211/<phy>/netdev:<dev>/stations 2>/dev/null
# 队列与 token 情况（mt76 debugfs）
ls /sys/kernel/debug/ieee80211/<phy>/mt76/
# 是否出现 TX 阻塞
dmesg | grep -i -E "tx blocked|tx free|token"
```

---

## 七、小结

1. TX/RX 各只有一条主数据通路（`TXQ_BAND0=0` / `RXQ_BAND0=2`），再加 MCU 与 FWDL 两条辅助队列。
2. 分流发生在 `mt7925_rx_check()` 与 `mt7925_queue_rx_skb()` 两层，`PKT_TYPE_*` 决定 skb 的归属；`TXRX_NOTIFY` 只出现在 PCIe。
3. **TX 的生命线是 token**：`mt76_token_get/release` 与 `MT76_TX_BLOCKED` 是"发不出去"类问题的第一现场。
4. **RX 的解析是位域级的**：MT7925 的 RXD 是裸 32bit 字 + `MT_RXD*` 宏，没有结构体；速率/RSSI/加密状态都在 `mt7925_mac_fill_rx()` 里翻译。
5. MLO 在数据通路的落点就是"每条链路一个 wcid + WTBL 表项"，因此 TXWI 构造和 TX 统计都必须按 `link_id` 走。
