---
title: lt9611_driver
date: 2026-09-10 20:00:00
tags: [drm, 驱动开发]
---

## 文档概述

本文记录龙迅（Lontium）的 MIPI DSI → HDMI 1.4 桥接芯片LT9611驱动`drivers/gpu/drm/bridge/lontium-lt9611.c` 的架构、probe 流程、DRM 回调链路、热插拔（HPD）处理、显示配置流程与音频通路。

---

## 一、芯片工作原理

LT9611 数据与控制通路如下：

```plaintext
SoC ──MIPI DSI──▶ LT9611 ──HDMI TMDS──▶ 显示器
                    │
                    ├─ HDMI HPD / DDC（读 EDID）
                    └─ I2C 寄存器配置（SoC 侧驱动访问）
```

- **输入**：MIPI DSI，由 SoC 的 DSI 输出提供像素流。
- **输出**：HDMI TMDS，另含 DDC 通道（读显示器 EDID）与 HPD（热插拔检测）。
- **控制**：SoC 经 I2C 配置 LT9611 内部寄存器（DSI 输入、PLL、HDMI PHY、InfoFrame 等）。

热插拔检测让系统知道显示器已连接，随后 DRM 选择合适分辨率并调用 `atomic_enable` 完成整个链路配置。

## 二、驱动架构总览

LT9611 驱动是一个标准 **DRM Bridge** 驱动：自身注册 `drm_bridge` + `drm_connector`，向上挂在 SoC 的 DSI/显示管线之后，向下对接 HDMI 显示器。

### 2.1 DTS

```dts
/* 1) 上游 DSI */
&dsi0 {
	status = "okay";

	ports {
		port {
			dsi0_out: endpoint {
				remote-endpoint = <&lt9611_in>;
			};
		};
	};
};

/* 2) 桥本体 */
&i2c4 {
	lt9611_codec: hdmi-bridge@3b {
		compatible = "lontium,lt9611";
		reg = <0x3b>;
		#sound-dai-cells = <1>;

		interrupt-parent = <&pio>;
		interrupts = <68 IRQ_TYPE_LEVEL_LOW>;
		reset-gpios = <&pio 69 GPIO_ACTIVE_LOW>;

		vdd-supply = <&lt9611_1v8>;
		vcc-supply = <&lt9611_3v3>;

		pinctrl-names = "default";
		pinctrl-0 = <&lt9611_pins>;

		ports {
			#address-cells = <1>;
			#size-cells = <0>;

			port@0 {
				reg = <0>;
				lt9611_in: endpoint {
					remote-endpoint = <&dsi0_out>;
				};
			};

			/* LT9611 支持双 DSI 才有 port@1；单 DSI 不写 */
			port@2 {
				reg = <2>;
				lt9611_out: endpoint {
					remote-endpoint = <&hdmi_con>;
				};
			};
		};
	};
};

/* 3) HDMI 连接器 */
connector {
	compatible = "hdmi-connector";
	label = "hdmi";
	type = "a";                        /* micro-HDMI 用 "d" */

	port {
		hdmi_con: endpoint {
			remote-endpoint = <&lt9611_out>;
		};
	};
};

/* 4) 电源：也可直接借用 PMIC（如 <&mt6357_vsim2_reg>） */
lt9611_1v8: regulator-lt9611-1v8 {
	compatible = "regulator-fixed";
	regulator-name = "LT9611_1V8";
	regulator-min-microvolt = <1800000>;
	regulator-max-microvolt = <1800000>;
	vin-supply = <&vsys_lcm_reg>;
	gpio = <&pio 129 GPIO_ACTIVE_HIGH>;
	enable-active-high;
};

lt9611_3v3: regulator-lt9611-3v3 {
	compatible = "regulator-fixed";
	regulator-name = "LT9611_3V3";
	regulator-min-microvolt = <3300000>;
	regulator-max-microvolt = <3300000>;
	vin-supply = <&vsys_lcm_reg>;
};

/* 5) pinctrl */
&lt9611_pins: lt9611-pins {
	irq_pins {
		pinmux = <MT8365_PIN_68_CMDAT0__FUNC_GPIO68>;
		bias-disable;
	};
	rst_pins {
		pinmux = <MT8365_PIN_69_CMDAT1__FUNC_GPIO69>;
		output-high;
	};
};
```

### 2.2 数据结构

```c
struct lt9611 {
	struct device *dev;
	struct drm_bridge bridge;               /* DRM bridge 对象，即本驱动向 DRM 子系统注册的桥接器 */
	struct drm_bridge *next_bridge;         /* 下游桥接器/面板*/

	struct regmap *regmap;

	struct device_node *dsi0_node;          /* 主 DSI 输入（端口0）对应的设备树远端节点，必须存在 */
	struct device_node *dsi1_node;          /* 次 DSI 输入（端口1）对应的设备树远端节点，可选（双 DSI 拼接高分辨率用） */
	struct mipi_dsi_device *dsi0;           /* 由 dsi0_node 创建并挂接的主 DSI 设备 */
	struct mipi_dsi_device *dsi1;           /* 由 dsi1_node 创建并挂接的次 DSI 设备（可选） */
	struct platform_device *audio_pdev;     /* HDMI 音频用的 hdmi-codec 平台设备，向上层提供音频输出 */

	bool ac_mode;                           /* HDMI PHY 是否为 AC 耦合模式，取自设备树属性 lt,ac-mode */

	struct gpio_desc *reset_gpio;
	struct gpio_desc *enable_gpio;

	bool power_on;                          /* 软件状态标记：芯片是否已上电*/
	bool sleep;                             /* 软件状态标记：芯片是否处于睡眠态 */

	struct regulator_bulk_data supplies[2]; /* 两路供电描述：supplies[0]="vdd"，supplies[1]="vcc" */

	struct i2c_client *client;              /* 本驱动绑定的 I2C 客户端 */

	enum drm_connector_status status;       /* 缓存的 HDMI 连接器状态（connected/disconnected） */

	u8 edid_buf[EDID_SEG_SIZE];             /* 读取到的 EDID 数据缓存 */
};
```

### 2.3 regmap配置

```c
/* regmap_range_cfg 是Regmap 框架中用于描述间接访问或分页寄存器的配置结构。
   有些硬件设备内部寄存器空间较大，但通过总线可访问的窗口有限。这时硬件通常会设计一个“页选择寄存器”，先写入页号，再通过一个固定的“数据窗口”来间接访问内部的实际寄存器。regmap_range_cfg 就是用来描述这种映射关系。
*/
static const struct regmap_range_cfg lt9611_ranges[] = {
	{
		.name = "register_range",
		.range_min =  0,                        //可访问寄存器范围，寄存器地址落在此区间内时，Regmap 会自动执行分页访问。
		.range_max = 0x85ff,
		.selector_reg = LT9611_PAGE_CONTROL,    //页选择寄存器的地址
		.selector_mask = 0xff,                  //(page << shift) & mask
		.selector_shift = 0,
		.window_start = 0,                      //每页数据窗口起始地址
		.window_len = 0x100,                    //窗口长度为256 个寄存器，即每页暴露 0x00 ~ 0xFF 这 256 个地址
	},
};

static const struct regmap_config lt9611_regmap_config = {
	.reg_bits = 8,
	.val_bits = 8,
	.max_register = 0xffff,
	.ranges = lt9611_ranges,
	.num_ranges = ARRAY_SIZE(lt9611_ranges),
};
```

### 2.4 probe 流程

```c
static int lt9611_probe(struct i2c_client *client) {
    i2c_check_functionality()   /* 校验适配器支持原生 I2C 传输（读写寄存器需要） */
    lt9611 = devm_kzalloc(dev, sizeof(*lt9611), GFP_KERNEL);                 /* 分配lt9611 */
    lt9611->regmap = devm_regmap_init_i2c(client, &lt9611_regmap_config);    /* 初始化regmap */
    
    //获取设备树信息
    lt9611_parse_dt(dev, lt9611);   /* 解析设备树：获取 DSI 输入节点、下游 bridge/panel、AC 模式等 */
    lt9611_gpio_init(lt9611);       /* 从设备树中获取reset 和enable gpio保存到struct lt9611，并申请gpio*/
    lt9611_regulator_init(lt9611);  /* 从设备书中获取两路供电，并为vdd设置负载电流，以让 PMIC 选择合适档位*/

    //上电
    lt9611_assert_5v(lt9611);       /* 拉高lt9611->enable_gpio，以打开 5V 供电*/
    lt9611_regulator_enable(lt9611); /* 按序使能两路供电并延时 */
    lt9611_reset(lt9611);           /* 对reset_gpio进行拉高-拉低-拉高的操作进行复位 */


    lt9611_read_device_rev(lt9611); /* 读取芯片版本寄存器，验证 I2C 通信正常 */
    devm_request_threaded_irq(dev, client->irq, NULL,   /* 中断注册，只要上半部 */
					lt9611_irq_thread_handler,
					IRQF_ONESHOT, "lt9611", lt9611);

    // 初始化并注册 DRM bridge：ops、设备树节点、能力标志(DETECT/EDID/HPD/MODES)、连接器类型(HDMI-A)
    lt9611->bridge.funcs = &lt9611_bridge_funcs;
	lt9611->bridge.of_node = client->dev.of_node;
	lt9611->bridge.ops = DRM_BRIDGE_OP_DETECT | DRM_BRIDGE_OP_EDID |
			     DRM_BRIDGE_OP_HPD | DRM_BRIDGE_OP_MODES;
	lt9611->bridge.type = DRM_MODE_CONNECTOR_HDMIA;
	drm_bridge_add(&lt9611->bridge);

    //在上游 DSI 主机控制器（SoC 侧）上注册一个 DSI 设备，把 LT9611挂到 DSI 总线上，从而建立起视频通路
    lt9611->dsi0 = lt9611_attach_dsi(lt9611, lt9611->dsi0_node);
    if (lt9611->dsi1_node) 
		lt9611->dsi1 = lt9611_attach_dsi(lt9611, lt9611->dsi1_node);

    
	lt9611_enable_hpd_interrupts(lt9611);   /* 使能 HPD 中断（写寄存器） */
    lt9611_audio_init(dev, lt9611);         /* 注册 HDMI 音频子设备（hdmi-codec 平台设备） */
}
```

---

## 三、中断

```c
static irqreturn_t lt9611_irq_thread_handler(int irq, void *dev_id)
{
	struct lt9611 *lt9611 = dev_id;	
	unsigned int irq_flag0 = 0;
	unsigned int irq_flag3 = 0;

	/* 读取中断状态寄存器：
	 * HPD 状态寄存器记录 HPD 引起的状态变化，视频状态寄存器记录视频输入引起的变化 */
	regmap_read(lt9611->regmap, LT9611_INT_STATUS_HPD, &irq_flag3);
	regmap_read(lt9611->regmap, LT9611_INT_STATUS_VID, &irq_flag0);

	/* HPD 拔出：HDMI 线被拔出（HPD 由高变低） */
	if (irq_flag3 & BIT(7)) {
		dev_info(lt9611->dev, "hdmi cable disconnected\n");

		/* 清除 HPD 拔出中断 */
		regmap_write(lt9611->regmap, LT9611_INT_CLR, 0xbf);
		regmap_write(lt9611->regmap, LT9611_INT_CLR, 0x3f);
	}

	/* HPD 插入：HDMI 线被插入（HPD 由低变高） */
	if (irq_flag3 & BIT(6)) {
		dev_info(lt9611->dev, "hdmi cable connected\n");

		/* 清除 HPD 插入中断 */
		regmap_write(lt9611->regmap, LT9611_INT_CLR, 0x7f);
		regmap_write(lt9611->regmap, LT9611_INT_CLR, 0x3f);
	}

	/* 如果 HPD 状态发生变化，
	 * 且 bridge 已经注册到 DRM，就通知 DRM 框架发生热插拔事件 */
	if (irq_flag3 & LT9611_INT_HPD_MASK && lt9611->bridge.dev)
		drm_kms_helper_hotplug_event(lt9611->bridge.dev);

	/* 如果视频输入状态变化：DSI 输入侧的视频信号发生变化（如输入时序/信号丢失或恢复） */
	if (irq_flag0 & BIT(0)) {
		dev_info(lt9611->dev, "video input changed\n");

		/* 清除视频检测状态 */
		regmap_write(lt9611->regmap, LT9611_VIDEO_CHECK_CLR, 0xff);
		regmap_write(lt9611->regmap, LT9611_VIDEO_CHECK_CLR, 0xf7);
		/* 清除视频输入变化中断 */
		regmap_write(lt9611->regmap, LT9611_VIDEO_INT_CLR, 0xff);
		regmap_write(lt9611->regmap, LT9611_VIDEO_INT_CLR, 0xfe);
	}

	return IRQ_HANDLED;
}
```

---

## 四、DRM框架完善

```c
static const struct drm_bridge_funcs lt9611_bridge_funcs = {
	.attach = lt9611_bridge_attach,          /* 挂接下游 bridge/panel，把 pipeline 串起来 */
	.mode_valid = lt9611_bridge_mode_valid,  /* 过滤不支持的显示时序 */
	.detect = lt9611_bridge_detect,          /* 探测 HDMI 连接状态 */
	.edid_read = lt9611_bridge_edid_read,    /* 读取 EDID（先上电走 DDC） */
	.hpd_enable = lt9611_bridge_hpd_enable,  /* 使能 HPD 中断，监听插拔 */

	.atomic_pre_enable = lt9611_bridge_atomic_pre_enable,     /* 使能前：睡眠态则先唤醒 */
	.atomic_enable = lt9611_bridge_atomic_enable,             /* 使能：初始化链路并打开输出 */
	.atomic_disable = lt9611_bridge_atomic_disable,           /* 关闭：先关输出再断电 */
	.atomic_post_disable = lt9611_bridge_atomic_post_disable, /* 关闭后：进入睡眠以省电 */
	.atomic_duplicate_state = drm_atomic_helper_bridge_duplicate_state, /* 复制 state（默认实现） */
	.atomic_destroy_state = drm_atomic_helper_bridge_destroy_state,     /* 释放 state（默认实现） */
	.atomic_reset = drm_atomic_helper_bridge_reset,                     /* 初始 state（默认实现） */
	.atomic_get_input_bus_fmts = lt9611_atomic_get_input_bus_fmts,      /* 输入格式：DSI RGB888 */
};
```

当中断处理函数调用drm_kms_helper_hotplug_event后：
```c
drm_kms_helper_hotplug_event()
 └─ drm_client_dev_hotplug()
     └─ client->funcs->hotplug()          ← fbdev client
         └─ drm_fb_helper_hotplug_event()
             └─ drm_client_modeset_probe()
                 └─ connector->funcs->fill_modes()
                     └─ drm_helper_probe_single_connector_modes()
                         ├─ connector->funcs->detect()
                         │   └─ drm_bridge_connector_detect()
                         │       └─ bridge->funcs->detect()
                         │           └─ ★ lt9611_bridge_detect()        ← 读 HPD 寄存器
                         │
                         └─ connector->helper_private->get_modes()
                             └─ drm_bridge_connector_get_modes()
                                 └─ drm_bridge_connector_get_modes_edid()
                                     ├─ drm_bridge_connector_detect()    ← 又调一次 detect
                                     └─ drm_bridge_edid_read(bridge)
                                         └─ ★ lt9611_bridge_edid_read()  ← 读 EDID
                                             ├─ lt9611_power_on()
                                             └─ drm_edid_read_custom(..., lt9611_get_edid_block, ...)
                                                 └─ lt9611_get_edid_block()
                                                     └─ lt9611_read_edid()  ← DDC 读 256B

```

---

## 五、HDMI 音频通路

LT9611 同时把 DSI 携带的音频转发进 HDMI 的音频通道，作为 ASoC codec 注册回调：

| 回调 | 功能 |
| --- | --- |
| `.hw_params` | 设置音频采样率 (48k/96k) |
| `.audio_startup` | 启动音频通路 |
| `.audio_shutdown` | 关闭音频通路 |
| `.get_dai_id` | 获取 DAI ID (sound port) |

---

## 六、热插拔与显示配置完整调用链

```c
插入
 │
 ├─ HW: 显示器拉高 HPD ──► LT9611 触发中断 ──► SoC IRQ
 │
 ├─ lt9611_irq_thread_handler
 │     ├─ 读 HPD 中断状态(0x820f)：bit7=拔出、bit6=插入
 │     └─ 判定为「插入」→ drm_kms_helper_hotplug_event() 上报热插拔事件
 │
 ├─ DRM 核心
 │     ├─ 发 uevent → udev → 用户态
 │     └─ 通知内核内客户端（fbcon/fbdev）
 │
 ├─ 用户态重新探测连接器（drm_client_modeset_probe → fill_modes）
 │     ├─ lt9611_bridge_detect
 │     │      读 0x825e → connected
 │     │
 │     └─ lt9611_bridge_edid_read
 │            ├─ lt9611_power_on()（DDC 需要芯片工作）
 │            └─ lt9611_read_edid() 经 DDC 读回 256B EDID
 │
 ├─ DRM 解析 EDID → 生成 mode 表、音频能力、TMDS 上限
 │      lt9611_bridge_mode_valid 过滤（最大 3840x2160@30Hz）
 │
 ├─ 用户态选 mode，提交 atomic commit
 │     ├─ check         总线格式协商 + 模式校验
 │     ├─ pre_enable    仅当 sleep==true：唤醒芯片
 │     ├─ encoder atomic_enable
 │     └─ enable        lt9611_bridge_atomic_enable()
 │                     → MIPI 输入数字配置
 │                     → PLL 配置并使能 TxPLL
 │                     → MIPI 视频时序
 │                     → PCR 配置并复位（0x8300-0x834f）
 │                     → lt9611_power_on()
 │                     → MIPI 输入模拟前端（0x8110-0x812f）
 │                     → AVI/HDMI Vendor infoframe
 │                     → HDMI TX 数字配置（0x82d6）
 │                     → HDMI TX PHY 配置（0x8130-0x8144）
 │                     → msleep(500) 等视频稳定
 │                     → lt9611_video_check() 校验 DSI 输入锁定（0x825e）
 │                     → 使能 HDMI 输出（0x8130=0xea）   ★画面出现
 │
 │   ┈┈┈┈ 正常显示中 ┈┈┈┈
 │
拔出
 │
 ├─ HW: 显示器拉低 HPD ──► LT9611 触发中断 ──► SoC IRQ
 │
 ├─ lt9611_irq_thread_handler
 │     └─ 判定为「拔出」→ drm_kms_helper_hotplug_event() 上报热插拔事件
 │
 ├─ 用户态重新探测
 │     └─ lt9611_bridge_detect → disconnected（mode 表清空）
 │
 ├─ 用户态提交 disable commit
 │     ├─ disable       关闭 HDMI 输出 → lt9611_power_off()
 │     ├─ encoder atomic_disable
 │     └─ post_disable  lt9611_sleep_setup() 进入低功耗，sleep = true
 │
 ▼
  芯片停在 sleep 态，等下一次 HPD 插入
```