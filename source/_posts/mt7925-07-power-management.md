---
title: MT7925 驱动学习 07：电源管理（runtime PM、深度睡眠、系统休眠与 WoWLAN）
date: 2026-09-13 17:00:00
tags:
  - MT7925
  - 电源管理
  - WoWLAN
categories:
  - 无线网络
  - WiFi
---

## 文档概述

MT7925 的电管理分三个层次：**mac80211 的 PS（省电模式）**、**mt76 的 runtime PM（含 deep sleep）**、**系统 suspend/resume + WoWLAN**。这三层容易互相混淆，尤其"掉线"和"唤醒失败"类问题往往出在第二、三层的交界处。本文逐层拆开。

---

## 一、三层电源管理

| 层 | 触发者 | 驱动侧主体 | 芯片侧效果 |
| --- | --- | --- | --- |
| PS（IEEE PS / U-APSD） | mac80211（`BSS_CHANGED_PS`） | `mt7925_vif_cfg_changed` → MCU `BSS_INFO_UPDATE` 的 PS 相关 TLV | STA 在 DTIM 周期收 beacon、缓冲下行，硬件周期性进入唤醒窗口 |
| runtime PM / deep sleep | mt76（空闲超时自动触发） | `mt76_connac_pm`（`mt792x_pm_*`）+ `hif_ops.drv_own/fw_own` | 交出总线控制权给固件、关时钟，芯片进入低功耗 |
| 系统 suspend / WoWLAN | 内核 PM | `mt7925_suspend` / `mt7925_resume` / `mt792x_set_wakeup` | MCU 挂起（`HIF_CTRL`/`SUSPEND`）、总线进 L1，靠 WoW 模式唤醒主机 |

一句话区分：**PS 是"我在省电"，runtime PM 是"我睡着了但还可以被叫醒"，suspend 是"整机睡了，只能靠 WoWLAN 叫醒"。**

---

## 二、runtime PM 的数据结构

`struct mt792x_dev` 里内嵌一份连接层公共 PM 状态：

```c
struct mt792x_dev {
	...
	struct mt76_connac_pm pm;
	...
};
```

关键字段与默认值（`mt7925_register_device()` 里设定）：

```c
	mutex_init(&dev->pm.mutex);
	init_waitqueue_head(&dev->pm.wait);

	dev->pm.idle_timeout = MT792x_PM_TIMEOUT;                    /* HZ / 12 ≈ 83ms */
	dev->pm.ds_enable = mt76_is_mmio(&dev->mt76) && !dev->disable_runtime_pm;
	dev->pm.enable = !dev->disable_runtime_pm;
```

| 字段 | 含义 |
| --- | --- |
| `enable` | runtime PM 总开关（`disable_runtime_pm` 模块参数为真时关闭） |
| `ds_enable` | 是否允许 **deep sleep**（深度睡眠）；`mt76_is_mmio()` 为真（PCIe）才开，USB 不支持 |
| `idle_timeout` | 空闲多久进入省电，默认 `HZ/12`（≈83ms，相当激进） |
| `mutex` / `wait` | 保护状态切换与等待 MCU 就绪 |

默认值是"省电优先"的激进配置——这也是为什么有人抱怨"刚连上就觉得顿"：83ms 空闲就尝试进省电，唤醒需要额外来回。

---

## 三、控制权握手：`drv_own` / `fw_own`

MT7925 的省电本质是**总线（寄存器）访问权的归属切换**：

```plaintext
        驱动持有总线                      固件持有总线
   ┌────────────────────┐          ┌────────────────────┐
   │  DRV_OWN 返回 1     │  ──交出──▶│  可以关时钟/深睡    │
   │  驱动可读写寄存器    │  ◀──取回──│  固件跑射频/协议    │
   └────────────────────┘          └────────────────────┘
            ▲                                 ▲
      mt792xe_mcu_drv_pmctrl()          mt792xe_mcu_fw_pmctrl()
      （hif_ops.drv_own）                （hif_ops.fw_own）
```

两个方向的入口（PCIe 版实现在 `pci_mcu.c`）：

```c
static const struct mt792x_hif_ops mt7925_pcie_ops = {
	.init_reset = mt7925e_init_reset,
	.reset = mt7925e_mac_reset,
	.mcu_init = mt7925e_mcu_init,
	.drv_own = mt792xe_mcu_drv_pmctrl,   /* 驱动取回控制权 */
	.fw_own = mt792xe_mcu_fw_pmctrl,     /* 把控制权交给固件 */
};
```

`mt7925e_mcu_init()` 里就用了这两个函数完成"固件侧先放手 → 驱动侧接管"，并且在接管后禁用 PCIe L0S：

```c
	err = mt792xe_mcu_fw_pmctrl(dev);
	if (err)
		return err;

	err = __mt792xe_mcu_drv_pmctrl(dev);
	if (err)
		return err;

	mt76_rmw_field(dev, MT_PCIE_MAC_PM, MT_PCIE_MAC_PM_L0S_DIS, 1);
```

**为什么要禁 L0S**：L0S 是 PCIe 的快速低功耗链路状态，进入/退出由链路层自动协商，MT7925 在高频访问寄存器时容易被 L0S 的退出延迟打断（表现为 MCU 命令超时）。平台 ASPM 支持情况由 `mt76_pci_aspm_supported()` 记录到 `dev->aspm_supported`，必要时用模块参数兜底：

```bash
modprobe mt7925e disable_aspm=1     # 关掉 PCI ASPM（排查链路/超时问题的经典开关）
```

---

## 四、省电流程：进入与退出

```plaintext
空闲（83ms 无活动）→ mt792x_pm_power_save_sched() 排入延迟工作
        ▼
mt792x_pm_power_save_work()
    ├─ 检查是否真的空闲（last_activity、是否在扫描/ROC/关联中）
    ├─ 置 MT76_STATE_PM，停 TX worker
    ├─ mt7925_mcu_set_deep_sleep(dev, true)      ← 仅在 ds_enable 且 PCIe 时
    └─ hif_ops.fw_own()                          交出总线给固件
        ▼
有包要发 / 上层要求唤醒 → mt792x_pm_wake_work()
    ├─ hif_ops.drv_own()                         取回总线
    ├─ mt7925_mcu_set_deep_sleep(dev, false)
    ├─ 恢复寄存器/队列（必要时 mt792x_reset）
    └─ clear MT76_STATE_PM，重启 TX worker
```

进入/退出过程中涉及的 MCU 命令：

| 命令 | 用途 |
| --- | --- |
| `MCU_UNI_CMD(HIF_CTRL)` | 总线/接口层挂起、恢复协作 |
| `MCU_UNI_CMD(SUSPEND)` | 系统 suspend 时的固件挂起（与 WoWLAN 配套） |
| `MCU_UNI_CMD(BSS_INFO_UPDATE)`（PS TLV） | mac80211 层面的省电模式 |

几个容易踩的细节：

- **monitor / 扫描 / ROC 期间不允许深睡**（否则射频停摆会丢帧），代码里靠状态位拦截。
- **USB 没有深睡**：`ds_enable` 在 `mt76_is_mmio()` 为假时直接为 false，相关命令会返回 `-EOPNOTSUPP`。
- **深睡与复位的关系**：唤醒路径上如果发现固件状态异常，会走 `mt792x_reset()`；所以"唤醒后掉线"往往是"唤醒时序 + 复位"共同的结果。

---

## 五、系统 suspend/resume 与 WoWLAN

### 5.1 回调与能力

```c
#ifdef CONFIG_PM
	.suspend = mt7925_suspend,
	.resume = mt7925_resume,
	.set_wakeup = mt792x_set_wakeup,
	.set_rekey_data = mt7925_set_rekey_data,
#endif /* CONFIG_PM */
```

WoWLAN 的能力在固件加载成功后就挂上（`mt792x_load_firmware()`）：

```c
#ifdef CONFIG_PM
	dev->mt76.hw->wiphy->wowlan = &mt76_connac_wowlan_support;
#endif
```

`mt76_connac_wowlan_support`（连接层公共定义）声明了支持的唤醒源——**能不能用 WoWLAN，先看这里声明了哪些 pattern**。典型的支持项包括：任意/特定 magic pattern、802.11 帧过滤、IPv4/IPv6 报文匹配（NS offload）等。

### 5.2 suspend 时发生什么

```plaintext
内核 suspend
  → mt7925_suspend()
       ├─ release 掉 runtime PM（不能嵌套，先唤醒或标记）
       ├─ 把连接信息（BSS/STA/密钥）交给固件，让固件"独立值守"
       ├─ 配置 WoW：wowlan 配置 → MCU WoW 命令（pattern/enable）
       ├─ mt76_connac_mcu_set_hif_suspend(dev, true)   ← 通知固件总线要挂
       └─ 让总线进入低功耗（L1 / 时钟门控）
resume
  → mt7925_resume()
       ├─ 恢复总线 / HIF
       ├─ 重新握手 drv_own
       ├─ 校验固件是否还在（否则 mt792x_reset 重建）
       └─ 按需重新下发密钥、BA、PS 配置
```

### 5.3 IPv6 NS offload

`struct mt792x_dev` 里专门放了两个字段：

```c
	struct work_struct ipv6_ns_work;
	struct sk_buff_head ipv6_ns_list;
```

配合 `ops->ipv6_addr_change = mt7925_ipv6_addr_change` 与 `mt7925_set_ipv6_ns_work()`（IPv6 编译进内核时才有）：主机休眠时由固件替主机应答邻居请求（NS），避免休眠期间 ARP/ND 到期导致断连。**列在 `ipv6_ns_list` 上的 skb 由这个 work 单独发送**，别和普通发包路径混起来看。

### 5.4 唤醒后的常见异常

| 现象 | 可能原因 | 排查 |
| --- | --- | --- |
| 唤醒后不能上网，也不掉线 | 只恢复了总线，没有重新下发密钥/BA | 看 resume 后有没有 `STA_REC_UPDATE`/密钥命令；试 `iw dev wlan0 link` |
| 唤醒后 phy 消失（需要重新 `modprobe`） | 固件挂了 → 复位失败 | dmesg 找 `Message ... timeout` / coredump 日志 |
| 唤醒立刻又进省电，反应迟钝 | `idle_timeout = HZ/12` 太激进 | debugfs 调 `idle-timeout`，或 `disable_runtime_pm=1` |
| 平台 suspend 卡在 wifi 上 | HIF suspend 没完成 | 关注 `MCU_UNI_CMD(HIF_CTRL)` 是否超时 |
| WoWLAN 完全不生效 | `wiphy->wowlan` 未挂（固件没加载成功）/ 配置的唤醒源不支持 | `iw phy \| grep -A20 WoWLAN`，对比 `mt76_connac_wowlan_support` |

---

## 六、调试开关速查

```bash
# 1) 关掉 runtime PM（最省事的定位手段，先确认问题是否与省电相关）
modprobe -r mt7925e; modprobe mt7925e disable_runtime_pm=1

# 2) 关 ASPM（PCIe 链路/超时类问题）
modprobe mt7925e disable_aspm=1

# 3) debugfs：runtime-pm / deep-sleep 实时开关（mt792x 公共项）
ls /sys/kernel/debug/ieee80211/phy0/mt76/
#   runtime-pm   : 写 0 关 / 写 1 开 runtime PM
#   deep-sleep   : 写 0 关 / 写 1 开深睡（USB 上无效）
#   idle-timeout : 空闲超时（毫秒）

# 4) 观察省电状态切换
dmesg -w | grep -i -E "mt7925|pm|deep"

# 5) 确认 WoWLAN 支持项
iw phy | sed -n '/WoWLAN/,/^$/p'
```

> 注意：debugfs 写 `deep-sleep`/`runtime-pm` 会影响正在工作的连接（可能触发一次复位），联调时建议先断开业务流量。

---

## 七、小结

1. **三层要分清**：mac80211 的 PS（软件省电模式）、mt76 的 runtime PM + deep sleep（总线控制权交给固件）、系统 suspend + WoWLAN（固件独立值守）。
2. **省电的本质是控制权切换**：`hif_ops.drv_own/fw_own` + `MT_PCIE_MAC_PM_L0S_DIS`；出问题先怀疑这套握手（`disable_aspm` 是最常用的对照组）。
3. **default 是省电优先**：`idle_timeout = HZ/12`、`ds_enable = mt76_is_mmio() && !disable_runtime_pm`；USB 无深睡，相关命令返回 `-EOPNOTSUPP`。
4. **WoWLAN 能力由固件/公共层决定**：`wiphy->wowlan = &mt76_connac_wowlan_support`，suspend/resume 走 `HIF_CTRL`/`SUSPEND` 命令，IPv6 NS offload 由 `ipv6_ns_work` 单独处理。
5. 定位电源类问题的最快路径：`disable_runtime_pm=1` → `disable_aspm=1` → debugfs 调 `idle-timeout`，三步基本能分清是省电时序、链路还是固件问题。
