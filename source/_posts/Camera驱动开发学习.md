---
title: Camera驱动开发学习
date: 2026-07-18 03:59:42
tags:
  - camera
---
## 概述

拿到 SoC 和 Camera 模组后，BSP 开发工作的核心是将这两块硬件"打通"并调优，让它能稳定工作。这通常不是一个从零开始写所有代码的过程，而是一个**移植、配置和验证**的过程，因为 SoC 厂商和 Sensor 厂商通常会提供基础的驱动框架。

---

## 一、BSP 开发核心步骤

### 1. 环境搭建与基础系统准备

首先需要搭建交叉编译环境，并确认 SoC 的 BSP（板级支持包，包括 Linux 内核源码、设备树、根文件系统等）已经能在开发板上正确运行。这是后续所有调试工作的基础。

### 2. 硬件连接验证与设备树配置

这是最关键的步骤之一。需要根据 SoC 和 Camera 模组的硬件连接（原理图），修改 SoC 的**设备树（Device Tree Source, DTS）**文件，主要包括：

- **I2C 节点配置**：添加或修改 I2C 节点，配置 Camera 的从设备地址（`reg`），以便 SoC 可以通过 I2C 总线控制 Sensor。
- **MIPI CSI 接口配置**：指定使用的 MIPI 通道数量（`data-lanes`）、链路频率等参数，确保 SoC 能正确接收 Sensor 发出的高速图像数据。
- **硬件资源描述**：描述电源、时钟、复位（Reset）和掉电（PWDN）引脚等硬件资源，并完成 Sensor 的 MIPI 输出端与 SoC 的 MIPI 接收端（如 CSI 或 D-PHY 控制器）的拓扑绑定。

### 3. Sensor 驱动移植与适配

这是 BSP 开发的核心。Sensor 厂商通常会提供基于 Linux V4L2 框架的基础驱动代码（例如 `imx766.c`），主要工作是将它移植到你的内核版本和平台上。

#### `struct v4l2_subdev` — 驱动的核心

需要实现 Sensor 子设备的操作集（`v4l2_subdev_ops`），这是 V4L2 框架的标准接口，包括：

| 回调函数 | 功能 |
|---------|------|
| `s_power` | 上电/下电时序控制 |
| `s_stream` | 数据流开关 |
| `set_fmt` | 格式设置（分辨率、帧率等） |

#### 硬件控制

驱动通过 I2C 读写 Sensor 的内部寄存器，完成初始化、设置分辨率、曝光、增益等操作。通常会提供 `v4l2_ctrl_handler` 来管理这些用户可调的控制项。

### 4. SoC 端 Camera 接口驱动确认与配置

大多数情况下，CSI/ISP 驱动已由 SoC 厂商提供，但需要确保它被正确编译进内核，并与 Sensor 驱动协同工作。

- **ISP 配置**：如果 SoC 内部有 ISP（图像信号处理器），需要对 ISP 驱动进行配置，使其能正确处理 Sensor 输出的 Raw Bayer 数据格式（如 `SRGGB10`），并转换为 YUV 或 RGB 格式输出。
- **Bridge 驱动**：在一些复杂的 SoC 上（如 NXP i.MX8MP），可能还需要在 CSI 驱动和 ISP 驱动之间添加一个"桥"驱动（Bridge Driver），来协调整个数据通路。

### 5. 编译、烧录与调试

完成上述修改后，需要重新编译内核、设备树和驱动模块，并烧录到开发板上进行调试。标准调试流程：

1. **硬件信号检查**：先用示波器确认 Sensor 的上电时序和复位信号是否正常。
2. **内核日志查看**：用 `dmesg` 查看 I2C 通信是否成功，驱动是否被正确 probe。
3. **V4L2 工具验证**：借助 `media-ctl` 和 `v4l2-ctl` 查看和配置整个 Camera 管线（Pipeline），尝试抓取一帧图像。
4. **图像质量调优**：通过调节 Sensor 和 ISP 的寄存器，优化颜色、清晰度、动态范围等。

---



- **善用调试工具**：`dmesg`、`media-ctl`、`v4l2-ctl` 和 `printk` 是调试过程中最得力的助手。



内核错误码速查表
错误码宏	内核返回值	含义	常见场景
EIO	-5	输入/输出错误	与硬件通信失败（如 I2C 无应答），这是你代码中最可能的返回值
EINVAL	-22	无效参数 (Invalid Argument)	传递给函数的参数不合法，比如指针为 NULL 或数值越界
ENOMEM	-12	内存不足 (Out of Memory)	调用 kmalloc 等内存分配函数失败
EAGAIN	-11	资源暂时不可用 (Try Again)	非阻塞操作无法立即完成，稍后重试可能成功，如设备忙
EBUSY	-16	设备或资源忙 (Device or Resource Busy)	尝试访问一个已经被独占使用的硬件资源
ENODEV	-19	无此设备 (No Such Device)	尝试操作一个不存在的设备
EFAULT	-14	地址错误 (Bad Address)	传递的用户空间指针无效
EPERM	-1	操作不允许 (Operation Not Permitted)	权限不足，例如需要 root 权限
ETIMEDOUT	-110	连接超时 (Connection Timed Out)	I2C 读写在超时时间内未完成