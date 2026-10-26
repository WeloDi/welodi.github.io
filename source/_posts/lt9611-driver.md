---
title: lt9611_driver
date: 2026-09-10 20:00:00
tags: [drm, 驱动开发]
categories:
  - 显示驱动
  - 桥接芯片
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

## 四、DRM框架

### 4.1 流程总览
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
完整的调用流程如下：
{% asset_img lt9611-call-flow.svg "从 probe 建链到 HPD 插入/取模式表/点屏/拔出的完整调用关系" %}

### 4.2 函数解析（按实际调用顺序）

**lt9611_bridge_attach**
```c
//把下游的 next_bridge 接到 bridge 链中自己的后面，完成链路串联。
static int lt9611_bridge_attach(struct drm_bridge *bridge,
								enum drm_bridge_attach_flags flags)
{
	struct lt9611 *lt9611 = bridge_to_lt9611(bridge);
	return drm_bridge_attach(bridge->encoder,    //挂到哪个 encoder 上
							lt9611->next_bridge, //挂谁（新成员）
				 			bridge, //挂在谁后面
							flags); //用什么规则挂
}
```

**lt9611_bridge_hpd_enable**
```c
//作用：清掉 HPD 中断屏蔽位并清中断标志，之后 HDMI 线插拔才会产生中断。
static void lt9611_bridge_hpd_enable(struct drm_bridge *bridge)
{
	struct lt9611 *lt9611 = bridge_to_lt9611(bridge);

	lt9611_enable_hpd_interrupts(lt9611);
}
```

**lt9611_bridge_detect**
```c
//作用：读寄存器 0x825e 判断 HDMI 是否接上，并把结果缓存进 lt9611->status。
static enum drm_connector_status lt9611_bridge_detect(struct drm_bridge *bridge)
{
	struct lt9611 *lt9611 = bridge_to_lt9611(bridge);
	unsigned int reg_val = 0;
	int connected = 0;

	regmap_read(lt9611->regmap, 0x825e, &reg_val);   //0x825e：HPD 状态寄存器
	connected = (reg_val & (BIT(2) | BIT(0)));       //BIT0/BIT2 任一置位即认为已连接

	lt9611->status = connected ? connector_status_connected :
				     connector_status_disconnected;

	return lt9611->status;
}
```

**lt9611_bridge_edid_read**
```c
//作用：先确保芯片上电（读 EDID 要走 DDC 通道），再按自定义回调逐块读出 EDID。
static const struct drm_edid *
lt9611_bridge_edid_read(struct drm_bridge *bridge,
			struct drm_connector *connector)
{
	struct lt9611 *lt9611 = bridge_to_lt9611(bridge);

	lt9611_power_on(lt9611);   //读 EDID 需要芯片上电、DDC 通路可用

	return drm_edid_read_custom(connector, lt9611_get_edid_block, lt9611);
	//drm_edid_read_custom：读法自己实现，具体读哪一段由 lt9611_get_edid_block 决定
}
```

> `lt9611_get_edid_block()` 只支持 1 个扩展块（`block > 1` 直接返回 `-EINVAL`），且 block 0 时才真正触发 `lt9611_read_edid()` 把数据搬进 `lt9611->edid_buf`，后续块从缓存里 `memcpy` 返回。

**lt9611_bridge_mode_valid**
```c
//作用：把 LT9611 跑不动的时序过滤掉。
static enum drm_mode_status lt9611_bridge_mode_valid(struct drm_bridge *bridge,
						     const struct drm_display_info *info,
						     const struct drm_display_mode *mode)
{
	struct lt9611 *lt9611 = bridge_to_lt9611(bridge);

	if (mode->hdisplay > 3840)              //水平超过 3840
		return MODE_BAD_HVALUE;
	if (mode->vdisplay > 2160)              //垂直超过 2160
		return MODE_BAD_VVALUE;
	if (mode->hdisplay == 3840 && mode->vdisplay == 2160 &&
	    drm_mode_vrefresh(mode) > 30)       //4K 只到 30Hz（HDMI 1.4 带宽限制）
		return MODE_CLOCK_HIGH;
	if (mode->hdisplay > 2000 && !lt9611->dsi1_node)
		return MODE_PANEL;                  //超过 2000 像素必须双 DSI 拼接，单 DSI 带不动
	else
		return MODE_OK;
}
```

**状态管理的三个默认实现：**

这三个回调都直接指向 `drm_atomic_helper_*` 的通用实现：

**lt9611_atomic_get_input_bus_fmts**
```c
//作用：声明"我只接受 DSI 侧的 RGB888（每像素 24bit）这一种输入格式"，让上游按这个格式准备像素流。
#define MAX_INPUT_SEL_FORMATS	1
static u32 *
lt9611_atomic_get_input_bus_fmts(struct drm_bridge *bridge,
				 struct drm_bridge_state *bridge_state,
				 struct drm_crtc_state *crtc_state,
				 struct drm_connector_state *conn_state,
				 u32 output_fmt,               //输出侧格式（本驱动不看这个参数）
				 unsigned int *num_input_fmts) //出参：告诉框架支持几种输入格式
{
	u32 *input_fmts;

	*num_input_fmts = 0;

	input_fmts = kcalloc(MAX_INPUT_SEL_FORMATS, sizeof(*input_fmts),
			     GFP_KERNEL);   //内存由 DRM 框架负责释放
	if (!input_fmts)
		return NULL;

	/* This is the DSI-end bus format */
	input_fmts[0] = MEDIA_BUS_FMT_RGB888_1X24;   //DSI 输入格式：RGB888
	*num_input_fmts = 1;

	return input_fmts;
}
```

**lt9611_bridge_atomic_pre_enable**
```c
//作用：如果芯片当前处于睡眠态，先用一组寄存器把它唤醒，否则直接返回。
static void lt9611_bridge_atomic_pre_enable(struct drm_bridge *bridge,
					    struct drm_bridge_state *old_bridge_state)
{
	struct lt9611 *lt9611 = bridge_to_lt9611(bridge);
	static const struct reg_sequence reg_cfg[] = {
		{ 0x8102, 0x12 },   //0x8102 由睡眠时的 0x48 改回 0x12：MIPI Rx 退出掉电
		{ 0x8123, 0x40 },
		{ 0x8130, 0xea },
		{ 0x8011, 0xfa },
	};

	if (!lt9611->sleep)   //没睡过就不用唤醒
		return;

	regmap_multi_reg_write(lt9611->regmap, reg_cfg, ARRAY_SIZE(reg_cfg));

	lt9611->sleep = false;
}
```

**lt9611_bridge_atomic_enable**
```c
//作用：从本次 commit 的 state 里取出最终时序，按 DSI 输入 → PLL → 时序 → PCR → 上电 → HDMI PHY → 打开输出的顺序配置整条链路。
static void lt9611_bridge_atomic_enable(struct drm_bridge *bridge,
					struct drm_bridge_state *old_bridge_state)
{
	struct lt9611 *lt9611 = bridge_to_lt9611(bridge);
	struct drm_atomic_state *state = old_bridge_state->base.state;
	struct drm_connector *connector;
	struct drm_connector_state *conn_state;
	struct drm_crtc_state *crtc_state;
	struct drm_display_mode *mode;
	unsigned int postdiv;

	//从 atomic state 反查"挂在同一个 encoder 上的 connector"，再顺着找它的 crtc，
	//这样才能拿到本次要设的时序；任何一环缺失说明 commit 状态不完整，直接返回
	connector = drm_atomic_get_new_connector_for_encoder(state, bridge->encoder);
	if (WARN_ON(!connector))
		return;

	conn_state = drm_atomic_get_new_connector_state(state, connector);
	if (WARN_ON(!conn_state))
		return;

	crtc_state = drm_atomic_get_new_crtc_state(state, conn_state->crtc);
	if (WARN_ON(!crtc_state))
		return;

	mode = &crtc_state->adjusted_mode;   //bridge 用的是调整后的时序

	lt9611_mipi_input_digital(lt9611, mode);    //DSI 输入数字部分：lane 数、数据格式
	lt9611_pll_setup(lt9611, mode, &postdiv);   //按像素时钟算 PLL，并给出 postdiv 分频值
	lt9611_mipi_video_setup(lt9611, mode);      //把 hactive/vactive/前后肩写进芯片
	lt9611_pcr_setup(lt9611, mode, postdiv);    //PCR：像素时钟恢复与分频

	if (lt9611_power_on(lt9611)) {   //HDMI 侧上电：选晶振、IRQ、功耗等寄存器
		dev_err(lt9611->dev, "power on failed\n");
		return;
	}

	lt9611_mipi_input_analog(lt9611);                    //MIPI Rx 模拟部分：偏置、均衡
	lt9611_hdmi_set_infoframes(lt9611, connector, mode); //写 AVI/音频等 InfoFrame
	lt9611_hdmi_tx_digital(lt9611, connector->display_info.is_hdmi); //按对方是 HDMI 还是 DVI 配
	lt9611_hdmi_tx_phy(lt9611);                          //HDMI TMDS PHY 上电、摆幅/预加重

	msleep(500);                    //等链路稳定
	lt9611_video_check(lt9611);     //回读芯片测到的时序，确认视频已进来且数值正确

	/* Enable HDMI output */
	regmap_write(lt9611->regmap, 0x8130, 0xea);   //最后一步：打开 HDMI 输出
}
```

**lt9611_bridge_atomic_disable**
```c
//作用：先关 HDMI 输出，再把芯片断电。
static void lt9611_bridge_atomic_disable(struct drm_bridge *bridge,
					 struct drm_bridge_state *old_bridge_state)
{
	struct lt9611 *lt9611 = bridge_to_lt9611(bridge);
	int ret;

	/* Disable HDMI output */
	ret = regmap_write(lt9611->regmap, 0x8130, 0x6a);   //0x8130 由 0xea 改为 0x6a：关输出
	if (ret) {
		dev_err(lt9611->dev, "video on failed\n");
		return;
	}

	if (lt9611_power_off(lt9611)) {   //内部把 0x8130 再写 0x6a，并清 power_on 标记
		dev_err(lt9611->dev, "power on failed\n");
		return;
	}
}
```

**lt9611_bridge_atomic_post_disable**
```c
//作用：写睡眠寄存器序列让芯片进入省电的睡眠态，并置 lt9611->sleep = true，
//      下次再点屏时由 pre_enable 负责唤醒（与 pre_enable 成对）。
static void lt9611_bridge_atomic_post_disable(struct drm_bridge *bridge,
					      struct drm_bridge_state *old_bridge_state)
{
	struct lt9611 *lt9611 = bridge_to_lt9611(bridge);

	lt9611_sleep_setup(lt9611);
}
```

> `lt9611_sleep_setup()` 里的关键几笔：`0x8102 = 0x48`（MIPI Rx 掉电）、`0x8130 = 0x00`（输出全关）、`0x8011 = 0x0a`（低功耗），写完把 `sleep` 置真。

---

## 五、HDMI 音频通路

音频并不走 DSI 链路：SoC 的 I2S（最多 8 声道）直接接到 LT9611，DTS 里 `lt9611` 节点的 `#sound-dai-cells = <1>` 就是为它准备的。驱动把芯片注册成一个标准的 `hdmi-codec` 平台设备交给 ASoC，播放时由下面这组 ops 把采样率、音频时钟、通路开关写进芯片，音频随 HDMI 数据流一起发出去。

```c
//作用：暴露给 ASoC（hdmi-codec）的 codec 回调
static const struct hdmi_codec_ops lt9611_codec_ops = {
	.hw_params      = lt9611_hdmi_hw_params,      /* 按采样率配音频时钟（48k/96k） */
	.audio_shutdown = lt9611_audio_shutdown,      /* 关音频通路 */
	.audio_startup  = lt9611_audio_startup,       /* 开音频通路与音频时钟 */
	.get_dai_id     = lt9611_hdmi_i2s_get_dai_id, /* 在 DTS 里认出音频端点并返回 DAI id */
};

static struct hdmi_codec_pdata codec_data = {
	.ops = &lt9611_codec_ops,
	.max_i2s_channels = 8,   /* I2S 最多 8 声道 */
	.i2s = 1,                /* 音频走 I2S 接口（另一种可选 SPDIF） */
};

//作用：把 LT9611 注册成 hdmi-codec 平台设备，probe 末尾调用一次
static int lt9611_audio_init(struct device *dev, struct lt9611 *lt9611)
{
	codec_data.data = lt9611;               //回调里的 data 参数就是从这来的

	lt9611->audio_pdev =
		platform_device_register_data(dev, HDMI_CODEC_DRV_NAME,
					      PLATFORM_DEVID_AUTO,   //设备名与 id 交给内核分配
					      &codec_data, sizeof(codec_data));

	return PTR_ERR_OR_ZERO(lt9611->audio_pdev);   //注册失败则 probe 直接失败
}
```

> 注 1：`probe` 里的 `lt9611_audio_init()` 只负责注册设备，音频寄存器要等 ASoC 起流时才写下去 —— 所以 HDMI 插上、屏也亮了，并不代表音频已经就绪。
>
> 注 2：较新的内核把这段换成了 DRM bridge 原生的 HDMI helper（`.hdmi_audio_startup` / `.hdmi_audio_prepare` / `.hdmi_audio_shutdown`，配合 `DRM_BRIDGE_OP_HDMI_AUDIO`），不再注册 `hdmi-codec`，但写的是同一批寄存器。

---