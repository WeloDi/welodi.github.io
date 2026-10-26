---
title: MT7925 驱动学习 04：MAC 初始化与硬件寄存器配置
date: 2026-09-13 20:00:00
tags:
  - MT7925
  - MAC
  - register
categories:
  - 无线网络
  - WiFi
---

## 文档概述

本文从 `mt7925_register_device()` 开始，追一遍 MT7925 上电到"可收发包"的全过程：软资源初始化 → 异步 `init_work` → 固件/MAC 寄存器配置 → WTBL 与定点速率表 → wiphy 能力上报（HE/EHT/MLO）。

---

## 一、软资源初始化：`mt7925_register_device()`

probe 的最后一步（无论 PCIe 还是 USB 都汇聚到这里）。它只做"分配 + 挂接 + 排队"，真正的硬件操作全部丢给 `init_work`：

```c
int mt7925_register_device(struct mt792x_dev *dev)
{
	struct ieee80211_hw *hw = mt76_hw(dev);
	int ret;

	dev->phy.dev = dev;
	dev->phy.mt76 = &dev->mt76.phy;
	dev->mt76.tx_worker.fn = mt792x_tx_worker;   /* 每个 PHY 的 TX worker */

	spin_lock_init(&dev->phy.stats_lock);
	mutex_init(&dev->mt76.mutex);
	INIT_WORK(&dev->init_work, mt7925_init_work);
	INIT_WORK(&dev->reset_work, mt7925_mac_reset_work);
	INIT_WORK(&dev->phy.roc_work, mt7925_roc_work);
	INIT_WORK(&dev->dump_work, mt7925_coredump_work);
	timer_setup(&dev->phy.roc_timer, mt7925_roc_timer, 0);
	init_waitqueue_head(&dev->wait);
	INIT_LIST_HEAD(&dev->ipv6_ns_list);
	INIT_WORK(&dev->ipv6_ns_work, mt7925_ipv6_ns_work);

	mutex_init(&dev->pm.mutex);
	init_waitqueue_head(&dev->pm.wait);

	/* 省电默认值：USB 与 PCIe 行为不同 */
	dev->pm.idle_timeout = MT792x_PM_TIMEOUT;   /* = HZ / 12，约 83ms */
	dev->pm.ds_enable = mt76_is_mmio(&dev->mt76) && !dev->disable_runtime_pm;
	dev->pm.enable = !dev->disable_runtime_pm;

	spin_lock_init(&dev->token_lock);
	idr_init(&dev->token);
	/* 允许的最大 STA/AP 数：MT7925_WTBL_SIZE(=20) 里留出广播等 */
	dev->wcid.max_txqs = MT7925_WTBL_SIZE - 1;
	dev->wcid.tx_info |= MT_WCID_TX_INFO_SET;

	mt792x_init_wcid(dev);       /* wcid 表：从 MT_WCID_TAG 开始 */
	mt792x_init_wiphy(hw);

	hw->wiphy->flags |= WIPHY_FLAG_HAS_REMAIN_ON_CHANNEL;
	hw->wiphy->features |= NL80211_FEATURE_...
	hw->max_rates = 2;
	SET_IEEE80211_PERM_ADDR(hw, dev->macaddr ...);

	/* HT 能力 */
	hw->wiphy->bands[NL80211_BAND_5GHZ]->ht.sgi = true;
	hw->wiphy->bands[NL80211_BAND_2GHZ]->ht.sgi = true;
	...
	queue_work(system_wq, &dev->init_work);

	return ret;
}
```

这里出现的三个默认值值得单独记：

| 字段/常量 | 值 | 含义 |
| --- | --- | --- |
| `MT792x_PM_TIMEOUT` | `HZ / 12`（≈83ms） | 空闲多久尝试进入省电 |
| `MT7925_WTBL_SIZE` | 20 | 硬件 WTBL 表项数，决定最大 STA/AP 与链路对象数 |
| `hw->max_rates` | 2 | 每个 STA 提供两个 fallback 速率（配合 `set_fixed_rate_table()`） |

---

## 二、异步初始化：`mt7925_init_work()`

```c
static void mt7925_init_work(struct work_struct *work)
{
	struct mt792x_dev *dev = container_of(work, struct mt792x_dev, init_work);
	struct ieee80211_hw *hw = mt76_hw(dev);
	int ret;

	ret = mt7925_init_hardware(dev);
	if (ret)
		goto err;

	mt76_set_stream_caps(&dev->mphy, true);
	dev->phy.eht_cap.phy_cap_info[0] ...   /* 见第三节 */
	mt7925_set_stream_he_eht_caps(&dev->phy);

	/* MLO 能力（依赖 chip_cap；缺能力位时静默跳过，不返回错误） */
	mt7925_init_mlo_caps(&dev->phy);

	ret = mt76_register_device(&dev->mt76, true, mt7925_rates,
				   ARRAY_SIZE(mt7925_rates));
	if (ret)
		goto err;

	mt7925_init_debugfs(dev);
	mt7925_thermal_init(&dev->phy);
	set_bit(MT76_STATE_INITIALIZED, &dev->mphy.state);
	dev->hw_init_done = true;
	mt792x_init_acpi_sar_power(dev, !dev->disable_runtime_pm);
	mt792x_mcu_drv_pmctrl(dev);
	mt792x_pm_power_save_sched(dev);
}
```

顺序上的因果链：

```plaintext
mt7925_init_hardware()
   └─ 固件跑起来 + MAC 寄存器配置 + WTBL 就绪
        ↓
mt7925_set_stream_he_eht_caps()   → wiphy 有 HE/EHT 能力
        ↓
mt7925_init_mlo_caps()            → wiphy->flags |= WIPHY_FLAG_SUPPORTS_MLO
        ↓
mt76_register_device()            → 此时才把 wiphy 注册给 mac80211
```

**能力必须在 `mt76_register_device()` 之前填完**——注册之后再改 `wiphy` 就不生效了，这是和 mac80211 "先上报后使用"模型的直接冲突点。

---

## 三、`mt7925_init_hardware()` 与重试机制

```c
static int mt7925_init_hardware(struct mt792x_dev *dev)
{
	int ret, i;

	mt76_wr(dev, MT_INT_SOURCE_CSR, ~0);      /* 清所有中断源 */

	for (i = 0; i < MT792x_MCU_INIT_RETRY_COUNT; i++) {     /* 10 次 */
		ret = mt792x_mcu_init(dev);            /* → mt7925e_mcu_init()/mt7925u_mcu_init() */
		if (!ret)
			break;

		mt792x_init_reset(dev);                /* 失败就复位，再试 */
		msleep(20);
	}
	if (ret)
		return ret;

	ret = mt76_eeprom_override(&dev->mphy);    /* 用 DT/ACPI 里的 MAC 覆盖 */
	if (ret)
		return ret;

	ret = mt7925_mcu_set_eeprom(dev);          /* 把 eeprom 数据交给固件 */
	if (ret)
		return ret;

	return mt7925_mac_init(dev);               /* 下一节 */
}
```

两层重试要分清：

- **固件下载重试**：`MT792x_MCU_INIT_RETRY_COUNT = 10`，每次失败 `mt792x_init_reset()` 后睡 20ms 再来。板子时序不对时会看到 dmesg 连续打印 10 次失败。
- **运行期复位**：`mt792x_reset()`（MCU 超时/固件异常触发），走的是**软复位** `mt7925_mac_reset_work()`，与这里不同。

---

## 四、MAC 寄存器初始化：`mt7925_mac_init()`

```c
static void mt7925_mac_init(struct mt792x_dev *dev)
{
	int i;

	mt76_rmw_field(dev, MT_MDP_DCR1, MT_MDP_DCR1_MAX_RX_LEN, 1536);
	/* enable hardware de-agg */
	mt76_set(dev, MT_MDP_DCR0, MT_MDP_DCR0_DAMSDU_EN);
	/* 清 WTBL：把 20 个表项全部无效化 */
	for (i = 0; i < MT792x_WTBL_SIZE; i++)
		mt7925_mac_wtbl_update(dev, i, MT_WTBL_UPDATE_ADM_COUNT_CLEAR);

	for (i = 0; i < __MT_MAX_BAND; i++)     /* BN0 / BN1 两个 band */
		mt7925_mac_init_band(dev, i);

	/* 基础速率表：11 组，用于 beacon/管理帧 */
	mt76_clear(dev, MT_WTBL_BASE_CFG, ...);
	mt76_wr(dev, MT_WTBL_ITCR, ...);

	/* 监管域缺省值 */
	mt7925_mcu_set_mlo_alpha2(dev);   /* dev->alpha2 缺省全 0，等 mac80211 下发 */
}
```

三件事各自的含义：

1. **`MT_MDP_DCR1_MAX_RX_LEN = 1536`**：MAC 层允许的最大接收长度（避免把超大帧塞进 skb）。改这个值会直接影响 RX 缓冲占用。
2. **`MT_MDP_DCR0_DAMSDU_EN`**：硬件去聚合（de-AMSDU）。**这是 `MT_DRV_AMSDU_OFFLOAD` 能生效的前提**——硬件帮驱动拆 A-MSDU，RX 路径就不用处理聚合子帧。
3. **WTBL 清零**：WTBL（Weight Table，硬件 STA 表）是 MT7925 MAC 的核心。每个 `wcid` 对应一个表项，存地址、密钥、BA 会话、速率、队列归属。初始化必须全清，否则残留表项会让 RX 匹配到错误 STA。

```c
void mt7925_mac_wtbl_update(struct mt792x_dev *dev, int idx, u32 mask)
{
	mt76_rmw(dev, MT_WTBL_UPDATE, MT_WTBL_UPDATE_WLAN_IDX, FIELD_PREP(MT_WTBL_UPDATE_WLAN_IDX, idx));
	mt76_set(dev, MT_WTBL_UPDATE, mask);
	mt76_set(dev, MT_WTBL_UPDATE, MT_WTBL_UPDATE_BUSY);   /* 触发 */

	if (!mt76_poll_msec(dev, MT_WTBL_UPDATE, MT_WTBL_UPDATE_BUSY, 0, 500))
		dev_err(dev->mt76.dev, "WTBL update timeout\n");
}
```

`MT_WTBL_UPDATE_BUSY` 是硬件握手位：写进去后要轮询它归零，超时 500ms 会打印 `WTBL update timeout`（表项操作太频繁或总线访问被 PM 打断时出现）。

### 定点速率表

每 STA 的固定速率（`set_fixed_rate_table`）通过 WTBL 的间接访问寄存器写：

```c
	/* 通过 MT_WTBL_ITDR0/1 写一张 8 项速率表，再用 ITCR 提交 */
	mt76_rmw_field(dev, MT_WTBL_ITCR, MT_WTBL_ITCR_WR, 1);
	... 
	ret = mt76_poll(dev, MT_WTBL_ITCR, MT_WTBL_ITCR_BUSY, 0, 5000);
	if (ret < 0)
		return ret;
```

管理帧（beacon/probe resp）与 `hw->max_rates = 2` 的 fallback 都依赖这张表。

---

## 五、寄存器访问层：三条路径别混用

MT7925 里有**三种**访问寄存器的方式，调试时经常被混淆：

| 路径 | 入口 | 适用场景 | 限制 |
| --- | --- | --- | --- |
| mmio（驱动内部） | `mt76_rr/wr/rmw` → `mt7925_rr/wr/rmw` → `__mt7925_reg_addr()` | 驱动自己初始化、跑流程 | 只能在 device 上下文；需要 L1/L2 重映射 |
| MCU 代理读写 | `mt7925_mcu_regval()` → `MCU_WM_UNI_CMD(REG_ACCESS)` | debugfs 的 `regval`、固件持有控制权时 | 只能访问固件允许的地址；命令超时会触发复位 |
| 固件上报 | `MCU_WM_UNI_CMD_QUERY(REG_ACCESS)` | 读固件内部状态 | 异步/需等事件 |

关键 chip id / rev 寄存器（`mt7925/regs.h` 侧使用）：

```c
MT_HW_CHIPID     /* 芯片 ID，probe 里 <<16 存进 dev->rev */
MT_HW_REV        /* 版本号（低 8 位） */
MT_HW_EMI_CTL    /* EMI 休眠保护，probe 里 SLPPROT_EN(BIT(1)) 置 1 = 使能 */
MT_CONN_ON_MISC  /* MT_TOP_MISC2_FW_N9_RDY：固件就绪位 */
MT_PCIE_MAC_INT_ENABLE / MT_WFDMA0_HOST_INT_ENA  /* 中断使能 */
```

`MT_HW_CHIPID` 决定"这到底是什么芯片"，所以 `mt792x_ram_name()`、能力表都靠它分流；`MT_HW_REV` 则影响部分 workaround 分支。

---

## 六、能力上报：HE / EHT / MLO

### 6.1 频段与 HE

```c
	/* 2GHz：HE 最大 40MHz */
	phy->mt76->sband_2g.sband.iftype[band].he_cap.he_cap_elem.phy_cap_info[0] &=
		~IEEE80211_HE_PHY_CAP0_CHANNEL_WIDTH_SET_40MHZ_IN_2G;
	/* 5GHz：40/80/160 */
```

频段来源是 `cap.has_2ghz/has_5ghz/has_6ghz`（EEPROM/NIC 能力决定），能力位按频段分别填。

### 6.2 EHT（Wi-Fi 7）

```c
	/* EHT PHY 能力：只填 80MHz / 160MHz 两档带宽 */
	mcs = eht_cap->eht_mcs_...
	eht_cap->eht_mcs_... = IEEE80211_EHT_MCS_NSS_RX / _TX
	bw._80 = ...;   bw._160 = ...;
```

从能力位能反推硬件档位：**MT7925 的 EHT 上报里只有 80MHz / 160MHz 两个带宽域**，没有 320MHz 相关字段。功率表结构也印证这一点（有 `eht_ru_*` 条目但带宽档位仍以 160 为上限）。

### 6.3 MLO

这个函数定义在 `mt7925/main.c`（不是 init.c），代码很短但信息量很大：

```c
int mt7925_init_mlo_caps(struct mt792x_phy *phy)
{
	struct wiphy *wiphy = phy->mt76->hw->wiphy;
	static const u8 ext_capa_sta[] = {
		[7] = WLAN_EXT_CAPA8_OPMODE_NOTIF,
	};
	static struct wiphy_iftype_ext_capab ext_capab[] = {
		{
			.iftype = NL80211_IFTYPE_STATION,
			.extended_capabilities = ext_capa_sta,
			.extended_capabilities_mask = ext_capa_sta,
			.extended_capabilities_len = sizeof(ext_capa_sta),
		},
	};

	if (!(phy->chip_cap & MT792x_CHIP_CAP_MLO_EVT_EN))
		return 0;                       /* ★ 静默跳过，不报错 */

	ext_capab[0].eml_capabilities = phy->eml_cap;
	ext_capab[0].mld_capa_and_ops =
		u16_encode_bits(1, IEEE80211_MLD_CAP_OP_MAX_SIMUL_LINKS);
	wiphy->flags |= WIPHY_FLAG_SUPPORTS_MLO;
	wiphy->iftype_ext_capab = ext_capab;
	wiphy->num_iftype_ext_capab = ARRAY_SIZE(ext_capab);

	return 0;
}
```

三个要点：

- **MLO 是否可用由固件说了算**：`MT792x_CHIP_CAP_MLO_EVT_EN` 来自 `mt7925_mcu_get_nic_capability()`。没有这一位就**静默 return 0**（不会打印任何错误），此时 `WIPHY_FLAG_SUPPORTS_MLO` 不开——"iw 里看不到 MLD"的根因常常在固件/NIC capability，而不是 mac80211，而且因为没有报错，只能通过 `iw phy` 看不到 MLO 能力来发现。
- **能力挂在 `wiphy->iftype_ext_capab` 上**（STA + OPMODE_NOTIF 扩展能力位），不是全局 `hw->wiphy->eml_capabilities`。
- **`phy->eml_cap` 也来自固件**（NIC capability），驱动只是转手填进 `wiphy_iftype_ext_capab.eml_capabilities`。EMLSR/EMLMR 的最终行为在 mac80211 与固件的协作里。

---

## 七、初始化超时 / 失败排查表

| 现象 | 落点 | 说明 |
| --- | --- | --- |
| `hardware init failed` | `mt7925_init_work()` 的 `mt7925_init_hardware()` | 10 次 `mt792x_mcu_init()` 全失败；先看固件文件是否加载成功 |
| `Timeout for initializing firmware` | `mt792x_load_firmware()` | 见第 3 篇；`MT_TOP_MISC2_FW_N9_RDY` 未置位 |
| `WTBL update timeout` | `mt7925_mac_wtbl_update()` | WTBL 操作未完成，常见于复位/PM 打断时序 |
| `iw phy` 里没有 MLD/MLO 能力 | `mt7925_init_mlo_caps()` | `chip_cap` 缺 `MT792x_CHIP_CAP_MLO_EVT_EN`：静默跳过，**没有任何报错**，只能靠 `iw phy` 反推 |
| 6GHz 无信道 | `mt7925_mac_init()` + CLC | `alpha2` 未下发（缺省全 0）、监管域/CLC 限制 |
| 注册成功但立刻掉线 | `mt7925_init_work()` 尾部 | `mt792x_mcu_drv_pmctrl()` + `mt792x_pm_power_save_sched()` 之后立刻进入省电，见第 7 篇 |

---

## 八、小结

1. `mt7925_register_device()` 只负责**软资源 + 排队**，硬件初始化全在异步 `init_work` 里，避免 probe 阻塞。
2. 初始化顺序有硬约束：**固件 → MAC/WTBL → HE/EHT/MLO 能力 → `mt76_register_device()`**，能力必须在上报前填完。
3. MAC 初始化三件套：DCR（最大 RX 长度 + 硬件 de-AMSDU）、WTBL 全清（20 表项）、定点速率表；WTBL 是理解 MT7925 MAC 的关键。
4. 寄存器访问分三条路径（mmio / MCU 代理 / 固件上报），**不能混用也不能互相比对结果**。
