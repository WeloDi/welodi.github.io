---
title: MT7925 驱动学习 08：调试与问题定位（debugfs、固件日志、coredump、故障树）
date: 2026-09-13 16:00:00
tags:
  - MT7925
  - 调试
  - debugfs
categories:
  - 无线网络
  - WiFi
---

## 文档概述

前面七篇讲了结构，这篇讲**怎么查**。MT7925 的可观测性分四类：内核日志（dmesg）、debugfs、固件自身（日志 + coredump）、以及系统层（iw/ethtool/ftrace）。本文给出每类工具的入口、读法和一套按现象分诊的故障树。

---

## 一、先确认环境

```bash
# 模块与依赖（mt7925e 依赖 mt7925-common / mt792x-lib / mt76）
lsmod | grep -E "mt7925|mt792x|mt76"
modinfo mt7925e | head -20        # 可看到 MODULE_FIRMWARE 列表
modinfo mt76 | grep -i parm       # 模块参数（disable_runtime_pm 等在 mt76 层）

# 固件是否存在（注意 mt7925 子目录）
ls -l /lib/firmware/mediatek/mt7925/
#   WIFI_MT7925_PATCH_MCU_1_1_hdr.bin
#   WIFI_RAM_CODE_MT7925_1_1.bin

# 设备是否被识别
lspci -nnk | grep -A3 -i mediatek      # PCIe：14c3:7925 / 14c3:0717
lsusb | grep -i mediatek               # USB：0e8d:7925

# 注册结果
iw dev
iw phy | head -40
```

---

## 二、内核日志（dmesg）：按关键字定位到源码行

MT7925 的日志关键字基本可以直接映射到前几篇讲过的函数：

| dmesg 关键字 | 源码位置 | 含义 / 下一步 |
| --- | --- | --- |
| `ASIC revision: %04x` | `pci.c` / `usb.c` probe | 芯片版本。读到 `0000` 说明总线访问失败（链路/供电/ASPM） |
| `direct firmware load for mediatek/mt7925/... failed` | `request_firmware()` | 固件缺失或路径不对 |
| `Timeout for initializing firmware` | `mt792x_load_firmware()` | `MT_TOP_MISC2_FW_N9_RDY` 未置位，patch/RAM 下载后固件没起 |
| `hardware init failed` | `mt7925_init_hardware()` 重试 10 次后 | 固件下载/MCU 初始化反复失败 |
| `WTBL update timeout` | `mt7925_mac_wtbl_update()` | WTBL 操作 500ms 未完成（复位/PM 打断时序） |
| `Message %08x (seq %d) timeout` | `mt7925_mcu_parse_response()` | **一次 MCU 超时 = 随后触发 `mt792x_reset()`**，看它前面最后一条命令的 cid |
| `MT_TXFREE1_VER` 相关 WARN | `mt7925_mac_tx_free()` | 固件与驱动的 TX_FREE 格式不匹配（版本不配套） |
| `tx blocked` / 长时间无 TX | `mt76_token_*` + `MT76_TX_BLOCKED` | token 耗尽，见第 6 篇 |
| `Firmware coredump` / `devcd` | `mt76_connac_mcu_coredump_event()` | 固件崩溃，抓 `/sys/class/devcoredump/` |

打开更细的日志：

```bash
# dynamic debug：打印驱动的 dev_dbg（含 MCU 消息收发等）
echo 'module mt7925e +p; module mt7925-common +p; module mt792x-lib +p; module mt76 +p' \
  > /sys/kernel/debug/dynamic_debug/control

# 或者启动参数
#   loglevel=8 dyndbg="module mt7925e +p"
dmesg -w
```

---

## 三、debugfs：驱动暴露的运行时窗口

```bash
ls -l /sys/kernel/debug/ieee80211/phy0/mt76/
```

条目由 `mt7925/debugfs.c` 与 `mt792x_debugfs.c`（公共项）共同创建，**名字以实际 `ls` 结果为准**，常用的几类：

| 条目 | 归属 | 读/写 | 用途 |
| --- | --- | --- | --- |
| `regval` | mt7925 | 读 | 经 **MCU 代理**读寄存器（`mt7925_mcu_regval()`），只能在固件允许的地址范围内用 |
| `fw_debug` | mt7925 | 写 | 打开/关闭固件日志上报（`mt7925_mcu_fw_log_2_host(dev, 1/0)`），看 MCU 内部在做什么 |
| `chip_reset` | mt792x/mt7925 | 写 | 触发软件复位，用来复现"复位路径"相关的问题（如复位后能否恢复） |
| `runtime-pm` / `deep-sleep` | mt792x | 写 | 运行时开关省电与深睡（USB 上深睡无效），见第 7 篇 |
| `idle-timeout` | mt792x | 写 | 空闲超时（毫秒），调大更"不容易睡着" |
| `xmit-...` / 队列相关 | mt76 | 写 | 触发队列 dump，看 DMA ring 与 skb 占用 |
| stations 相关 | mt792x | 读 | 每 STA 的速率、airtime、ACK 信号（`sta_statistics` 的数据源） |

典型用法：

```bash
D=/sys/kernel/debug/ieee80211/phy0/mt76
cat  $D/regval            # 读寄存器（十六进制）
echo 1 > $D/fw_debug      # 打开固件日志
echo 0 > $D/runtime-pm    # 先关省电，排除 PM 干扰（联调第一步）
echo 1 > $D/chip_reset    # 手动触发一次复位，验证恢复路径
```

**两条铁律**：

1. `regval` 走 MCU 而不是 mmio，**和驱动内部的 `mt76_rr()` 结果不一定一致**，不要互相"对答案"。
2. debugfs 里的**写操作几乎都会影响在线连接**（尤其 `chip_reset`），别在有业务流量时做。

---

## 四、固件日志与 coredump

### 4.1 固件日志

```bash
echo 1 > /sys/kernel/debug/ieee80211/phy0/mt76/fw_debug
dmesg -w | grep -i mt7925
```

固件日志通过 `MCU_UNI_EVENT_FW_LOG_2_HOST` 事件上报，由 `mt7925_mcu_uni_debug_msg_event()` 解析后打印。它的价值在于：**关联失败、扫描异常、速率不升这类"驱动看起来没错"的问题，答案常常在固件侧**。

### 4.2 coredump

固件崩溃时会发生一条链式的处理：

```plaintext
固件异常
  → MCU_UNI_EVENT_COREDUMP 事件
       ├─ dev->fw_assert = true
       └─ mt76_connac_mcu_coredump_event(&dev->mt76, skb, &dev->coredump)
            → 挂到 dev->coredump（连接层公共结构）
                 → dump_work = mt7925_coredump_work()
                      → dev_coredumpm() → /sys/class/devcoredump/devcdN/data
```

取证方法：

```bash
# 崩溃后（或主动触发一次复位复现）
ls /sys/class/devcoredump/
cat /sys/class/devcoredump/devcd0/data > mtwifi-coredump.bin
echo 1 > /sys/class/devcoredump/devcd0/data   # dump 完必须写一次，释放资源
```

注意 `dev->fw_assert` 置位后驱动会走异常处理路径（复位重建），所以**看到 coredump 就说明问题在固件侧**，下一步是拿这份 dump 给原厂或对照固件版本。

---

## 五、系统层工具

```bash
# 能力与监管域（MLO 是否生效、6GHz 是否可用）
iw phy | grep -E "Band|Supported Channel|valid interface|MLD|EML|WoWLAN"

# 链路质量
iw dev wlan0 link
iw dev wlan0 station dump          # 速率、重传、信号、airtime

# 统计（mt792x_get_et_stats 的数据）
ethtool -S wlan0

# tracepoint（mt76 自定义事件）
grep -i mt76 /sys/kernel/debug/tracing/available_events
#  然后按需打开：echo 1 > .../events/mt76/xxx/enable && cat .../trace_pipe
```

`iw` 能直接反映很多"能力位没填"的问题：

- `iw phy` 里**没有** MLO/MLD 相关项 → 回到第 4 篇 `mt7925_init_mlo_caps()` + `chip_cap`（静默跳过，不报错）。
- **没有 6GHz Band** → EEPROM/监管域/CLC 问题（`alpha2`、CLC region）。
- **没有 WoWLAN 段落** → 固件没加载成功（`wiphy->wowlan` 未挂）。
- 支持的接口类型缺失（如 `monitor`）→ 与 `mt7925_add_interface()` 的判断和固件能力有关。

抓包定位（前提是能起 monitor 接口）：

```bash
iw phy phy0 info | grep -A2 "Supported interface modes"
ip link set wlan0 down
iw dev wlan0 set monitor control
ip link set wlan0 up
tcpdump -i wlan0 -e -y IEEE802_11_RADIO
```

驱动侧对应的是 MCU 的 `SNIFFER` 命令族（`MCU_UNI_CMD(SNIFFER)`），需要固件配合。

---

## 六、故障树：按现象分诊

### 6.1 完全看不到设备 / probe 失败

```plaintext
lspci/lsusb 有设备？
  ├─ 否 → 平台/供电/BIOS（PCIe 端口没起来、USB 端口无电）
  └─ 是 → dmesg 看 mt7925e 的 probe 日志
        ├─ 没有 ASIC revision 打印 → 寄存器访问失败（PCIe 链路/ASPM；试 disable_aspm=1）
        ├─ ASIC revision: 0000 → 同上，或设备已被其它驱动/固件占用
        └─ 固件加载报错 → 检查 /lib/firmware/mediatek/mt7925/ 两份文件
```

### 6.2 起来了但完全连不上

```plaintext
iw dev 有接口？ → 没有：mt7925_add_interface / add_chanctx 失败（看 dmesg）
有接口但 scan 无结果？
  ├─ 6GHz 无结果 → 监管域/CLC（iw phy 看 band、iw reg get）
  ├─ 完全无结果 → MCU SCAN 命令超时（"Message ... timeout"）→ 通常伴随复位循环
  └─ 有结果但关联失败
        ├─ 认证/关联帧在错误信道 → ROC 相关（mgd_prepare_tx / remain_on_channel）
        └─ 关联被拒/超时 → 打开 fw_debug 看固件侧原因（密钥、速率、EDCA 配置）
```

### 6.3 连上了但传不动

```plaintext
ping 不通 / 吞吐极低
  ├─ 是否 tx blocked（token 耗尽）→ 看 TX_FREE 是否到达、队列是否卡住（第 6 篇）
  ├─ 是否刚连上就进省电 → 关 runtime-pm / 调 idle-timeout（第 7 篇）
  ├─ 是否只有一条链路有流量（MLO）→ TXWI 的 omac/band 用了默认链路
  └─ 速率不升（一直 1Mbps）→ TXS/TXS 统计是否正常、BA 是否建立（ampdu_action）
```

### 6.4 用着用着断了

```plaintext
dmesg 时间线（按顺序读！）
  ├─ 先出现 "Message %08x (seq %d) timeout"
  │    → 某条 MCU 命令超时（记下 cid，对照第 5 篇的命令族）
  │    → 随后必然出现 mt792x_reset() 相关日志
  ├─ 出现 coredump 相关日志
  │    → 固件崩溃（抓 /sys/class/devcoredump）
  ├─ 出现 WTBL update timeout
  │    → 复位/PM 与 WTBL 操作冲突（并发时序）
  └─ 什么都不打，只是静默断
       → 打开 fw_debug，并检查是否睡眠/唤醒路径（第 7 篇）
```

### 6.5 休眠唤醒后异常

按第 7 篇的分层排查：先 `disable_runtime_pm=1` 区分"是省电还是 suspend"；再看 resume 后是否重新下发密钥/PS 配置；最后确认固件是否还在（是否需要复位重建）。

### 6.6 MLO 相关

| 现象 | 检查点 |
| --- | --- |
| `iw phy` 无 MLO/EML 能力 | `chip_cap & MT792x_CHIP_CAP_MLO_EVT_EN`（第 4 篇，静默跳过） |
| 能建 MLD 但只有一条链路有流量 | `change_sta_links` / `change_vif_links` 里链路对象与 WTBL 是否正确创建 |
| MLD 关联失败 | `STA_REC_MLD` / `STA_REC_EHT_MLD` TLV 是否下发；ROC（多链路驻留）是否成功 |
| 唤醒后 MLD 降级为单链路 | 唤醒路径未恢复全部链路配置 |

---

## 七、调试三步法

1. **先排除电源干扰**：`disable_runtime_pm=1`、必要时 `disable_aspm=1`。省电时序是这类设备最常见的"假故障"来源。
2. **按时间线读 dmesg**：`Timeout for initializing firmware`（固件没起）→ `Message ... timeout` + `mt792x_reset`（命令超时 + 复位）→ coredump（固件崩）。**日志的顺序比内容更重要**。
3. **区分"驱动错"和"固件错"**：`iw phy` 能力项 + `fw_debug` 日志 + coredump，三者能把绝大多数问题定位到具体一层。

---

## 八、小结

| 工具 | 解决什么问题 |
| --- | --- |
| dmesg（+ dynamic debug） | 初始化失败、MCU 超时、复位、WTBL 超时 |
| debugfs（`regval`/`fw_debug`/`chip_reset`/`runtime-pm`/`idle-timeout`） | 运行时寄存器、固件日志、省电开关、复位复现 |
| coredump（`/sys/class/devcoredump/`） | 固件崩溃取证 |
| iw / ethtool | 能力（MLO、6GHz、WoWLAN）、链路质量、统计 |
| tracepoint | 时序问题（发包/收包/队列） |

MT7925 这类"驱动薄、固件厚"的设备，定位思路可以概括成一句话：**先用 `iw phy` 看固件上报了什么能力，再用 `dmesg` 看哪条命令/哪个位没到位，最后用 `fw_debug` 和 coredump 把问题交回固件侧。**
