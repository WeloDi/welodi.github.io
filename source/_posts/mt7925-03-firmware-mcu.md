---
title: MT7925 驱动学习 03：固件加载与 MCU 通信（ROM patch、命令与事件通道）
date: 2026-09-13 21:00:00
tags:
  - MT7925
  - 固件加载
  - MCU
categories:
  - 无线网络
  - WiFi
---

## 文档概述

MT7925 的射频、速率自适应、扫描、省电等核心逻辑都运行在片内 **WF_MCU** 上。驱动与 MCU 的交互只有两件事：**下载固件 / 收发命令**。本文梳理固件文件、下载序列、命令通道（TX ring）与事件通道（RX ring）的完整链路。

---

## 一、固件文件从哪来

固件名不是写死在 `mt7925/` 里，而是按芯片 ID 从共享层挑：

```c
/* mt792x.h */
#define MT7920_FIRMWARE_WM "mediatek/WIFI_RAM_CODE_MT7961_1a.bin"
#define MT7921_FIRMWARE_WM "mediatek/WIFI_RAM_CODE_MT7961_1.bin"
#define MT7922_FIRMWARE_WM "mediatek/WIFI_RAM_CODE_MT7922_1.bin"
#define MT7925_FIRMWARE_WM "mediatek/mt7925/WIFI_RAM_CODE_MT7925_1_1.bin"

#define MT7920_ROM_PATCH "mediatek/WIFI_MT7961_patch_mcu_1a_2_hdr.bin"
#define MT7921_ROM_PATCH "mediatek/WIFI_MT7961_patch_mcu_1_2_hdr.bin"
#define MT7922_ROM_PATCH "mediatek/WIFI_MT7922_patch_mcu_1_1_hdr.bin"
#define MT7925_ROM_PATCH "mediatek/mt7925/WIFI_MT7925_PATCH_MCU_1_1_hdr.bin"

static inline char *mt792x_ram_name(struct mt792x_dev *dev)
{
	switch (mt76_chip(&dev->mt76)) {
	case 0x7920:  return MT7920_FIRMWARE_WM;
	case 0x7922:  return MT7922_FIRMWARE_WM;
	case 0x7925:  return MT7925_FIRMWARE_WM;
	default:      return MT7921_FIRMWARE_WM;   /* 7921 */
	}
}

static inline char *mt792x_patch_name(struct mt792x_dev *dev)
{
	switch (mt76_chip(&dev->mt76)) {
	case 0x7920:  return MT7920_ROM_PATCH;
	case 0x7922:  return MT7922_ROM_PATCH;
	case 0x7925:  return MT7925_ROM_PATCH;
	default:      return MT7921_ROM_PATCH;
	}
}
```

MT7925 用两份文件：

| 文件 | 作用 |
| --- | --- |
| `mediatek/mt7925/WIFI_MT7925_PATCH_MCU_1_1_hdr.bin` | ROM patch：给 ROM 里的 MCU 代码打补丁，必须先下载 |
| `mediatek/mt7925/WIFI_RAM_CODE_MT7925_1_1.bin` | RAM code：真正实现 802.11 行为的固件主体 |

两个文件名同时用 `MODULE_FIRMWARE()` 声明，从而进入 module 的 depends 信息（`modinfo mt7925e` 能看到）：

```c
MODULE_FIRMWARE(MT7925_FIRMWARE_WM);
MODULE_FIRMWARE(MT7925_ROM_PATCH);
```

> 注意路径里带了 `mt7925/` 子目录，而 7921/7922 的固件直接放在 `mediatek/` 下 —— 从 `linux-firmware` 里找文件时容易找错位置。

---

## 二、下载序列：`mt792x_load_firmware()`

```c
int mt792x_load_firmware(struct mt792x_dev *dev)
{
	int ret;

	ret = mt76_connac2_load_patch(&dev->mt76, mt792x_patch_name(dev));
	if (ret)
		return ret;

	if (mt76_is_sdio(&dev->mt76)) {
		/* activate again */
		ret = __mt792x_mcu_fw_pmctrl(dev);
		if (!ret)
			ret = __mt792x_mcu_drv_pmctrl(dev);
	}

	ret = mt76_connac2_load_ram(&dev->mt76, mt792x_ram_name(dev), NULL);
	if (ret)
		return ret;

	if (!mt76_poll_msec(dev, MT_CONN_ON_MISC, MT_TOP_MISC2_FW_N9_RDY,
			    MT_TOP_MISC2_FW_N9_RDY, 1500)) {
		dev_err(dev->mt76.dev, "Timeout for initializing firmware\n");
		return -EIO;
	}

#ifdef CONFIG_PM
	dev->mt76.hw->wiphy->wowlan = &mt76_connac_wowlan_support;
#endif
	dev_dbg(dev->mt76.dev, "Firmware init done\n");

	return 0;
}
```

四个关键点：

1. **先 patch 后 RAM**：`mt76_connac2_load_patch()` 把 ROM patch 分段塞进 MCU 的 SYSRAM，并在结尾向固件请求"patch 信号量"（`MCU_CMD(PATCH_SEM_CONTROL)`）；`mt76_connac2_load_ram()` 才下载带 trailer 描述（region）的固件主体。
2. **SDIO（含 USB 同族路径）需要重新握手电源**：下载 patch 后 MCU 已醒来一次，必须再次 `fw_pmctrl` / `drv_pmctrl` 才能进入 RAM code 下载。
3. **就绪靠轮询一个 bit**：`MT_CONN_ON_MISC` 的 `MT_TOP_MISC2_FW_N9_RDY`，超时 1500ms。这一位不通就是 `Timeout for initializing firmware`。
4. **WoWLAN 能力在这里挂上**：`wiphy->wowlan = &mt76_connac_wowlan_support`。

---

## 三、驱动侧的固件入口：`mt7925_run_firmware()`

```c
int mt7925_run_firmware(struct mt792x_dev *dev)
{
	int err;

	err = mt792x_load_firmware(dev);
	if (err)
		return err;

	err = mt7925_mcu_get_nic_capability(dev);
	if (err)
		return err;

	set_bit(MT76_STATE_MCU_RUNNING, &dev->mphy.state);

	err = mt7925_load_clc(dev, mt792x_ram_name(dev));
	if (err)
		return err;

	return mt7925_mcu_fw_log_2_host(dev, 1);
}
```

顺序很有信息量：

| 步骤 | 目的 |
| --- | --- |
| `mt792x_load_firmware()` | patch + RAM code 下载并等就绪 |
| `mt7925_mcu_get_nic_capability()` | 问固件"你支持什么" → 填 `phy->chip_cap`、`phy->eml_cap`、频段等 |
| `set_bit(MT76_STATE_MCU_RUNNING, ...)` | 标记 MCU 已跑起来（后续 `mt76_mcu_send_msg` 才敢发） |
| `mt7925_load_clc()` | 下载 **CLC**（Country/Level Control）功率与信道限制表 |
| `mt7925_mcu_fw_log_2_host(dev, 1)` | 打开固件日志上报（debugfs `fw_debug` 也控制它） |

### CLC 表为什么要单独处理

```c
static int mt7925_load_clc(struct mt792x_dev *dev, const char *fw_name)
{
	...
	if (mt7925_disable_clc || mt76_is_usb(&dev->mt76))
		return 0;                       /* USB 不做，模块参数可关 */

	ret = request_firmware(&fw, fw_name, mdev->dev);   /* 复用 RAM code 文件 */
	...
	if ((region->feature_set & FW_FEATURE_NON_DL) && region->type == FW_TYPE_CLC) {
		clc_base = (u8 *)(fw->data + offset);
		break;
	}
	...
	ret = mt7925_mcu_set_clc(dev, "00", ENVIRON_INDOOR);
```

CLC 数据**不是单独文件**，而是 RAM code 固件文件里一个不下载到芯片的 region（`FW_FEATURE_NON_DL` + `FW_TYPE_CLC`）：驱动本地解析后再用 `MCU_UNI_CMD(SET_POWER_LIMIT)` 把规则发给固件。所以 6GHz 信道、发射功率被限，第一嫌疑就是 CLC / 监管域。

---

## 四、PCIe 侧的 MCU 初始化：`mt7925e_mcu_init()`

```c
int mt7925e_mcu_init(struct mt792x_dev *dev)
{
	static const struct mt76_mcu_ops mt7925_mcu_ops = {
		.headroom = sizeof(struct mt76_connac2_mcu_txd),
		.mcu_skb_send_msg = mt7925_mcu_send_message,
		.mcu_parse_response = mt7925_mcu_parse_response,
	};
	int err;

	dev->mt76.mcu_ops = &mt7925_mcu_ops;     /* ① 换掉 MCU 收发实现 */

	err = mt792xe_mcu_fw_pmctrl(dev);        /* ② 固件侧电源控制 */
	if (err)
		return err;

	err = __mt792xe_mcu_drv_pmctrl(dev);     /* ③ 驱动取回控制权 */
	if (err)
		return err;

	mt76_rmw_field(dev, MT_PCIE_MAC_PM, MT_PCIE_MAC_PM_L0S_DIS, 1);  /* ④ 禁 L0S */

	err = mt7925_run_firmware(dev);                                  /* ⑤ 跑固件 */
	mt76_queue_tx_cleanup(dev, dev->mt76.q_mcu[MT_MCUQ_FWDL], false);/* ⑥ 清 FWDL 环 */

	return err;
}
```

- `headroom = sizeof(struct mt76_connac2_mcu_txd)`：MCU 命令的每个 skb 都要在头部预留一个 16 字节命令描述符（TXWI 前的 MCU 头），这是 mt76 分配 MCU skb 时 `skb_reserve()` 的依据。
- USB 侧的 `mt7925u_mcu_init()` 用的是 `mt76_mcu_ops` 变体：`headroom = MT_SDIO_HDR_SIZE + sizeof(struct mt76_connac2_mcu_txd)`、`tailroom = MT_USB_TAIL_SIZE`。
- `mt7925_run_firmware()` 返回后 FWDL 队列里的残留 skb 一次性清掉（下载过程中它们是"发完即弃"的）。

---

## 五、命令通道：MCU 消息怎么发出去

### 5.1 发送入口

```c
static int mt7925_mcu_send_message(struct mt76_dev *mdev, struct sk_buff *skb,
				   int cmd, int *seq)
{
	enum mt76_mcuq_id txq = MT_MCUQ_WM;
	int ret;

	ret = mt7925_mcu_fill_message(mdev, skb, cmd, seq);
	if (ret)
		return ret;

	mdev->mcu.timeout = 3 * HZ;                 /* 默认 3 秒超时 */

	if (cmd == MCU_CMD(FW_SCATTER))
		txq = MT_MCUQ_FWDL;                 /* 固件下载走独立队列 */

	return mt76_tx_queue_skb_raw(dev, mdev->q_mcu[txq], skb, 0);
}
```

**命令就是"反向的发包"**：MCU 命令被当成一个 skb，插在 TX ring 的 MCU 队列（`MT7925_TXQ_MCU_WM = 15`）上，由 DMA 送给固件。所以 TX ring 卡住 = 所有控制命令（扫描、关联、改信道）一起卡住。

### 5.2 命令描述符构造：`mt7925_mcu_fill_message()`

MT7925 支持两种命令格式：老的 `mt76_connac2_mcu_txd`（非 UNI）和新的 `mt76_connac2_mcu_uni_txd`（UNI），由 `cmd` 的 UNI 标志位决定：

```c
	/* TODO: make dynamic based on msg type */
	mdev->mcu.timeout = 20 * HZ;

	seq = ++mdev->mcu.msg_seq & 0xf;              /* 4bit 序列号，0 跳过 */
	if (!seq)
		seq = ++mdev->mcu.msg_seq & 0xf;

	if (cmd == MCU_CMD(FW_SCATTER))               /* 固件数据不用 TXWI */
		goto exit;

	txd_len = cmd & __MCU_CMD_FIELD_UNI ? sizeof(*uni_txd) : sizeof(*mcu_txd);
	txd = (__le32 *)skb_push(skb, txd_len);

	val = FIELD_PREP(MT_TXD0_TX_BYTES, skb->len) |
	      FIELD_PREP(MT_TXD0_PKT_FMT, MT_TX_TYPE_CMD) |
	      FIELD_PREP(MT_TXD0_Q_IDX, MT_TX_MCU_PORT_RX_Q0);
	txd[0] = cpu_to_le32(val);
	txd[1] = cpu_to_le32(FIELD_PREP(MT_TXD1_HDR_FORMAT, MT_HDR_FORMAT_CMD));

	if (cmd & __MCU_CMD_FIELD_UNI) {
		uni_txd = (struct mt76_connac2_mcu_uni_txd *)txd;
		uni_txd->len = cpu_to_le16(skb->len - sizeof(uni_txd->txd));
		uni_txd->cid = cpu_to_le16(mcu_cmd);
		uni_txd->s2d_index = MCU_S2D_H2N;
		uni_txd->pkt_type = MCU_PKT_ID;
		uni_txd->seq = seq;

		if (cmd & __MCU_CMD_FIELD_QUERY)
			uni_txd->option = MCU_CMD_UNI_QUERY_ACK;   /* 需要回包 */
		else
			uni_txd->option = MCU_CMD_UNI_EXT_ACK;
		goto exit;
	}
	/* 非 UNI：老格式，用 cid/ext_cid + set_query */
	mcu_txd->cid = mcu_cmd;
	mcu_txd->ext_cid = FIELD_GET(__MCU_CMD_FIELD_EXT_ID, cmd);
	...
	mcu_txd->set_query = mcu_txd->ext_cid ? MCU_Q_SET : MCU_Q_NA;
	mcu_txd->s2d_index = (cmd & __MCU_CMD_FIELD_WA) ? MCU_S2D_H2C : MCU_S2D_H2N;
```

要点：

- **`seq` 是 4bit 回绕**，`0` 被跳过（0 表示"不需要匹配"）。
- **`option` 决定要不要等回包**：`MCU_CMD_UNI_QUERY_ACK` 会阻塞等待对应 `seq` 的响应；`MCU_CMD_UNI_EXT_ACK` 只等一个"已收到"的确认。
- **`s2d_index`** 区分命令发给谁：`H2N`（固件网络侧）/ `H2C`（WA 通路）。
- 宏 `MCU_UNI_CMD(x)`、`MCU_WM_UNI_CMD(x)`、`MCU_WMWA_UNI_CMD(x)`、`MCU_CMD(x)`、`MCU_UNI_CMD_QUERY(x)` 就是把 cid/ext_cid/uni/query/wa 几个位段拼成一个 `int cmd`。

### 5.3 MT7925 用到的命令族（节选自 `mt7925/mcu.c`）

| 命令 | 用途 |
| --- | --- |
| `MCU_UNI_CMD(DEV_INFO_UPDATE)` | 设备级信息：频段、能力、RTS 阈值等 |
| `MCU_UNI_CMD(BSS_INFO_UPDATE)` | BSS/链路级：bss_info、beacon、PS、Inet 等 |
| `MCU_UNI_CMD(STA_REC_UPDATE)` / `MCU_WMWA_UNI_CMD(STA_REC_UPDATE)` | STA 记录与 WTBL 相关（含 EHT/MLD 记录） |
| `MCU_UNI_CMD(EDCA_UPDATE)` / `QUEUE_UPDATE` | WMM/EDCA 参数 |
| `MCU_UNI_CMD(SCAN_REQ)` / `(SNIFFER)` / `(ROC)` | 扫描、监听、Remain-On-Channel |
| `MCU_UNI_CMD(HIF_CTRL)` / `(SUSPEND)` | 总线挂起、系统休眠协作 |
| `MCU_UNI_CMD(CHIP_CONFIG)` / `(WSYS_CONFIG)` / `(EFUSE_CTRL)` | 芯片配置、efuse/eeprom |
| `MCU_UNI_CMD(SET_POWER_LIMIT)` | 功率限制（CLC 也走它） |
| `MCU_WM_UNI_CMD(REG_ACCESS)` / `_QUERY(THERMAL)` | 寄存器访问、温度读取 |
| `MCU_UNI_CMD(BAND_CONFIG)` / `(SET_DOMAIN_INFO)` / `(SET_DBDC_PARMS)` | 频段与监管域配置 |

STA 场景的 TLV 构造统一走 `__mt76_connac_mcu_alloc_sta_req()` + `mt76_connac_mcu_add_tlv()`，MT7925 的 TLV 标签里能看到 Wi-Fi 7 的痕迹：`STA_REC_EHT`、`STA_REC_EHT_MLD`、`STA_REC_MLD`、`STA_REC_MLD_OFF`、`STA_REC_HE_6G`、`STA_REC_HW_AMSDU`、`STA_REC_RA`…

---

## 六、事件通道：从 RX ring 到 `mt7925_mcu_rx_event()`

MCU 事件也是"包"，从 `MT_RXQ_MCU` ring 上来，经 `mt7925_queue_rx_skb()` 的 `PKT_TYPE_RX_EVENT` 分支进入：

```c
void mt7925_mcu_rx_event(struct mt792x_dev *dev, struct sk_buff *skb)
{
	struct mt7925_mcu_rxd *rxd = (struct mt7925_mcu_rxd *)skb->data;

	if (skb_linearize(skb))
		return;

	if (rxd->option & MCU_UNI_CMD_UNSOLICITED_EVENT) {
		mt7925_mcu_uni_rx_unsolicited_event(dev, skb);
		return;
	}

	mt76_mcu_rx_event(&dev->mt76, skb);   /* 否则是某个命令的响应 */
}
```

主动事件按 `eid` 分发：

```c
	switch (rxd->eid) {
	case MCU_UNI_EVENT_FW_LOG_2_HOST:      mt7925_mcu_uni_debug_msg_event(dev, skb); break;
	case MCU_UNI_EVENT_ROC:                mt7925_mcu_uni_roc_event(dev, skb);       break;
	case MCU_UNI_EVENT_SCAN_DONE:          mt7925_mcu_scan_event(dev, skb);          return;
	case MCU_UNI_EVENT_TX_DONE:            mt7925_mcu_tx_done_event(dev, skb);       break;
	case MCU_UNI_EVENT_BSS_BEACON_LOSS:    mt7925_mcu_connection_loss_event(dev, skb); break;
	case MCU_UNI_EVENT_COREDUMP:
		dev->fw_assert = true;
		mt76_connac_mcu_coredump_event(&dev->mt76, skb, &dev->coredump);
		return;                            /* skb 交给 coredump 处理 */
	default: break;
	}
	dev_kfree_skb(skb);
```

两类"路径"值得注意：

- **响应 vs 事件**：只有 `option & MCU_UNI_CMD_UNSOLICITED_EVENT` 才走事件分发，其余进 `mt76_mcu_rx_event()` 按 `seq` 匹配等待中的命令（这一层是阻塞式同步调用）。
- **谁负责释放 skb**：`SCAN_DONE` 与 `COREDUMP` 是 `return`（skb 被挂到 `scan_event_list` / coredump 队列，由 work 处理），其余分支自己 `dev_kfree_skb()`。写这块代码时最容易出 skb 泄漏或 double free。

### 响应解析：`mt7925_mcu_parse_response()`

```c
	rxd = (struct mt7925_mcu_rxd *)skb->data;
	if (seq != rxd->seq)
		return -EAGAIN;                       /* seq 不匹配 → 不是我要的，回去继续等 */

	if (cmd == MCU_CMD(PATCH_SEM_CONTROL) || cmd == MCU_CMD(PATCH_FINISH_REQ)) {
		skb_pull(skb, sizeof(*rxd) - 4);
		ret = *skb->data;                     /* patch 类响应：单字节状态 */
	} else if (cmd == MCU_UNI_CMD(DEV_INFO_UPDATE) || cmd == MCU_UNI_CMD(BSS_INFO_UPDATE) ||
		   cmd == MCU_UNI_CMD(STA_REC_UPDATE) || cmd == MCU_UNI_CMD(HIF_CTRL) ||
		   cmd == MCU_UNI_CMD(OFFLOAD) || cmd == MCU_UNI_CMD(SUSPEND)) {
		struct mt7925_mcu_uni_event *event;
		skb_pull(skb, sizeof(*rxd));
		event = (struct mt7925_mcu_uni_event *)skb->data;
		ret = le32_to_cpu(event->status);     /* 这几种命令的响应带 status */
		if (mcu_cmd != event->cid)            /* cid 对不上，继续等 */
			ret = -EAGAIN;
	}
```

三个状态码含义（面试常问）：

| 返回 | 含义 | mt76 的后续动作 |
| --- | --- | --- |
| `0` | 成功 | 调用者继续 |
| `-EAGAIN` | 收到的是别的响应/事件 | 不报错，继续等自己的 seq |
| `-ETIMEDOUT` | 等不到（`skb == NULL`） | 打印 `Message %08x (seq %d) timeout` 并 **`mt792x_reset(mdev)`** |

最后这条很重要：**一次 MCU 超时就会触发整个芯片复位**，所以 dmesg 里出现 `Message ... timeout` 往往后面紧跟一串 reset 日志，根因却可能在别处（TX ring 满、固件崩了、bus 挂起时序）。

---

## 七、调试线索速查

| dmesg 关键字 | 位置 | 常见原因 |
| --- | --- | --- |
| `direct firmware load ... mt7925/WIFI_...` 失败 | `request_firmware()` | linux-firmware 缺失或版本不对（注意 `mt7925/` 子目录） |
| `Timeout for initializing firmware` | `mt792x_load_firmware()` 的 1500ms 轮询 | patch/RAM 下载后固件没起、`MT_TOP_MISC2_FW_N9_RDY` 不通 |
| `Message %08x (seq %d) timeout` | `mt7925_mcu_parse_response()` | 命令超时 → 随后自动 `mt792x_reset()` |
| `iw` 里没有 MLD/MLO 能力 | `mt7925_mcu_get_nic_capability()` + `mt7925_init_mlo_caps()` | `chip_cap` 里缺 `MT792x_CHIP_CAP_MLO_EVT_EN`，此时 MLO 能力被**静默跳过**（不打印错误） |
| 6GHz 信道不可用 / 功率偏低 | CLC + `SET_POWER_LIMIT` | `alpha2` 未设（`00`）、CLC region 没匹配、监管域限制 |

配套开关：

```bash
# 打开固件日志上报（1 开 0 关）
echo 1 > /sys/kernel/debug/ieee80211/<phy>/mt76/fw_debug
# 关掉 CLC（排查功率/信道限制是否来自 CLC）
modprobe mt7925e disable_clc=1
# 打印 MCU 消息（需要 CONFIG_DYNAMIC_DEBUG）
echo 'module mt7925e +p' > /sys/kernel/debug/dynamic_debug/control
```

---

## 八、小结

1. MT7925 需要 **patch + RAM code 两份固件**，名字由 `mt792x_ram_name()/mt792x_patch_name()` 按 chip id 选出，放在 `mediatek/mt7925/` 下。
2. 下载由 `mt792x_load_firmware()` 完成：patch → （SDIO/USB 需再握手电源）→ RAM code → 轮询 `MT_TOP_MISC2_FW_N9_RDY`。
3. `mt7925_run_firmware()` 在固件跑起来后补三件事：取 NIC 能力、置 `MT76_STATE_MCU_RUNNING`、下发 CLC 并打开固件日志。
4. 命令与事件共用 TX/RX 的 MCU 环：命令走 `MT7925_TXQ_MCU_WM(=15)`，`FW_SCATTER` 走独立的 FWDL 环；响应用 4bit `seq` 匹配，主动事件由 `option` 标志区分。
