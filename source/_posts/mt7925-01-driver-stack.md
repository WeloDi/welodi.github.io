---
title: MT7925 驱动学习 01：硬件架构与 Linux 6.12 驱动栈分层
date: 2026-09-13 23:00:00
tags:
  - MT7925
  - WiFi 7
  - mt76
categories:
  - 无线网络
  - WiFi
---

## 文档概述

本文梳理 Linux 6.12 中 MediaTek MT7925（Wi-Fi 7 / 802.11be）网卡驱动的硬件接口与源码分层。驱动路径 `drivers/net/wireless/mediatek/mt76/mt7925/`，向上挂 mac80211/cfg80211，向下经 PCIe 或 USB 访问芯片，协议栈的关键逻辑跑在片内 MCU 的固件里。


---

## 一、芯片与主机接口

MT7925 是一颗 tri-band（2.4 / 5 / 6GHz）Wi-Fi 7 芯片，驱动里通过三个 `cap` 位判断当前硬件到底暴露了哪些频段：

```c
if (phy->mt76->cap.has_2ghz)   /* 2.4G */
if (phy->mt76->cap.has_5ghz)   /* 5G   */
if (phy->mt76->cap.has_6ghz)   /* 6G   */
```

宿主接口有两种，对应两个模块、两张设备表：

| 模块 | 文件 | 总线 | 匹配方式 | 固件名传入方式 |
| --- | --- | --- | --- | --- |
| MT7925E | `mt7925/pci.c` | PCIe | `PCI_DEVICE(0x14c3, 0x7925)`、`PCI_DEVICE(0x14c3, 0x0717)` | `.driver_data = MT7925_FIRMWARE_WM` |
| MT7925U | `mt7925/usb.c` | USB | `USB_DEVICE_AND_INTERFACE_INFO(0x0e8d, 0x7925, 0xff, 0xff, 0xff)` | `.driver_info = MT7925_FIRMWARE_WM` |

```c
static const struct pci_device_id mt7925_pci_device_table[] = {
	{ PCI_DEVICE(PCI_VENDOR_ID_MEDIATEK, 0x7925), .driver_data = (kernel_ulong_t)MT7925_FIRMWARE_WM },
	{ PCI_DEVICE(PCI_VENDOR_ID_MEDIATEK, 0x0717), .driver_data = (kernel_ulong_t)MT7925_FIRMWARE_WM },
	{ },
};
```

注意 `driver_data` 里存的不是枚举值，而是**固件文件名字符串**——`mt792x_get_mac80211_ops()` 拿它去判别芯片能力（例如 `has_eht`、`chip_cap`），再把 features 回填到 `dev->fw_features`。同一份芯片不同封装（0x7925 / 0x0717）共用同一套能力描述。

片内数据通路（简化）：

```plaintext
Host
 ├── PCIe (MT7925E) ──┐
 └── USB  (MT7925U) ──┴─▶ WFDMA
                          ├─ PLE / PSE            (发包、回收缓冲)
                          ├─ LMAC BN0 / BN1      (TMAC/RMAC/WTBL/MIB，每个 band 一套)
                          ├─ WF_MCU + SYSRAM     ★ 固件跑在这里
                          └─ PHY / RF
```

驱动真正做的事情，可以概括成两句话：**把 mac80211 下发的帧塞进 WFDMA 的 TX ring（并构造 TXWI 告诉硬件怎么发），把 WFDMA RX ring 里的 skb 解析成 `mt76_rx_status` 交回 mac80211**。频段、速率、功率、扫描、省电等逻辑全部由 MCU 固件承担，驱动通过 MCU 命令（`MCU_UNI_CMD(...)`）下发配置。

---

## 二、源码分层：mt7925 / mt792x / mt76 core / mac80211

MT7925 驱动不是一个独立目录，而是 mt76 家族的"芯片差异层"：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 芯片层 | `mt76/mt7925/*` | MT7925 专属的寄存器映射、TXWI 构造、RX 解析、固件命令 TLV、MLO 逻辑 |
| 芯片族共享层 | `mt76/mt792x*.c` | MT7920/7921/7922/7925 共用的设备结构、DMA、MAC 帮助函数、USB、debugfs、trace |
| 通用层 | `mt76/*.c`、`mt76_connac*.c` | 队列/DMA 框架、MCU 收发框架、connac 系列通用命令与 WTBL 操作 |
| 无线栈 | `mac80211` / `cfg80211` | 认证关联状态机、扫描框架、密钥、BA、MLO 的链路模型 |

### 2.0 三个内核模块的分工

先看编译产物，结构一目了然（`mt7925/Makefile`）：

```make
obj-$(CONFIG_MT7925_COMMON) += mt7925-common.o    # 芯片核心：mac/mcu/main/init/debugfs
obj-$(CONFIG_MT7925E)       += mt7925e.o          # PCIe：pci/pci_mac/pci_mcu
obj-$(CONFIG_MT7925U)       += mt7925u.o          # USB：usb

mt7925-common-y := mac.o mcu.o main.o init.o debugfs.o
mt7925e-y       := pci.o pci_mac.o pci_mcu.o
mt7925u-y       := usb.o
```

也就是说 `mt7925-common` 与总线无关，`mt7925e`/`mt7925u` 是薄薄的总线适配层。跑起来会看到 `mt7925e` 依赖 `mt7925-common`、`mt792x-lib`、`mt76`。

### 2.1 `mt7925/` 目录（v6.12 共 15 个文件）

| 文件 | 内容 |
| --- | --- |
| `Kconfig` / `Makefile` | `MT7925E`、`MT7925U` 两个配置项与目标文件列表 |
| `mt7925.h` | 队列枚举、ring 尺寸、EEPROM 字段、CLDC/txpwr 结构、对外函数声明 |
| `regs.h` | MT7925 寄存器与 RXD/TXD 位域定义 |
| `pci.c` | PCIe probe/remove、寄存器 L1/L2 重映射、`mt7925e_*` 总线实现 |
| `pci_mac.c` | PCIe 侧 TX 完成、TXWI 写入（`mt7925e_tx_prepare_skb` 等） |
| `pci_mcu.c` | PCIe 侧 MCU ops、`mt7925e_mcu_init()`、PM 控制 |
| `usb.c` | USB probe、`mt7925u_*`、USB bus ops |
| `main.c` | `ieee80211_ops mt7925_ops`、STA/链路/信道上下文回调、扫描、HE/EHT/MLO 能力 |
| `init.c` | `mt7925_register_device()`、`mt7925_init_work()`、`mt7925_mac_init()`、hwmon 温度 |
| `mcu.c` / `mcu.h` | MCU 消息构造与解析、各类 UNI 命令 TLV、主动事件分发 |
| `mac.c` / `mac.h` | RX 分流与 RXD 解析、TXWI 构造、TXS/TX_FREE、WTBL、定点速率表、coredump |
| `debugfs.c` | debugfs 条目：`regval`、`fw_debug`、`runtime-pm`、`chip_reset`… |

### 2.2 芯片族共享层与通用层

| 文件 | 内容 |
| --- | --- |
| `mt792x.h` | **`struct mt792x_dev/phy/vif/sta/link_sta/bss_conf`**、固件名宏、`mt792x_ram_name()` |
| `mt792x_core.c` | `mt792x_load_firmware()`、ACPI SAR、PM work、复位、stats |
| `mt792x_dma.c` | WFDMA 启停、ring 配置、pending 计数 |
| `mt792x_mac.c` | 通用 MAC 帮助：band 初始化、RSSI/airtime、MCA |
| `mt792x_usb.c` | USB 公共实现（`mt76u` 的 mt792x 封装） |
| `mt792x_debugfs.c` / `mt792x_trace.[ch]` | debugfs 公共项与 tracepoint |
| `mt792x_acpi_sar.[ch]` | 从 ACPI 读 SAR 功率表 |
| `mt76_connac_mcu.c` | `mt76_connac2_load_patch/load_ram`、UNI 命令公共实现 |
| `mt76_connac3_mac.c` | connac3（Wi-Fi 7 一代）MAC 公共实现 |
| `mt76_connac_mac.c` | WTBL/BA/速率续传等公共操作 |

一句话记忆：**`mt7925` 只写"不一样的地方"，其余全部继承 `mt792x` 与 `mt76_connac`。**

---

## 三、核心数据结构（MLO 是重点）

mt792x 层用同一套结构描述"单链路"和"多链路"（MLO）两种形态。vif/sta 里都内置一个默认链路（`bss_conf` / `deflink`），其余链路按需动态分配：

```c
struct mt792x_dev {
	union {
		struct mt76_dev mt76;   /* must be first */
		struct mt76_phy mphy;
	};
	const struct mt76_bus_ops *bus_ops;   /* 被 mt7925 换成自己的 rr/wr/rmw */
	struct mt792x_phy phy;
	struct work_struct reset_work;
	bool hw_full_reset:1;
	bool hw_init_done:1;      /* 固件/寄存器初始化完成，允许 chip reset */
	bool fw_assert:1;         /* 收到 COREDUMP 事件 */
	bool has_eht:1;
	bool regd_in_progress:1;
	bool aspm_supported:1;
	wait_queue_head_t wait;
	struct work_struct init_work;
	u8 fw_debug;
	u8 fw_features;           /* 来自 driver_data 的能力标志 */
	struct mt76_connac_pm pm; /* runtime PM */
	struct mt76_connac_coredump coredump;
	const struct mt792x_hif_ops *hif_ops;  /* 总线差异：mcu_init/reset/drv_own/fw_own */
	const struct mt792x_irq_map *irq_map;  /* 中断位映射 */
	struct work_struct ipv6_ns_work;
	struct sk_buff_head ipv6_ns_list;
	enum environment_cap country_ie_env;
	u32 backup_l1;   /* 寄存器重映射前的 L1 值备份 */
	u32 backup_l2;
};
```

MLO 的链路模型：

```c
struct mt792x_bss_conf {                 /* 一条链路（link）的 BSS 配置 */
	struct mt76_vif mt76;            /* must be first：omac_idx/wmm_idx/band_idx */
	struct mt792x_vif *vif;
	struct ewma_rssi rssi;
	struct ieee80211_tx_queue_params queue_params[IEEE80211_NUM_ACS];
	unsigned int link_id;
};

struct mt792x_sta {
	struct mt792x_link_sta deflink;                 /* must be first */
	struct mt792x_link_sta __rcu *link[IEEE80211_MLD_MAX_NUM_LINKS];
	struct mt792x_vif *vif;
	u16 valid_links;
	u8 deflink_id;
};

struct mt792x_link_sta {
	struct mt76_wcid wcid;             /* must be first：硬件 WTBL 索引 + link_id */
	u32 airtime_ac[8];
	int ack_signal;
	struct ewma_avg_signal avg_ack_signal;
	unsigned long last_txs;
	struct mt76_connac_sta_key_conf bip;
	struct mt792x_sta *sta;
	struct ieee80211_link_sta *pri_link;
};

struct mt792x_vif {
	struct mt792x_bss_conf bss_conf;                     /* must be first */
	struct mt792x_bss_conf __rcu *link_conf[IEEE80211_MLD_MAX_NUM_LINKS];
	struct mt792x_sta sta;
	struct mt792x_sta *wep_sta;   /* STA 模式下兼作 WEP 用的 STA 记录 */
	struct mt792x_phy *phy;
	u16 valid_links;
	u8 deflink_id;
};
```

要点：

- **一切以 `wcid` 为锚点**：`struct mt792x_link_sta` 首成员是 `struct mt76_wcid`，因此 `wcid` 指针可以通过 `container_of()` 反查回链路对象（RX/TXS 路径大量使用这一技巧）。
- **`wcid.link_id` 承载 MLO 信息**：TXWI 构造时用 `wcid->link_id` 经 `mt792x_vif_to_link()` 拿到对应链路的 `mconf`，从而填对 `omac_idx`（OMAC）、`wmm_idx`（WMM 组）、`band_idx`（band）。
- **`deflink` / `bss_conf` 是内嵌的**：非 MLO 场景 `valid_links == BIT(0)`，只用内嵌这一份，零额外分配。

---

## 四、从 probe 到收包的调用层次

先看一张**框图**：模块构成 + 系统关系（驱动 ↔ PCIe ↔ 芯片）。

{% asset_img mt7925-architecture.svg "MT7925 驱动框图：模块构成与系统关系" %}

再看**生命周期流程图**：驱动的一生（加载启动 → 数据收发 → 关闭卸载）串在一起，本节末尾是它的文字版树状流程。

{% asset_img mt7925-lifecycle.svg "MT7925 驱动生命周期：加载启动 → 运行期数据收发 → 关闭卸载" %}

```plaintext
总线层
  mt7925_pci_probe()                 mt7925u_probe()
    ├─ mt792x_get_mac80211_ops()        （按 driver_data 取能力，拿到 ops 副本）
    ├─ mt76_alloc_device()              （分配 mt792x_dev，注册 mt76 设备）
    ├─ 覆写 bus_ops->rr/wr/rmw          （接入 MT7925 的寄存器重映射）
    ├─ mt7925_dma_init()                （TX/RX ring、NAPI）
    └─ mt7925_register_device()  ◀──────┐
                                        │ init.c
    ┌───────────────────────────────────┘
    ├─ 初始化 work/timer/锁/PM 默认值
    ├─ mt792x_init_wcid() / mt792x_init_wiphy()
    ├─ 补 HT / VHT 能力位
    └─ queue_work(init_work)

  mt7925_init_work()                        （异步，system_wq）
    ├─ mt7925_init_hardware()
    │    └─ mt792x_mcu_init() → mt76_eeprom_override() → mt7925_mcu_set_eeprom() → mt7925_mac_init()
    ├─ mt76_set_stream_caps()
    ├─ mt7925_set_stream_he_eht_caps()      （HE/EHT 能力 → wiphy）
    ├─ mt7925_init_mlo_caps()               （WIPHY_FLAG_SUPPORTS_MLO）
    ├─ mt76_register_device()               （向 mac80211 注册）
    └─ mt7925_init_debugfs() / mt7925_thermal_init()

运行期
  发包: mac80211 → mt792x_tx → tx_prepare_skb（写 TXWI）→ WFDMA TX ring
  收包: WFDMA RX ring → mt7925_rx_check / mt7925_queue_rx_skb
        ├─ PKT_TYPE_NORMAL  → mt7925_mac_fill_rx() → mt76_rx() → mac80211
        ├─ PKT_TYPE_RX_EVENT→ mt7925_mcu_rx_event()
        └─ PKT_TYPE_TXS/TRX_NOTIFY → TX 完成回收
  控制: mac80211 回调 → mt7925_mcu_*() → MCU UNI 命令（TX ring 15 / MCU 队列）
```

---

## 五、看这个驱动时的几个坑

1. **不要从 `mt7925/main.c` 找全部逻辑**：`mt7925_ops` 里大量回调直接指向 `mt792x_*`（如 `.tx = mt792x_tx`、`.stop = mt792x_stop`、`.flush = mt792x_flush`），芯片专属逻辑只占一部分。
2. **PCIe 与 USB 的 ops 是两套**：两者的 `mt76_driver_ops.rx_skb/rx_check` 共用 `mt7925_queue_rx_skb/mt7925_rx_check`，但 `tx_prepare_skb`、`hif_ops`、`bus_ops` 不同。
3. **能力位是"运行时协商"出来的**：`has_2ghz/has_5ghz/has_6ghz`、`has_eht`、`chip_cap` 由 EEPROM + NIC capability 命令决定，所以同一份驱动在不同板子上暴露的频段/能力可能不一样。
4. **6.12 的文件构成只能当快照**：mt7925 目录在 6.7~6.12 之间一直在加文件（MLO、sniffer、USB 支持等分批合入），换版本一定要重新列目录。

---

## 六、小结

- MT7925 驱动 = **`mt7925`（芯片差异，15 个文件）+ `mt792x`（7920/7921/7922/7925 共享）+ `mt76` core & `mt76_connac`（通用）**。
- 数据结构以 `mt792x_dev` 为根，`mt792x_vif/sta/bss_conf/link_sta` 用"内嵌默认链路 + 指针数组"同时表达单链路与 MLO。
- 芯片的频段、速率、功率、扫描、省电都靠 MCU 固件，驱动扮演"寄存器搬运 + 帧格式转换"的角色。
