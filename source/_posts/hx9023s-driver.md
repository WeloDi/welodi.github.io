---
title: hx9023s_driver
date: 2026-08-22 20:00:00
tags: [iio, 驱动开发]
---

## 文档概述

本文档详细分析 Linux 6.12 内核中南京天易合芯（TYHX）HX9023S 电容式接近传感器（SAR）驱动 `drivers/iio/proximity/hx9023s.c` 的架构设计。



---

## 一、传感器工作原理
HX9023S 单芯片最多支持 5 路感应通道，I2C 接口，带 1 个硬件中断脚。

测量原理（电荷式电容检测）：
每路感应电极与地之间本来就有寄生电容；当导体（手指/手掌/人脸，人体可等效为接地的导体）靠近电极时，会与电极形成新的耦合电容，等效于抬高了电极对地的总电容，且靠近距离越近、电容增量越大。芯片对电极施加激励并测量充放电过程，把这个微小电容增量转成数字量，这就是 raw。

内部信号处理链（驱动初始化寄存器序列 hx9023s_reg_init_list[] 配置的正是这条链）：

```
模拟前端/ADC(全量程、OSR、均值、采样/积分时间、抖动)
   → raw（原始测量值）
   → 低通滤波 lp（α 系数可配，滤高频噪声）
   → 基线跟踪 bl（跟踪温漂/湿度/老化等缓慢变化，实现自适应）
   → diff = lp − bl（差分增量，真正反映"是否有物体接近"）
   → 阈值比较 + 去抖计数（near/far 阈值、persistency）
   → PROX_STATUS 状态位 + INT 中断脚上报
```

补充：5 路通道并不每路独占一路硬件——芯片的感应电极（编号 0~4）先经内部 mux 分时接入模拟前端，同一时刻只对一组电极做一次测量，所以 5 路通道是"轮流采样"而非并行。每路通道测单端还是差分，取决于它占用哪（几）个电极：`single-channel = <n>` 表示只测电极 n（另一端悬空），`diff-channels = <p, n>` 表示测电极 p 与 n 之差；通道与电极的对应关系在 DTS 通道子节点中声明（详见 2.2）。
阈值比较在芯片内完成：diff 越过 near/far 阈值并持续够去抖次数后，PROX_STATUS 对应位置位、INT 拉低，通知主机"有人靠近/离开"。

## 二、驱动架构总览

### 2.1 芯片与数据通路

HX9023S 内部对 5 个感应通道（CH0~CH4）做电容测量，DSP 输出四类数据：

| 数据 | 含义 |
|------|------|
| raw | 原始电容测量值 |
| lp | 低通滤波后的值（raw 经一阶低通滤波） |
| bl | 基线值（环境基准，随环境缓慢跟踪） |
| diff | 差值 = lp - bl，接近判定用的有效信号 |

驱动在 IIO 层暴露的是 `diff`（`hx9023s_get_proximity()` 返回 `ch_data[chan].diff`），接近状态（near/far）由芯片内部比较 diff 与阈值得出。


### 2.2 DTS
```c
&i2c0 {
    proximity@2a {
        compatible = "tyhx,hx9023s";
        reg = <0x2a>;
        interrupt-parent = <&pio>;
        interrupts = <16 IRQ_TYPE_EDGE_FALLING>;
        vdd-supply = <&pp1800_prox>;

        #address-cells = <1>;
        #size-cells = <0>;

        channel@0 { reg = <0>; single-channel = <0>; };   /* ch0: 单端测电极0 */
        channel@1 { reg = <1>; single-channel = <1>; };   /* ch1: 单端测电极1 */
        channel@2 { reg = <2>; single-channel = <2>; };
        channel@3 { reg = <3>; diff-channels = <1 0>; };  /* ch3: 差分 1(+) - 0(-) */
        channel@4 { reg = <4>; diff-channels = <2 0>; };
    };
};
```

### 2.3 数据结构

#### 2.3.1 hx9023s_ch_data

```c
struct hx9023s_ch_data {
	s16 raw;    /* 原始数据 */
	s16 lp;     /* 低通滤波数据 */
	s16 bl;     /* 基线数据 */
	s16 diff;   /* lp - bl */
	struct {
		unsigned int near;
		unsigned int far;
	} thres; /* 阈值缓存 */

	u16 dac;            /* DAC 偏移补偿值(每次采样从 OFFSET_DAC 读回) */
	u8 channel_positive;/* 正极引脚（DTS 配置） */
	u8 channel_negative;/* 负极引脚（DTS 配置）*/

	/* 数据多路器(mux)输出选择, 决定读回的数据应解释为 raw 还是 bl、
	 * lp 还是 diff(由 hx9023s_data_select() 从芯片寄存器同步) */
	bool sel_bl;
	bool sel_raw;
	bool sel_diff;
	bool sel_lp;
	
	bool enable;        /* 硬件通道使能状态 */
};
```

#### 2.3.2 hx9023s_data

```c
struct hx9023s_data {
	struct iio_trigger *trig;     /*iio系统专用触发器*/
	struct regmap *regmap;

	/*以下5个表示通道的不同状态，它们各自低 5 位代表5个通道*/
	unsigned long chan_prox_stat; /* 上次接近状态（事件去重用） */
	unsigned long chan_read;      /* 被 buffer 采集的通道位图 */
	unsigned long chan_event;     /* 事件使能的通道位图 */
	unsigned long ch_en_stat;     /* 硬件 CH_NUM_CFG 寄存器镜像 */
	unsigned long chan_in_use;    /* DTS 声明实际使用的通道位图 */
	unsigned int prox_state_reg;  /* PROX_STATUS 寄存器缓存 */
	bool trigger_enabled;

	struct {
		__le16 channels[HX9023S_CH_NUM];	/*小端字节序的 16 位无符号整数*/
		s64 ts __aligned(8);	  			/*8字节对其的时间戳*/
	} buffer; /* 采样数据缓冲区 */

	struct mutex mutex;
	struct hx9023s_ch_data ch_data[HX9023S_CH_NUM];
};
```
> __le16的意义：在编译时启用 sparse 静态字节序检查，避免与普通u16进行赋值运算导致出错


#### 2.3.3 hx9023s_events[]

`struct iio_event_spec` 数组：声明每个通道对外暴露的"阈值事件"契约。经 `HX9023S_CHANNEL` 宏挂到各通道后，IIO core 据此自动生成 sysfs 事件属性（`/sys/bus/iio/devices/iio:deviceX/events/`，如 `in_proximity0_thresh_rising_value`），并把读写分发到 `hx9023s_read_event_val` / `hx9023s_write_event_val` / `hx9023s_read_event_config` / `hx9023s_write_event_config` 四个回调。事件方向语义（RISING=远离、FALLING=接近）与"去抖全通道共享、阈值每通道独立"的规则见 2.3.3 事件规格注释。
```c
static const struct iio_event_spec hx9023s_events[] = {
	{
		.type = IIO_EV_TYPE_THRESH,	/* 事件类型为“阈值事件” */
		.dir = IIO_EV_DIR_RISING,	/* 方向为上升沿, 触发方向:远离 */
		.mask_shared_by_all = BIT(IIO_EV_INFO_PERIOD),	/* 去抖时间: shared_by_all表示所有通道共用同一个值 */
		.mask_separate = BIT(IIO_EV_INFO_VALUE),	/* 阈值: 每通道独立 */
	},
	{
		.type = IIO_EV_TYPE_THRESH, /* 事件类型为“阈值事件” */
		.dir = IIO_EV_DIR_FALLING,	/* 方向为下降沿，触发方向:接近 */
		.mask_shared_by_all = BIT(IIO_EV_INFO_PERIOD),
		.mask_separate = BIT(IIO_EV_INFO_VALUE),
	},
	{
		/* 双向: 无阈值数值, 仅提供 ENABLE 作为该通道事件的总开关，用户可以按通道单独开启/关闭接近检测功能 */
		.type = IIO_EV_TYPE_THRESH, /* 事件类型为“阈值事件” */
		.dir = IIO_EV_DIR_EITHER,	/* 触发方向:双向 */
		.mask_separate = BIT(IIO_EV_INFO_ENABLE), /* ENABLE 表示事件使能/禁用 */
	},
};
```

#### 2.3.4 hx9023s_channels[]

`struct iio_chan_spec` 数组：驱动对外暴露的通道接口总表。5 个数据通道由 `HX9023S_CHANNEL(idx)` 宏展开，每个通道挂载上文的 `hx9023s_events`（事件规格）、声明每通道独立的 `raw` 与全通道共享的 `samp_freq` 属性，并给出触发缓冲中的扫描槽位；末尾的 `IIO_CHAN_SOFT_TIMESTAMP(5)` 是伪通道——不读硬件，只在扫描帧末尾预留 8 字节对齐的时间戳槽位（对应 `data->buffer.ts`）。

```c
#define HX9023S_CHANNEL(idx)					\
{								\
	/* 通道量纲: sysfs 前缀 in_proximity, 事件码 type 段 */	\
	.type = IIO_PROXIMITY,					\
	/* 每通道独立属性 in_proximityN_raw, read_raw 返回该通道 diff */ \
	.info_mask_separate = BIT(IIO_CHAN_INFO_RAW),		\
	/* 支持采样频率读写，且全通道共享 */	\
	.info_mask_shared_by_all = BIT(IIO_CHAN_INFO_SAMP_FREQ),\
	.indexed = 1,						\
	.channel = idx,						\
	.address = 0,						\
	.event_spec = hx9023s_events,				\
	.num_event_specs = ARRAY_SIZE(hx9023s_events),		\

	/*定义该通道在 IIO 触发缓冲（triggered buffer）一帧数据里的"槽位" */ \
	.scan_index = idx,					\
	/* scan_type: buffer 中每样本的位布局(见宏上方注释的端序提醒) */	\
	.scan_type = {						\
		.sign = 's',					\
		.realbits = 16,		  /* 有效位数 */
		.storagebits = 16,	  /* 存储位数	*/
		.endianness = IIO_BE, /* 该通道的样本在 buffer 帧里按"大端序"存放 */
	},
}

static const struct iio_chan_spec hx9023s_channels[] = {
	HX9023S_CHANNEL(0),
	HX9023S_CHANNEL(1),
	HX9023S_CHANNEL(2),
	HX9023S_CHANNEL(3),
	HX9023S_CHANNEL(4),

	/* 伪通道, 不读硬件, 只在扫描帧末尾预留8字节
	   对齐的时间戳槽位(对应 data->buffer.ts) */
	IIO_CHAN_SOFT_TIMESTAMP(5),
};
```
---

## 三、regmap 与寄存器

### 3.1 regmap 配置

上电初始化寄存器序列:
```c
static const struct reg_sequence hx9023s_reg_init_list[] = {
	/* scan period */
	REG_SEQ0(HX9023S_PRF_CFG, 0x17),
	...
	/* disable the data lock */
	REG_SEQ0(HX9023S_DSP_CONFIG_CTRL1, 0x00),
};
```

初始化序列 `hx9023s_reg_init_list`在 probe 中由 `regmap_multi_reg_write()` 一次性下发：

```c
ret = regmap_multi_reg_write(data->regmap, hx9023s_reg_init_list,
			     ARRAY_SIZE(hx9023s_reg_init_list));
```

除此之外，运行时的所有寄存器操作（事件阈值读改写、采样批量读）也全部经由 regmap。而 regmap 需要回答三个问题：**哪些地址允许读 / 哪些允许写 / 哪些不能走缓存**——分别由 rd、wr、volatile 三张 range 表声明，最终在 `regmap_config` 里统一接线：

```c
/* 可读地址白名单 */
static const struct regmap_range hx9023s_rd_reg_ranges[] = {
	regmap_reg_range(HX9023S_GLOBAL_CTRL0, HX9023S_LP_DIFF_CH3_2),
};

/* 可写地址白名单 */
static const struct regmap_range hx9023s_wr_reg_ranges[] = {
	regmap_reg_range(HX9023S_GLOBAL_CTRL0, HX9023S_LP_DIFF_CH3_2),
};

/* volatile：读写均绕过缓存、直访硬件寄存器 */
static const struct regmap_range hx9023s_volatile_reg_ranges[] = {
	regmap_reg_range(HX9023S_CAP_INI_CH4_0, HX9023S_LP_DIFF_CH4_2), /* CH4  数据区 0xB3~0xBA */
	regmap_reg_range(HX9023S_CAP_INI_CH0_0, HX9023S_LP_DIFF_CH3_2), /* CH0~3 数据区 0xE0~0xFF */
	regmap_reg_range(HX9023S_PROX_STATUS, HX9023S_PROX_STATUS),     /* 接近状态   0x6B      */
};

/* 区间数组还需包成 regmap_access_table 才能被 regmap 引用 */
static const struct regmap_access_table hx9023s_rd_regs = {
	.yes_ranges = hx9023s_rd_reg_ranges,
	.n_yes_ranges = ARRAY_SIZE(hx9023s_rd_reg_ranges),
};

static const struct regmap_access_table hx9023s_wr_regs = {
	.yes_ranges = hx9023s_wr_reg_ranges,
	.n_yes_ranges = ARRAY_SIZE(hx9023s_wr_reg_ranges),
};

static const struct regmap_access_table hx9023s_volatile_regs = {
	.yes_ranges = hx9023s_volatile_reg_ranges,
	.n_yes_ranges = ARRAY_SIZE(hx9023s_volatile_reg_ranges),
};

static const struct regmap_config hx9023s_regmap_config = {
	.reg_bits = 8,
	.val_bits = 8,
	.cache_type = REGCACHE_MAPLE,
	.rd_table = &hx9023s_rd_regs,
	.wr_table = &hx9023s_wr_regs,
	.volatile_table = &hx9023s_volatile_regs,
};
```

**rd/wr 白名单**：regmap 每次读写前会校验目标地址是否落在 `yes_ranges` 内，不在则直接拒绝、不发起 I2C 事务。本例两张表都覆盖 0x00~0xFF 全空间，等于不加限制；写成表驱动是内核惯式，也为将来收窄范围留位。

**volatile 与缓存**：`cache_type = REGCACHE_MAPLE` 开启缓存（maple tree，6.5+ 替代旧 rbtree）后，非 volatile 寄存器读回命中缓存，可省 I2C 流量。但**会随时间自动变化的寄存器绝不能缓存**——否则读到的一直是首次访问时的旧值。
缓存还有第三个作用：suspend/resume 后可用 `regcache_sync()` 把缓存整体写回硬件（见第八章电源管理）。

---

## 四、probe 流程

```c
static int hx9023s_probe(struct i2c_client *client) {
	struct device *dev = &client->dev;
	struct iio_dev *indio_dev;
	struct hx9023s_data *data;

	// 一次 kzalloc 分配一整块连续内存:indio_dev = struct iio_dev_opaque + hx9023s_data
	indio_dev = devm_iio_device_alloc(dev, sizeof(*data)); 

	devm_regmap_init_i2c(...)                     // 初始化regmap
	hx9023s_property_get(data)                    // 解析 DTS 通道配置
	devm_regulator_get_enable(dev, "vdd")         // 上电
	hx9023s_id_check(indio_dev)                   // chip_id校验（0x1D）

	// 填充 iio_dev
	indio_dev->channels = hx9023s_channels;
	indio_dev->num_channels = ARRAY_SIZE(hx9023s_channels);
	indio_dev->info = &hx9023s_info;			  //填充ops
	indio_dev->modes = INDIO_DIRECT_MODE;

	i2c_set_clientdata(client, indio_dev);		  //将indio_dev绑定到client->dev.driver_data
	regmap_multi_reg_write(reg_init_list)         // 上电初始化
	hx9023s_ch_cfg(data)                          // 写通道引脚连接
	regcache_sync(data->regmap)                   // 将寄存器缓存中的值同步到硬件设备的物理寄存器
	devm_request_threaded_irq(...)                // 中断
	devm_iio_trigger_alloc/register(...)          // 注册 iio_trigger
	devm_iio_triggered_buffer_setup(...)          // 触发缓冲

	/* 注册到 IIO 子系统: 生成 /sys/bus/iio/devices/iio:deviceX,
	 * 扫 channels/info/masks 建全部 sysfs 属性, 设备自此对用户可见 */
	devm_iio_device_register(...)
};
```

**hx9023s_info**

IIO core 通过四个事件回调访问阈值 / 去抖 / 使能（注册见下方 `struct iio_info`）。sysfs 事件文件进来后，回调内部按"属性类型 + 事件方向"分派到具体读写函数：

```c
hx9023s_read_event_val() / hx9023s_write_event_val()
│
├─ 阈值（thresh_*_value）：按通道 ch；方向映射 RISING→far / FALLING→near
│    read:  hx9023s_get_thres_far() / hx9023s_get_thres_near()
│    write: hx9023s_set_thres_far() / hx9023s_set_thres_near()
│
└─ 去抖（debounce）：不区分通道
     read:  hx9023s_read_far_debounce() / hx9023s_read_near_debounce()
     write: hx9023s_write_far_debounce() / hx9023s_write_near_debounce()

hx9023s_read_event_config() / hx9023s_write_event_config() ── 只认 *_thresh_en 使能位
│
└─ chan_event 位图记录使能状态，使能时经 hx9023s_ch_en() 同步硬件通道
```

```c
/* IIO core 操作回调表 */
static const struct iio_info hx9023s_info = {
	.read_raw = hx9023s_read_raw,	//读取传感器数据/采样频率
	.write_raw = hx9023s_write_raw,	//只用于写采样频率

	/* 读取/设置 接近传感器的事件阈值和消隐时间（防抖）参数*/
	.read_event_value = hx9023s_read_event_val,
	.write_event_value = hx9023s_write_event_val,	

	/* 读/写 某个事件使能状态的回调，对于HX9023S来说，就是读/写通道“阈值事件”的使能状态 */
	.read_event_config = hx9023s_read_event_config, //，
	.write_event_config = hx9023s_write_event_config,
};
```
---

## 五、中断与 iio_trigger

```c
if (client->irq) {
	ret = devm_request_threaded_irq(dev, client->irq,
					hx9023s_irq_handler,
					hx9023s_irq_thread_handler,
					IRQF_ONESHOT,
					"hx9023s_event", indio_dev);

	/* 自建一个 IIO 触发源供 buffer 使用, 名字形如 "hx9023s-dev0" */
	data->trig = devm_iio_trigger_alloc(dev, "%s-dev%d",
						indio_dev->name,
						iio_device_id(indio_dev));

	/* 绑定 hx9023s_trigger_ops (enable/disable 回调) */
	data->trig->ops = &hx9023s_trigger_ops;
	/* 触发源私有数据 = indio_dev: 被触发时 ops 回调里
		* 经 trigger_get_drvdata() 拿回 indio_dev/data */
	iio_trigger_set_drvdata(data->trig, indio_dev);

	/* 触发源登记到 IIO, 用户空间可见 /sys/bus/iio/trigger/ */
	ret = devm_iio_trigger_register(dev, data->trig);
}
```

### 5.1 中断

上半部中，如果trigger_enabled被使能，那么就触发trigger读取数据，并且在中断线程中上报事件。
```c
static irqreturn_t hx9023s_irq_handler(int irq, void *private)
{
	if (data->trigger_enabled) //只有在trigger 绑了 hx9023s-dev0 或 buffer 使能时才是 true
		iio_trigger_poll(data->trig);
	return IRQ_WAKE_THREAD;
}
```

下半部调用 hx9023s_push_events 来上报各个通道的 接近/远离 事件
```c
static irqreturn_t hx9023s_irq_thread_handler(int irq, void *private)
{
	guard(mutex)(&data->mutex); //在函数调用结束后自动释放锁
	hx9023s_push_events(indio_dev);
	return IRQ_HANDLED;
}

static void hx9023s_push_events(struct iio_dev *indio_dev)
{
	struct hx9023s_data *data = iio_priv(indio_dev);
	s64 timestamp = iio_get_time_ns(indio_dev);
	unsigned long prox_changed;
	unsigned int chan;
	int ret;

	ret = hx9023s_sample(data);		//采集一帧数据
	if (ret)
		return;

	ret = hx9023s_get_prox_state(data);		//读取接近状态
	if (ret)
		return;
	
	//找出有变化的并且开了事件上报的通道
	prox_changed = (data->chan_prox_stat ^ data->prox_state_reg) & data->chan_event;

	/* 遍历prox_changed中所有被置为 1 的位，并将此位号赋值给chan（从0开始）*/
	for_each_set_bit(chan, &prox_changed, HX9023S_CH_NUM) {
		unsigned int dir;
		//判断方向
		dir = (data->prox_state_reg & BIT(chan)) ?
			IIO_EV_DIR_FALLING : IIO_EV_DIR_RISING;

		/* 上报事件 
		#define IIO_UNMOD_EVENT_CODE(type, channel, ev_type, dir) \
         (((type) << IIO_EVENT_CODE_TYPE_SHIFT) | \
         ((channel) << IIO_EVENT_CODE_CHAN_SHIFT) | \
         ((ev_type) << IIO_EVENT_CODE_EV_TYPE_SHIFT) | \
         ((dir) << IIO_EVENT_CODE_DIR_SHIFT) | \
         IIO_EVENT_CODE_MASK)
		*/
		iio_push_event(indio_dev,
			       IIO_UNMOD_EVENT_CODE(IIO_PROXIMITY, chan,
						    IIO_EV_TYPE_THRESH, dir),
			       timestamp);
	}
	data->chan_prox_stat = data->prox_state_reg; //更新当前接近状态
}
```


### 5.2 iio_trigger

1. 先注册一个iio触发器
```c
data->trig = devm_iio_trigger_alloc(dev, "%s-dev%d",
						    indio_dev->name,
						    iio_device_id(indio_dev));
```

2. 再绑定触发器的ops, 用于用户空间使能/关闭触发器
```c
static int hx9023s_set_trigger_state(struct iio_trigger *trig, bool state)
{
	struct iio_dev *indio_dev = iio_trigger_get_drvdata(trig);
	struct hx9023s_data *data = iio_priv(indio_dev);

	guard(mutex)(&data->mutex);
	if (state)
		hx9023s_interrupt_enable(data);
	else if (!data->chan_read)
		hx9023s_interrupt_disable(data);
	data->trigger_enabled = state;

	return 0;
}

static const struct iio_trigger_ops hx9023s_trigger_ops = {
	.set_trigger_state = hx9023s_set_trigger_state,
};

...

data->trig->ops = &hx9023s_trigger_ops;
```

使用场景：
```shell
# 设置或清除触发器
echo "hx9023s-dev0" > /sys/bus/iio/devices/iio:device0/trigger/current_trigger
echo "" > /sys/bus/iio/devices/iio:device0/trigger/current_trigger

# 开启/关闭 buffer
echo 1 > /sys/bus/iio/devices/iio:device0/buffer/enable
echo 0 > /sys/bus/iio/devices/iio:device0/buffer/enable
```

3. 将indio_dev数据指针存储到 iio_trigger 的私有数据区中，方便以后通过 trigger_get_drvdata()找回设备数据
```c
iio_trigger_set_drvdata(data->trig, indio_dev);
```

4. 注册iio_trigger，用户空间可见 /sys/bus/iio/devices/triggerX/
```c
devm_iio_trigger_register(dev, data->trig);
```

## 六、数据采样

### 6.1 数据选择（data mux）

读取硬件寄存器中的配置信息，然后设置 data->ch_data[] 中各个通道的选择标志
```c
static int hx9023s_data_select(struct hx9023s_data *data)
{
	int ret;
	unsigned int i, buf;
	unsigned long tmp;

	ret = regmap_read(data->regmap, HX9023S_RAW_BL_RD_CFG, &buf);
	if (ret)
		return ret;

	tmp = buf;
	for (i = 0; i < 4; i++) {
		data->ch_data[i].sel_diff = test_bit(i, &tmp);
		data->ch_data[i].sel_lp = !data->ch_data[i].sel_diff;
		data->ch_data[i].sel_bl = test_bit(i + 4, &tmp);
		data->ch_data[i].sel_raw = !data->ch_data[i].sel_bl;
	}

	ret = regmap_read(data->regmap, HX9023S_INTERRUPT_CFG1, &buf);
	if (ret)
		return ret;

	tmp = buf;
	data->ch_data[4].sel_diff = test_bit(2, &tmp);
	data->ch_data[4].sel_lp = !data->ch_data[4].sel_diff;
	data->ch_data[4].sel_bl = test_bit(3, &tmp);
	data->ch_data[4].sel_raw = !data->ch_data[4].sel_bl;

	return 0;
}
```

### 6.2 hx9023s_sample

根据hx9023s_data_select得到的通道配置情况来读取需要的数据：
```c
hx9023s_data_lock(data, true)      // 锁 DSP，冻结数据输出
hx9023s_data_select(data)          // 选择数据源

// 读取ch0~4的 RAW 和 BL 数据
regmap_bulk_read(data->regmap, HX9023S_LP_DIFF_CH0_0, buf, 12);       
regmap_bulk_read(data->regmap, HX9023S_LP_DIFF_CH4_0, buf + 12, 3);  	

//解析并保存 RAW 和 BL 值
for (i = 0; i < HX9023S_CH_NUM; i++) {
		value = get_unaligned_le16(&buf[i * 3 + 1]);
		data->ch_data[i].lp = 0;
		data->ch_data[i].diff = 0;
		if (data->ch_data[i].sel_lp)
			data->ch_data[i].lp = value;
		if (data->ch_data[i].sel_diff)
			data->ch_data[i].diff = value;
	}

//读取ch0~4的 LP 和 DIFF 数据
ret = regmap_bulk_read(data->regmap, HX9023S_LP_DIFF_CH0_0, buf, 12);
ret = regmap_bulk_read(data->regmap, HX9023S_LP_DIFF_CH4_0, buf + 12, 3);

//解析并保存 LP 和 DIFF 值
for (i = 0; i < HX9023S_CH_NUM; i++) {
		value = get_unaligned_le16(&buf[i * 3 + 1]);
		data->ch_data[i].lp = 0;
		data->ch_data[i].diff = 0;
		if (data->ch_data[i].sel_lp)
			data->ch_data[i].lp = value;
		if (data->ch_data[i].sel_diff)
			data->ch_data[i].diff = value;
	}

//计算 DIFF（如果上一步未直接读取）
for (i = 0; i < HX9023S_CH_NUM; i++) {
	if (data->ch_data[i].sel_lp && data->ch_data[i].sel_bl)
		data->ch_data[i].diff = data->ch_data[i].lp - data->ch_data[i].bl;
}

//读取 DAC 偏移值
regmap_bulk_read(data->regmap, HX9023S_OFFSET_DAC0_7_0, buf, 10);

for (i = 0; i < HX9023S_CH_NUM; i++) {
		value = get_unaligned_le16(&buf[i * 2]);
		value = FIELD_GET(GENMASK(11, 0), value);
		data->ch_data[i].dac = value;
	}
```

---


## 七、数据读取

创建环形缓冲区：
```c
devm_iio_triggered_buffer_setup(dev, indio_dev,
					      iio_pollfunc_store_time,
					      hx9023s_trigger_handler,
					      &hx9023s_buffer_setup_ops);
```
**作用**：
	为 IIO 设备配置一个触发式缓冲区，使传感器的触发器触发时，推送数据到缓冲区，供用户空间通过 /dev/iio:deviceX 读取，简单来说：让传感器支持"连续采样"模式
**参数**:
	iio_pollfunc_store_time: 上半部函数(trigger 踢来时的响应函数)：在此用来**记录时间戳**
	hx9023s_trigger_handler: 下半部函数：实际读取数据并填充缓冲区
	&hx9023s_buffer_setup_ops: 缓冲区操作回调（启用/禁用缓冲时调用）


**hx9023s_trigger_handler**
```c
static irqreturn_t hx9023s_trigger_handler(int irq, void *private)
{
	struct iio_poll_func *pf = private;
	struct iio_dev *indio_dev = pf->indio_dev;
	struct hx9023s_data *data = iio_priv(indio_dev);
	struct device *dev = regmap_get_device(data->regmap);
	unsigned int bit, index, i = 0;
	int ret;

	guard(mutex)(&data->mutex);
	ret = hx9023s_sample(data);

	ret = hx9023s_get_prox_state(data);

	//遍历活跃通道并打包数据
	iio_for_each_active_channel(indio_dev, bit) {
		index = indio_dev->channels[bit].channel;
		data->buffer.channels[i++] = cpu_to_le16(data->ch_data[index].diff);
	}

	// ★ 将数据推入 IIO 核心维护的环形缓冲区，内核会唤醒正在 poll 或 read 的用户进程来读取 ★
	iio_push_to_buffers_with_timestamp(indio_dev, &data->buffer,
					   pf->timestamp);

out:
	//通知 IIO 触发器当前处理已完成
	iio_trigger_notify_done(indio_dev->trig);

	return IRQ_HANDLED;
}
```


**hx9023s_buffer_preenable**
```c
static int hx9023s_buffer_preenable(struct iio_dev *indio_dev)
{
	struct hx9023s_data *data = iio_priv(indio_dev);
	unsigned long channels = 0;
	unsigned int bit;

	guard(mutex)(&data->mutex);
	//遍历活跃通道
	iio_for_each_active_channel(indio_dev, bit)
		__set_bit(indio_dev->channels[bit].channel, &channels);
	//使能激活的缓冲通道和事件通道
	hx9023s_update_chan_en(data, channels, data->chan_event);

	return 0;
}

static int hx9023s_buffer_postdisable(struct iio_dev *indio_dev)
{
	struct hx9023s_data *data = iio_priv(indio_dev);

	guard(mutex)(&data->mutex);
	//缓冲通道全部禁用,事件通道保持不变
	hx9023s_update_chan_en(data, 0, data->chan_event);

	return 0;
}

static const struct iio_buffer_setup_ops hx9023s_buffer_setup_ops = {
	.preenable = hx9023s_buffer_preenable,
	.postdisable = hx9023s_buffer_postdisable,
};
```

触发场景
```shell
# 使能缓冲区（开始采集）
echo 1 > /sys/bus/iio/devices/iio:device0/buffer/enable

# 禁用缓冲区（停止采集）
echo 0 > /sys/bus/iio/devices/iio:device0/buffer/enable
```

---

## 八、电源管理

```c
static int hx9023s_suspend(struct device *dev)
{
	guard(mutex)(&data->mutex);
	hx9023s_interrupt_disable(data);   // 挂起只关中断
	return 0;
}

static int hx9023s_resume(struct device *dev)
{
	guard(mutex)(&data->mutex);
	if (data->trigger_enabled)          // 恢复时按触发状态决定
		hx9023s_interrupt_enable(data);
	return 0;
}
static DEFINE_SIMPLE_DEV_PM_OPS(hx9023s_pm_ops, hx9023s_suspend, hx9023s_resume);
```

- 开关中断只需regmap写配置寄存器

## 九、全链路流程
```c
硬件中断触发
│
▼
hx9023s_irq_handler()
│
├── if (data->trigger_enabled)
│       │
│       └── iio_trigger_poll(data->trig)
│               │
│               ├── 调用 iio_pollfunc_store_time()          ← 记录时间戳
│               │
│               └── 唤醒触发器线程
│
└── return IRQ_WAKE_THREAD                                 ← 唤醒中断线程

═══════════════════════════════════════════════════════════════════════════════

两个线程并发执行：

中断线程:                             		  触发器线程:
hx9023s_irq_thread_handler()                 hx9023s_trigger_handler()
│                                            │
├── hx9023s_push_events()                    ├── hx9023s_sample()
│       │                                    ├── 遍历活跃通道，打包数据
│       └── iio_push_event()                 ├── iio_push_to_buffers_with_timestamp()
│						│
└── return IRQ_HANDLED                       └── return IRQ_HANDLED

═══════════════════════════════════════════════════════════════════════════════

用户空间

read() /dev/iio:device0

├── 事件模式：读到 iio_push_event() 推送的事件
│       └── (通道=0, 方向=RISING, 时间戳)
│
└── 缓冲模式：读到 iio_push_to_buffers_with_timestamp() 推送的数据帧
        └── (ch0_diff, ch2_diff, 时间戳)
```