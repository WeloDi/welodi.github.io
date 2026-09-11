---
title: DRM显示驱动框架
date: 2026-09-11 10:00:00
tags:
  - DRM
  - 显示驱动
  - Linux内核
---

## 文档概述

本文梳理 Linux 内核 **DRM（Direct Rendering Manager）** 显示驱动子系统的整体框架：从对象模型、显示管线数据流，到驱动初始化、Atomic Modeset 状态机、关键回调与用户空间接口，给出一条"从注册到点亮屏幕"的完整脉络。

> 代码路径：`drivers/gpu/drm/`，核心框架在 `drivers/gpu/drm/drm_*.c`，具体硬件驱动在 `drivers/gpu/drm/<vendor>/`。

---

## 一、为什么需要 DRM

早期显示驱动走 **fbdev（framebuffer）** 框架，只有一块线性显存和一个 `fb_info`：

- 无法表达多图层/叠加（overlay）、硬件光标、旋转缩放；
- 没有统一的模式设置（modeset）与热插拔通知；
- 多进程共享 GPU 时无同步机制，画面撕裂；
- 显存管理粗糙，无法做零拷贝、跨设备共享。

DRM 把"**显示（Display）**"与"**渲染（Render/GPU）**"统一到一套对象模型下：

| 维度 | fbdev | DRM/KMS |
| ---- | ---- | ---- |
| 抽象粒度 | 单块 framebuffer | CRTC / Plane / Encoder / Connector 组合 |
| 模式设置 | 固定/少变 | 运行时 atomic/comit 切换 |
| 图层合成 | 不支持硬件叠加 | Plane + Blend 硬件合成 |
| 多进程 | 无 | GEM + 同步对象（fence/dma-fence） |
| 热插拔 | 无标准 | Connector 状态轮询/中断 + uevent |
| 内存管理 | 线性显存 | GEM/TTM，支持 CMA、dma-buf 共享 |

KMS（Kernel Mode Setting）是 DRM 中负责显示的那一半，也是显示驱动开发的主战场。

---

## 二、核心对象模型

DRM 用一组对象描述整条显示管线，对象之间通过指针互联：

```plaintext
        +---------------------------------------------+
        |              drm_device                     |
        |  (一个显卡/显示控制器实例, 持有 mode_config) |
        +---------------------------------------------+
                             |
        +--------------------+---------------------+
        |                                          |
   drm_plane                                 drm_crtc  (扫描输出/时序发生器)
   (图层: 像素来源,                              |
    可缩放/叠加)                                 |
        |                                        |
        | 送给                                   v
        +----------------------------------> drm_encoder (编码器)
                                                 |
                                                 v
                                            drm_connector (物理接口/显示器)
                                                 |
                                                 v
                                           Panel / Monitor / Bridge
```

| 对象 | 结构体 | 职责 |
| ---- | ---- | ---- |
| 设备 | `drm_device` | 驱动实例，持有 `drm_mode_config`、GEM、文件句柄 |
| 图层 | `drm_plane` | 像素数据来源，支持主/叠加/光标、缩放与混合 |
| 扫描 | `drm_crtc` | 时序发生器，取 Plane 数据按刷新率扫出 |
| 编码 | `drm_encoder` | 把像素流编码成具体电气格式（DSI/LVDS/HDMI…） |
| 连接 | `drm_connector` | 物理接口与显示器，负责 EDID、HPD、状态探测 |
| 桥 | `drm_bridge` | 链式转换器（如 MIPI DSI → HDMI 的 LT9611） |
| 帧缓存 | `drm_framebuffer` | 一次显示的像素缓冲，绑定 GEM object |
| 显存 | `drm_gem_object` | 显存对象，跨设备可通过 dma-buf 共享 |
| 显示模式 | `drm_display_mode` | 分辨率/时序参数（h/v 前后沿、同步、时钟） |

**关键关系：** 一次完整的显示 = `Connector` 提供可用 mode → `CRTC` 按 mode 产生时序 → `Plane` 提供像素 → `Encoder`/`Bridge` 把信号送出去。

---

## 三、显示管线数据流

像素从内存到屏幕的路径：

```plaintext
GEM object / dma-buf
        │  (映射为 drm_framebuffer)
        v
   drm_plane  ──(缩放/格式转换/叠加混合)──►
        │
        v
   drm_crtc   ──(按 drm_display_mode 扫描)──►
        │
        v
   drm_encoder ──► drm_bridge(可选, 可级联) ──► drm_connector
        │
        v
   PHY / 物理接口 (DSI / eDP / HDMI / DP)
        │
        v
      显示器
```

对应到一次 `atomic_commit`：框架按 **plane → crtc → encoder → connector** 的顺序调用各对象的原子回调，把"准备（prepare）"与"提交（commit）"分两阶段执行，避免时序切换时出现花屏。

---

## 四、驱动初始化流程

一个典型 DRM 显示驱动（如 Rockchip VOP、NXP DPU）的 probe 主脉络：

### 4.1 注册 drm_device

```c
static int vop_probe(struct platform_device *pdev)
{
    struct drm_device *drm;
    struct vop *vop;

    drm = drm_dev_alloc(&vop_driver, dev);   /* 分配 drm_device */
    vop = devm_kzalloc(dev, sizeof(*vop), GFP_KERNEL);
    drm->dev_private = vop;
    ...
    drm_mode_config_init(drm);               /* 初始化 mode_config */
    ...
    ret = component_add(dev, &vop_component_ops);  /* 参与 component 拼装 */
    ...
}
```

**为什么用 component framework？** 显示链路上的 CRTC、Encoder、Connector、Bridge 往往由不同驱动（不同 compatible）提供，必须等所有子设备 probe 完成后才能拼成一条完整管线。component 框架负责"收集子设备 → 全部就绪后回调 master 的 `bind`"。

### 4.2 创建各类对象

在 `bind` 中依次创建并注册 CRTC、Plane、Encoder、Connector、Bridge：

```c
drm_crtc_init_with_planes(drm, crtc, primary, cursor, &vop_crtc_funcs, NULL);
drm_encoder_init(drm, encoder, &vop_encoder_funcs, DRM_MODE_ENCODER_DPI, NULL);
drm_connector_init(drm, connector, &vop_connector_funcs, DRM_MODE_CONNECTOR_HDMIA);
```

### 4.3 绑定回调与注册

给每个对象挂上 `funcs`（操作集），设置原子回调，最后注册：

```c
drm_mode_config_reset(drm);              /* 所有对象状态复位到默认值 */
drm_dev_register(drm, 0);                /* 暴露 /dev/dri/card0 */
drm_kms_helper_poll_init(drm);           /* 启动热插拔轮询 */
drm_fbdev_generic_setup(drm, 32);        /* 兼容 fbdev 控制台 */
```

常用操作集：

| 对象 | 操作集 | 主要回调 |
| ---- | ---- | ---- |
| CRTC | `drm_crtc_funcs` | `atomic_begin/atomic_flush/atomic_enable/atomic_disable` |
| CRTC state | `drm_crtc_helper_funcs` | `atomic_check/atomic_enable/atomic_disable/mode_set` |
| Plane | `drm_plane_funcs` + `drm_plane_helper_funcs` | `atomic_update/atomic_check/atomic_disable` |
| Encoder | `drm_encoder_helper_funcs` | `atomic_mode_set/enable/disable` |
| Connector | `drm_connector_funcs` + `drm_connector_helper_funcs` | `detect/get_modes/atomic_check/fill_modes` |

---

## 五、Atomic Modeset 状态机

现代 DRM 驱动统一走 **Atomic** 路径（`drm_atomic_*`），核心思想是"**先校验、后提交**"：

```plaintext
用户空间 ioctl (drmModeAtomicCommit)
        │
        v
drm_atomic_state  ── 收集所有被修改对象的新状态(old/new state)
        │
        v
[1] atomic_check  ── 逐对象校验可行性, 失败即整体回滚
        │  (可回退: 尝试低带宽/降速/去掉 overlay)
        v
[2] atomic_commit ── 两阶段提交
        ├─ prepare:  plane prepare_fb / crtc atomic_disable(旧)
        └─ commit :  plane atomic_update / crtc atomic_enable / bridge enable
        │
        v
硬件寄存器生效, 发出 vblank/page_flip 事件
```

几个要点：

1. **状态对象**：每个 DRM 对象都有对应的 `*_state`（如 `drm_crtc_state`）。修改的是状态副本，而非直接改硬件。
2. **两阶段提交**：`prepare`（可失败、可回退，如申请内存）与 `commit`（不可失败，直接写寄存器）分离，保证切换的原子性。
3. **非阻塞提交**：`DRM_MODE_ATOMIC_NONBLOCK` 让提交异步返回，由 `page_flip` 事件通知完成，适合高频合成（Wayland/Weston）。
4. **CRTC vs Plane 更新**：分辨率/时序变化走 CRTC 的 `atomic_enable`；仅换帧缓冲（同分辨率）走 Plane 的 `atomic_update`，即 page flip。

---

## 六、典型热点流程

### 6.1 热插拔（HPD）

```plaintext
显示器接入 → Connector 中断/轮询 detect()
   │ 状态变化
   v
drm_kms_helper_hotplug_event()
   │
   v
发送 uevent (HOTPLUG=1) → 用户空间 (systemd/udev/合成器) 收到
   │
   v
用户空间重新 getConnector + getResources → 选 mode → atomic_commit
```

### 6.2 读 EDID 决定分辨率

Connector 的 `get_modes` 通过 DDC（I2C）读 EDID，解析出显示器支持的 `drm_display_mode` 列表，作为用户空间选模式的依据。

### 6.3 桥接链（Bridge chain）

当输出路径上有中间转换芯片（如 `DSI → LT9611 → HDMI`）时，用 `drm_bridge` 串起来，`drm_bridge_chain_*` 按顺序调用每一级的 `enable/disable`。桥自身也可同时注册为 Connector。

---

## 七、用户空间接口

| 接口 | 用途 |
| ---- | ---- |
| `/dev/dri/card0` | 主设备，ioctl 完成 modeset、增加 FB、提交 atomic |
| `/dev/dri/renderD128` | 渲染节点，仅做 GPU 计算/渲染，不涉权限敏感的显示 |
| ioctl `MODE_GETRESOURCES` | 枚举 CRTC/Encoder/Connector 及其关系 |
| ioctl `MODE_GETCONNECTOR` | 取 connector 状态与可用 mode |
| ioctl `MODE_ATOMIC_COMMIT` | 原子提交状态变更 |
| ioctl `PAGE_FLIP` / `ATOMIC` + `PAGE_FLIP_EVENT` | 换帧与完成事件 |
| sysfs `/sys/class/drm/card0-*/` | 各 connector 的 `status` / `enabled` / `modes` |
| debugfs `/sys/kernel/debug/dri/0/` | `state`、`framebuffer`、`gem` 等调试信息 |

---

## 八、框架分层小结

一条自底向上的完整栈（以 DSI 屏为例）：

```plaintext
用户空间:  libdrm / Weston / KMS++  (atomic commit / page flip)
─────────────────────────────────────────────
内核 DRM 核心:  drm_atomic / drm_crtc_helper / drm_bridge / drm_panel
─────────────────────────────────────────────
厂商显示控制器:  CRTC + Plane + Encoder  (VOP / DPU / DISPC)
─────────────────────────────────────────────
桥接与面板:      drm_bridge (转接芯片) + drm_panel (面板时序/背光)
─────────────────────────────────────────────
底层总线/PHY:    MIPI DSI / LVDS / eDP / HDMI PHY
─────────────────────────────────────────────
硬件:            显示控制器 + PHY + 面板/显示器
```

---

## 九、调试手段

1. **debugfs**：`cat /sys/kernel/debug/dri/0/state` 查看当前所有对象的 atomic 状态与连接关系。
2. **modetest**（libdrm 工具）：`modetest -M <driver>` 枚举资源，`modetest -s <conn>:<mode>` 强制点亮。
3. **sysfs 状态**：`cat /sys/class/drm/card0-HDMI-A-1/status` 判断 HPD 是否生效。
4. **内核日志**：打开 `drm.debug=0x1f` 观察 atomic 提交、mode 校验与 vblank。
5. **常见问题**：黑屏多因 `atomic_check` 静默失败（降级到更小 mode）、桥未 enable、或 DSI 时钟未锁；花屏多为格式/stride 不匹配或 plane 未 double-buffer。

---

## 参考

- 内核文档：`Documentation/gpu/drm-kms.rst`、`drm-kms-helpers.rst`、`drm-uapi.rst`
- 源码：`drivers/gpu/drm/drm_atomic.c`、`drm_crtc.c`、`drm_bridge.c`、`drivers/gpu/drm/drm_panel.c`
- 工具：libdrm（`modetest`）、`kmscube`
