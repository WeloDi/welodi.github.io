---
title: DRM显示驱动框架
date: 2026-09-11 10:00:00
tags:
  - DRM
  - 显示驱动
  - Linux内核
categories:
  - 显示驱动
  - DRM
---

## 文档概述

本文梳理 Linux 内核 **DRM（Direct Rendering Manager）** 显示驱动子系统的整体框架：从"为什么需要 DRM"、核心对象模型，到主机驱动的初始化流程、Atomic Modeset 状态机、典型热点流程与用户空间接口，再到分层归属（主机驱动 vs 设备驱动）与调试手段，给出一条"从注册到点亮屏幕"的完整脉络。


> 代码路径：`drivers/gpu/drm/`
> 核心框架： `drivers/gpu/drm/drm_*.c`
> 具体硬件驱动： `drivers/gpu/drm/<vendor>/`

---

## 一、为什么需要 DRM

在屏幕上显示一张图片，底层实际上要做这么多活：

| 要做的活 | 具体指什么 |
| ---- | ---- |
| 分配显存 | 从显存里找一块地，把像素放进去 |
| 描述像素布局 | 分辨率、像素格式（RGB565/ARGB8888）、行间距（pitch） |
| 产生扫描时序 | 每秒扫多少行、什么时候发同步信号（分辨率、刷新率） |
| 叠加多个图层 | 视频在底层、UI 在上层、鼠标光标在最上层 |
| 把信号送出去 | 转成 DSI / LVDS / HDMI 的电气信号 |
| 应付热插拔 | 屏拔了要通知应用，插回来要重新选分辨率 |
| 多进程共享、防撕裂 | 谁在画这一帧、画完没有、什么时候可以换下一帧 |

早期内核用 **fbdev（framebuffer）** 做显示，但它只有"一块线性显存 + 一个 `fb_info`"，只解决了上面前两行：

- 一块显存就是一幅画面，**没有图层概念**：想做"视频 + UI 叠加"，只能让 CPU 先把两幅图搬到同一块 buffer，费带宽又费 CPU；
- 分辨率在启动时就定死，运行时改分辨率、改刷新率没有标准做法，硬件光标、旋转、缩放也无从表达；
- 显存没有共享与同步机制，GPU 正在渲染的 buffer 可能被显示端读走，画面撕裂；
- 显示器热插拔没有统一的探测与通知手段。

于是内核另起一套框架 **DRM**：不再用"一块显存"描述显示，而是把上面这些活**拆成几个互相独立的对象**，每个对象对应硬件里一块真实存在的功能单元，谁改什么各管一段。

DRM 把"**显示（Display）**"与"**渲染（Render/GPU）**"统一到一套对象模型下，fbdev 的每条短板在 DRM 里都有专门的对象负责：

| 维度 | fbdev 的做法 | DRM 的做法 |
| ---- | ---- | ---- |
| 画面描述 | 一块显存 = 一幅画面 | 用图层（Plane）分开描述，可叠加合成 |
| 分辨率/刷新率 | 启动时定死 | 运行时按需切换（atomic commit） |
| 图层合成 | 只能 CPU 搬图 | 硬件图层合成（缩放/混合/光标） |
| 多进程 | 没有共享机制 | GEM 共享 buffer + fence 同步 |
| 显示器热插拔 | 无标准方法 | Connector 探测 + uevent 通知应用 |
| 显存管理 | 线性显存，单一映射 | GEM/TTM，支持 CMA、dma-buf 跨设备共享 |

### 1.1 三大组成：libdrm、KMS 与 GEM

从功能划分看，DRM 由三个模块组成，分别负责用户态接口、显示模式管理与显存管理：

| 模块 | 所在层 | 职责 |
| ---- | ---- | ---- |
| **libdrm** | <span style="white-space:nowrap">用户空间</span> | 用户态接口库，将应用请求（改分辨率、换帧）打包为 ioctl 下发内核，应用无需自行编写 ioctl，也避免多应用争抢显存 |
| **KMS** | <span style="white-space:nowrap">内核空间</span> | Kernel Mode Setting：决定**画面如何显示**——分辨率/刷新率/电源状态，以及 buffer 何时切换、图层如何排布 |
| **GEM** | <span style="white-space:nowrap">内核空间</span> | Graphics Execution Manager：决定**像素存放位置**——显示 buffer 的分配与释放，也是渲染侧（GPU / render node）最依赖的部分 |

KMS 与 GEM 各自管理一组对象：

- **KMS 的对象**：`CRTC`、`PLANE`、`ENCODER`、`CONNECTOR`、`FB`，外加 `VBLANK`（场消隐中断）与 `property`（可配置参数）；
- **GEM 的对象**：`DUMB`（最简单的线性 buffer）、`PRIME`（跨设备共享的 dma-buf）；
- **同步对象**：`fence`（`dma_fence`）两边都不算，它属于 dma-buf 共享体系（`drivers/dma-buf/`），KMS 与 GEM 都靠它做跨进程、跨设备的同步。

{% asset_img drm-layers.png "DRM 分层架构：用户空间 libdrm，内核空间 DRM core / DRM driver，向下管理 GEM 与 KMS" %}

> 显示驱动开发的重点在 KMS（分辨率、时序、图层、接口）；GEM 的公共实现（分配、mmap、dma-buf 导出）由框架与通用 helper 承担，主机驱动只需要选定后端，并把 buffer 映射进自己的地址空间。

---

## 二、核心对象模型

这一章最容易看晕，因为它全是名词。先别背定义，建立一个直觉：**DRM 把"显示"这件事拆成了几段流水线，每一段都是一个独立对象，对应硬件里一块真实存在的功能单元。**

### 2.1 对象总览

名字先不用记，先建立直觉。

| 对象 | 它在硬件/系统里对应什么 |
| ---- | ---- |
| `drm_device` | 一个显示控制器实例，对应一个 `/dev/dri/card0` |
| `drm_gem_object` | 显存里的一块 buffer（真正的像素内存） |
| `drm_framebuffer` | 对 GEM buffer 的描述，本身不含像素（从哪开始、一行多少字节、什么格式） |
| `drm_plane` | 显示控制器里的图层/合成单元（主图层、overlay、光标），可缩放、可多层叠加 |
| `drm_crtc` | 扫描/时序发生器，决定分辨率、刷新率、行场同步 |
| `drm_encoder` | 把并行像素流转成 DPI/DSI/LVDS/HDMI 等格式 |
| `drm_bridge` | 链路上的转换单元：外挂桥接 IC（如 MIPI DSI → HDMI 的 LT9611），也可以是 SoC 内部的控制器逻辑（如 `dw-hdmi`） |
| `drm_connector` | 物理接口与显示器，负责 EDID、HPD、连接状态 |
| `drm_display_mode` | 分辨率 + 前后沿 + 同步极性 + 像素时钟 |
| `drm_property` / `*_state` | 可配置项与待提交副本（旋转、alpha、位置等） |

### 2.2 各对象的职责

下面才是重点——**它归谁管、你写驱动时要做什么**：

**容器与显存**

- **`drm_device`（一台设备）**：所有对象的容器。probe 时 `drm_dev_alloc()` 创建，末尾 `drm_dev_register()` 之后用户空间就能看到 `/dev/dri/card0`。它自己不显示任何东西，身上主要挂两样：内嵌的 `drm_mode_config`——KMS 的全部家当；以及 GEM 的分配与地址空间管理（buffer 在 device 名下分配，每进程的 handle 表存在 `drm_file` 里）。
- **`drm_gem_object`（像素内存）**：真正存放像素的显存，分配、释放、dma-buf 跨设备共享都在这一层。
- **`drm_framebuffer`（扫描输出描述）**：只解释"这块显存怎么读"——format、pitch、size、offset，本身不含像素。因此同一个 GEM buffer 可以被描述成多个 Framebuffer。

**从像素到屏幕**

- **`drm_plane`（像素从哪来）**：引用一个 Framebuffer，并说明它贴到 CRTC 输出的哪块矩形、要不要缩放旋转、用什么方式和下层混合。硬件有几个图层就注册几个 Plane——常见的 primary / overlay / cursor 就是三个。
- **`drm_crtc`（画面怎么扫出来）**：按 `drm_display_mode` 把合成好的画面一行行输出，产生行/场同步与 vblank 中断。它不关心像素内容，只关心节奏；分辨率或刷新率变化时，是它在 `atomic_enable` 里重配时序。
- **`drm_encoder`（信号怎么出去）**：把 CRTC 的并行像素流转成某种接口格式（DPI/RGB、DSI、LVDS、HDMI…）。它属于显示控制器内部的一段逻辑，既不接屏也不认屏。
- **`drm_bridge`（链路上的转接站）**：和 Encoder 的区别在于，Bridge 可以独立注册、独立驱动、可级联，`drm_bridge_chain_*` 会按顺序回调每一级的 `enable/disable`。链路上没有额外芯片时可以完全不用它。注意 `drivers/gpu/drm/bridge/` 目录里既有外部转接芯片，也有 `dw-hdmi` 这类实际属于 SoC 内部的控制器逻辑——判断它算不算"设备驱动"，要看信号是被它**产生**还是被它**转发**。
- **`drm_connector`（插的是什么屏）**：负责读 EDID（拿到屏支持的分辨率列表）、探测 HPD 热插拔、上报连接状态。用户空间要点亮屏幕，第一步就是问它有哪些 mode。

**参数与配置**

- **`drm_display_mode`（时序参数表）**："1920x1080@60"到底怎么扫：像素时钟、h/v 有效区、前后沿、同步脉宽与极性。用户空间选好 mode 后交给 CRTC。
- **`drm_property` / `*_state`（可配置项与待提交副本）**：旋转、alpha、位置这些可变参数都是 property；每次 atomic 提交改的是 state 副本，校验通过后才写硬件（见第四章）。

上面这些名字在源码里的落点如下：

| 对象 | 结构体 | 主要源码（`drivers/gpu/drm/`） |
| ---- | ---- | ---- |
| 设备 | `drm_device` | `drm_drv.c`、`drm_mode_config.c` |
| 图层 | `drm_plane` | `drm_plane.c` |
| 扫描 | `drm_crtc` | `drm_crtc.c` |
| 编码 | `drm_encoder` | `drm_encoder.c` |
| 连接 | `drm_connector` | `drm_connector.c` |
| 桥 | `drm_bridge` | `drm_bridge.c` |
| 面板 | `drm_panel` | `drm_panel.c` |
| 帧缓存 | `drm_framebuffer` | `drm_framebuffer.c` |
| 显存 | `drm_gem_object` | `drm_gem.c` |
| 时序 | `drm_display_mode` | `drm_modes.c` |
| 状态提交 | `drm_atomic_state` | `drm_atomic.c` |

> 表中列的是**框架实现**的位置；厂商自己的实现——CRTC 的寄存器操作、GEM 的显存后端等——在 `drivers/gpu/drm/<vendor>/` 下。

### 2.3 一次完整的显示流程

假设你在板子上播放 1080p@60 视频，显示器是 HDMI 接口，而 SoC 只有 MIPI DSI 输出，中间用 DSI -> HDMI 桥接芯片：

1. 屏幕上的一帧图像由：视频画面、UI、鼠标光标组成，它们各自准备到一块 GEM buffer——解码器写视频帧，合成器画 UI 画面，光标应用准备小位图（常见 64×64）。三者的来源、尺寸、刷新节奏都不同，只是恰好都要上屏：视频每帧都换，UI 变了才重画，光标只在移动时更新；
2. 用户空间把每个GEM buffer描述成一个 Framebuffer，分别挂到视频层、UI 层、光标层三个 Plane 上。这一步动的只有 Framebuffer——Plane 是驱动 probe 时就注册好的静态对象，用户空间只能挑一个来用、不能新建；而一个 Plane 同时只能引用一块 Framebuffer，想叠三层就得有三个 Plane；
3. 硬件按各 Plane 的叠加规则把三层合成一帧画面，交给 CRTC；
4. CRTC 按 `drm_display_mode` 里的时序把画面一行行扫描输出；
5. Encoder 把像素流编码成 MIPI DSI 信号；
6. Bridge（LT9611）把 DSI 转成 HDMI；
7. Connector 从物理接口把信号送出去，显示器亮起；
8. 每显示完一帧（或到达 vblank），硬件产生中断，DRM 通过 `page_flip` 事件通知用户空间"这一帧已上屏，可以送下一帧了"。

上面这条流水线里出现的 GEM 与 KMS 对象，以及它们之间的引用关系如下图：

{% asset_img drm-kms-gem-relations.svg "GEM 与 KMS 对象关系" %}

---

## 三、主机驱动的初始化流程

> **适用边界**：本节描述的是**主机驱动**（拥有 `drm_device`、负责暴露 `/dev/dri/card0` 的那个驱动，即片上显示控制器驱动）的 probe 流程。Bridge / Panel 这类设备驱动不拥有 `drm_device`，本节任何一步都不需要它们实现——它们只要在主机 `bind` 之前完成 `drm_bridge_add()` / `drm_panel_add()` 注册，剩下交给主机按 OF graph 接入（见 5.3、5.4）。

一个典型主机驱动的 probe 主脉络：

### 3.1 注册 drm_device

```c
static int vop_probe(struct platform_device *pdev)
{
    struct drm_device *drm;
    struct vop *vop;

    /* struct vop 内嵌 struct drm_device drm：一次分配，生命周期交给 devres */
    drm = devm_drm_dev_alloc(dev, &vop_driver, struct vop, drm);
    if (IS_ERR(drm))
            return PTR_ERR(drm);
    vop = container_of(drm, struct vop, drm);   /* 不再需要 drm->dev_private */
    ...
    drmm_mode_config_init(drm);              /* 初始化 mode_config */
    ...
    ret = component_add(dev, &vop_component_ops);  /* 参与 component 拼装 */
    ...
}
```

> 上面是新内核的写法：`devm_drm_dev_alloc()` 同时分配 `drm_device` 与私有数据，`drmm_` 前缀的函数由 devres 托管、卸载时自动回收，不必再手写 `dev_private` 和 `drm_dev_put()`。老内核里对应的是 `drm_dev_alloc()` + `devm_kzalloc()` + `drm->dev_private = vop`。

**为什么用 component framework？** 显示链路上的 CRTC、Encoder、Connector、Bridge 往往由不同驱动（不同 compatible）提供，必须等所有子设备 probe 完成后才能拼成一条完整管线。component 框架负责"收集子设备 → 全部就绪后回调 master 的 `bind`"。

### 3.2 创建各类对象

在 `bind` 中依次创建并注册 CRTC、Plane、Encoder、Connector、Bridge：

```c
drm_crtc_init_with_planes(drm, crtc, primary, cursor, &vop_crtc_funcs, NULL);
drm_encoder_init(drm, encoder, &vop_encoder_funcs, DRM_MODE_ENCODER_DPI, NULL);
drm_connector_init(drm, connector, &vop_connector_funcs, DRM_MODE_CONNECTOR_HDMIA);
```

### 3.3 绑定回调与注册

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

### 3.4 drm_client：内核侧的"迷你用户态"

3.3 节最后一句 `drm_fbdev_generic_setup()` 背后就是 `drm_client`。它是 DRM 核心给**内核内部**的显示使用者准备的一套抽象（`drm_client.c`、`drm_client_modeset.c`），目的只有一个：让内核自己的显示功能——fbdev 模拟（`/dev/fb0`）、fbcon 控制台、开机 logo——**像用户态程序一样**通过 `drm_file` + modeset 路径去用显卡，而不是让每个驱动各自去碰硬件。

**为什么需要它**：DRM 里同一时刻只有一个客户端能改显示模式（DRM master）。可开机早期没有用户态，内核自己又要显示 console 和启动画面；若内核代码直接去抢 master，就会和后面的 Weston/X 打架。于是抽象出 client：它持有一个**真正的 `drm_file`**（`drm_file_alloc()` 出来的），但**不持有 master**，走内核内部 API（`drm_atomic_commit()` 等，不是 ioctl）提交，因此不参与 master 竞争。

关键结构：

```c
struct drm_client_dev {
    struct drm_device *dev;                /* 归属的 drm_device */
    const char *name;                      /* "fbdev" / "fbcon"，调试用 */
    struct list_head list;                 /* 挂进 dev->clientlist（clientlist_mutex 保护） */
    struct drm_file *file;                 /* 自己的"用户态身份" */
    const struct drm_client_funcs *funcs;  /* 回调表，可以为 NULL */
    struct drm_mode_set *modesets;         /* 每个 connector 一份配置 */
    bool suspended;
    bool hotplug_failed;
};

struct drm_client_funcs {
    struct module *owner;
    void (*unregister)(struct drm_client_dev *);
    int  (*restore)  (struct drm_client_dev *);
    int  (*hotplug)  (struct drm_client_dev *);
    int  (*suspend)  (struct drm_client_dev *);
    int  (*resume)   (struct drm_client_dev *);
};
```

它提供三类能力：

| 类别 | 主要接口 | 作用 |
| --- | --- | --- |
| 生命周期与事件分发 | `drm_client_init()` / `drm_client_register()` / `drm_client_release()`；设备级 `drm_client_dev_hotplug()` / `_restore()` / `_suspend()` / `_resume()` / `_unregister()` | 维护 `dev->clientlist`，把事件广播给所有 client。`drm_fbdev_generic_setup()` 内部就是 `drm_client_init()` + `drm_client_register()` |
| modeset 帮助 | `drm_client_modeset_probe()` / `_check()` / `_commit()` / `_commit_locked()` | 逐 connector 探测、读 EDID、选 mode 并提交；**绕开 master 检查** |
| buffer 帮助 | `drm_client_framebuffer_create()` / `_delete()`、`drm_client_buffer_vmap()` / `_vunmap()` | 造一块既能被 CPU 映射、又能当扫描输出源的 framebuffer |

内核里现成的 client 只有两个，**它不是给 bridge / panel 驱动调的 API**：

- `name = "fbdev"`：fbdev 模拟，提供 `/dev/fb0`。5.x 在 `drm_fbdev_generic.c`；6.3 之后拆成 `drm_fbdev_dma.c` / `drm_fbdev_ttm.c`，驱动侧入口也从 `drm_fbdev_generic_setup()` 变成 `drm_client_setup(dev, &drm_fbdev_dma_driver_funcs)`；
- `name = "fbcon"`：`drm_fb_helper.c` 里的 fbcon client，把 VT 控制台画到 DRM 上。

时间线（谁在什么时候调它们）：

```c
驱动 probe → drm_fbdev_generic_setup() / drm_client_setup()
                └─ drm_client_init() + drm_client_register()
                     └─ register 时立刻调一次 funcs->hotplug()   ← 所以开机马上就有 console
HPD 中断   → drm_kms_helper_hotplug_event()
                └─ drm_client_dev_hotplug() → 遍历 clientlist 调 funcs->hotplug()（见 5.1）
最后一个 master 关闭 → drm_lastclose() → drm_client_dev_restore()
                └─ 让 fbcon 接管画面（退出 Weston/X 后 console 回来的原因）
suspend/resume → drm_client_dev_suspend() / drm_client_dev_resume()
```

与用户态客户端的区别：

| | 用户态客户端 | 内核 client |
| --- | --- | --- |
| `drm_file` | 有（`open("/dev/dri/card0")`） | 有（内核内分配，不暴露 fd） |
| DRM master | 可以持有 | **不持有** |
| 提交路径 | ioctl（`DRM_IOCTL_MODE_ATOMIC`），有 master 检查 | 直接调用 `drm_atomic_commit()` 等内部函数 |
| 典型使用者 | Weston / X / modetest | fbdev 模拟、fbcon |

两者共用同一套 KMS 对象与 atomic 状态机，冲突由 modeset 锁协调。

### 3.5 `drm_xxx_funcs` 与 `drm_xxx_helper_funcs` 的区别

- **`drm_xxx_funcs`**：DRM ioctl 操作的最终入口，是**必选**的基本函数指针（如 `destroy`、`atomic_duplicate_state`）。
- **`drm_xxx_helper_funcs`**：**可选**的辅助函数指针，用于补充/客制化 DRM 提供的 helper 库函数（如 `atomic_update`、`mode_set`）。
- **helper 库**：框架提供的通用实现（`drm_atomic_helper_*`、`drm_crtc_helper_*`），把各厂商驱动里"你抄我、我抄你"的公共流程抽象出来，差异化的寄存器操作留在 `helper_funcs` 里。

---

## 四、Atomic Modeset 状态机

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

## 五、典型热点流程

### 5.1 热插拔（HPD）

```c
显示器接入 → Connector 中断/轮询 detect()
   │ 状态变化
   v
drm_kms_helper_hotplug_event()
   ├─ drm_sysfs_hotplug_event() → uevent (HOTPLUG=1)
   │      v
   │   用户空间 (systemd/udev/合成器) 重新 getConnector + getResources
   │      → 选 mode → atomic_commit
   │
   └─ drm_client_dev_hotplug() → 遍历内核 client（fbdev / fbcon，见 3.4）
          v
        funcs->hotplug() → drm_client_modeset_probe() [ + commit ]
          │  console 正在用显示时才真正提交，否则只更新 mode 表
          v
        回调到 bridge 的 detect() / edid_read() → 再走上面的 atomic_commit
```

两条路最终都会重新探测到 `detect()` / `edid_read()`：内核 client 这条路是同步的（就跑在中断线程里），所以 HPD 中断必须用**线程化中断**（`devm_request_threaded_irq` + `IRQF_ONESHOT`），不能在硬中断上半部处理。

### 5.2 读 EDID 决定分辨率

Connector 的 `get_modes` 通过 DDC（I2C）读 EDID，解析出显示器支持的 `drm_display_mode` 列表，作为用户空间选模式的依据。

### 5.3 桥接链（Bridge chain）

当输出路径上有中间转换芯片（如 `DSI → LT9611 → HDMI`）时，用 `drm_bridge` 串起来，`drm_bridge_chain_*` 按顺序调用每一级的 `enable/disable`。桥自身也可同时注册为 Connector。

### 5.4 drm_panel：Encoder 驱动与 LCD 驱动的解耦

**耦合是怎么产生的：** Connector 在 LCD 驱动里构造，但初始化时要 attach 一个由另一套硬件驱动生成的 Encoder 对象；同时 Encoder 还负责通知显示设备休眠/唤醒，会直接调用 LCD 驱动导出的全局函数。于是"Encoder 驱动 ↔ LCD 驱动"形成直接耦合，可维护性、可移植性、可扩展性都下降。

**解法：** DRM 提供 `drm_panel` 结构体，封装 connector/encoder 对 LCD 访问的常用接口（`prepare`/`enable`/`disable`/`unprepare`/`get_modes`/`backlight`），把"Encoder 驱动直接调用 LCD 驱动"的强耦合改写为：

```plaintext
Encoder 驱动 ──► LCD 驱动              (强耦合)
        ↓ 改为
Encoder 驱动 ──► drm_panel ──► LCD 驱动 (低耦合)
```

`drm_panel` 不属于上面那批 DRM 对象，它只是一组回调函数的集合，但它是 Panel 驱动（`drivers/gpu/drm/panel/`）与主机驱动之间的标准接口。

---

## 六、调试手段

### 6.1 常用工具

1. **debugfs**：`cat /sys/kernel/debug/dri/0/state` 查看当前所有对象的 atomic 状态与连接关系。
2. **modetest**（libdrm 工具）：`modetest -M <driver>` 枚举资源，`modetest -s <conn>:<mode>` 强制点亮。
3. **sysfs 状态**：`cat /sys/class/drm/card0-HDMI-A-1/status` 判断 HPD 是否生效。
4. **内核日志**：打开 `drm.debug=0x1f` 观察 atomic 提交、mode 校验与 vblank。

### 6.2 实战：用 modetest 点亮屏幕

以 STM32MP157 + 4.3 寸 RGB（DPI）屏为例，驱动加载后 `/dev/dri/` 下会创建 `card0` 等设备节点。

把 `modetest` 上传到开发板并加执行权限后运行，会列出 DRM 下的 Encoders、Connectors、CRTCs：

{% asset_img drm-modetest.png "modetest 输出：列出 Encoders / Connectors / CRTCs" %}

从输出中找到目标屏对应的 Connector ID 与 CRTC ID（示例中 connected 的 connector id = 31、crtc id = 34，name 显示为 DPI 接口）：

{% asset_img drm-modetest-ids.png "从输出中找出目标屏的 Connector ID 与 CRTC ID（示例为 31 与 34）" %}

然后执行：

```sh
./modetest -M stm -s 31@34:480x272   # -s <connector>@<crtc>:<分辨率>
```

按回车退出测试。若报 `Device or resource busy` 或卡死，多为设备树插件配置冲突；`Permission denied` 则需 `sudo`/root 权限。

### 6.3 常见问题

- **黑屏**：多因 `atomic_check` 静默失败（自动降级到更小 mode）、桥未 enable、或 DSI 时钟未锁；
- **花屏**：多为格式 / stride 不匹配，或 plane 未 double-buffer。

> **fbdev 兼容**：DRM 框架下会模拟一个 fb 设备（如 ST 驱动最终生成 `/dev/fb0`），方便老软件/控制台使用，但只能用到基本功能（显存映射、控制台输出），无法使用 DRM 的高级能力。
>
> 这个"模拟 fb"由 DRM core 提供，不是某家厂商的私有实现——对应 3.3 节里那句 `drm_fbdev_generic_setup()`（较新内核已改为 `drm_client_setup()`），它内部就是一个 `drm_client`（见 3.4）。ST 驱动只是调用它。
