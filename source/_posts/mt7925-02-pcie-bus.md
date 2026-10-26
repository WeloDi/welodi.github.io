---
title: MT7925 驱动学习 02：PCIe 接口与 PCIe 驱动写法
date: 2026-09-13 22:00:00
tags:
  - MT7925
  - PCIe
  - DMA
  - Linux驱动
categories:
  - 无线网络
  - WiFi
---

> 参考：
> [Linux PCI驱动框架分析（一）](https://www.cnblogs.com/LoyenWang/p/14165852.html)
> [Linux PCI驱动框架分析（二）](https://www.cnblogs.com/LoyenWang/p/14209318.html)
> [Linux PCI驱动框架分析（三）](https://www.cnblogs.com/LoyenWang/p/14255906.html)


## 文档概述


涉及的源文件：
| 文件 | 本文引用它的哪部分 |
| --- | --- |
| `mt76/mt7925/pci.c` | `pci_driver` 注册、probe/remove/suspend/resume、`dma_init`、L1/L2 重映射 |
| `mt76/mt7925/pci_mcu.c` | `mt7925e_mcu_init`、PCIe 侧的电源所有权握手 |
| `mt76/mt7925/pci_mac.c` | `mt7925e_tx_prepare_skb`（TXWI 写进 DMA 缓冲） |
| `mt76/mt792x_dma.c` | **中断上半部 / tasklet / NAPI poll**、WFDMA 使能复位、`wpdma_reset` |
| `mt76/mt792x_core.c` | `mt792xe_mcu_{drv,fw}_pmctrl`、固件加载、`get_mac80211_ops` |
| `mt76/dma.c` | 描述符结构、ring 寄存器、`cpu_idx/dma_idx`，TX/RX ring 的实际搬运 |
| `mt76/tx.c` | 一批 skb 入 ring 后统一 `kick` 的位置 |
| `mt76/pci.c` | `mt76_pci_disable_aspm` / `mt76_pci_aspm_supported` |

---

## 一、驱动骨架

标准 PCIe 驱动骨架：
```c
/* ① 设备匹配表：PCI 核心逐项比对 VID:deviceID，命中才调 probe；末尾 { } 是哨兵，不能省 */
static const struct pci_device_id my_drv_id_table[] = {
    { PCI_DEVICE(MY_VENDOR, MY_DEVICE) },
    { },
};

/* ② probe / remove 必须配对；shutdown 通常直接复用 remove（无线设备的标准做法） */
static int  my_drv_probe   (struct pci_dev *pdev, const struct pci_device_id *id) { ... }
static void my_drv_remove  (struct pci_dev *pdev) { ... }
static void my_drv_shutdown(struct pci_dev *pdev) { my_drv_remove(pdev); }

/* ③ 电源管理 ops：suspend / resume 挂在 SIMPLE_DEV_PM_OPS 里 */
static SIMPLE_DEV_PM_OPS(my_drv_pm_ops, my_drv_suspend, my_drv_resume);

/* ④ pci_driver 结构：把 id_table / probe / remove / shutdown / pm 全部挂上 */
static struct pci_driver my_drv_driver = {
    .name      = KBUILD_MODNAME,
    .id_table  = my_drv_id_table,
    .probe     = my_drv_probe,
    .remove    = my_drv_remove,
    .shutdown  = my_drv_shutdown,
    .driver.pm = pm_sleep_ptr(&my_drv_pm_ops),
};
module_pci_driver(my_drv_driver);

/* ⑤ 模块元数据：
 *    MODULE_DEVICE_TABLE  → modinfo 生成 alias:pci:v...，udev 热插拔时自动 modprobe
 *    MODULE_FIRMWARE      → 声明依赖的固件，打包 initramfs 时带上（根分区未挂就要加载）
 */
MODULE_DEVICE_TABLE(pci, my_drv_id_table);
MODULE_FIRMWARE("my_drv_fw.bin");
```

mt7925 的实现：
```c
static const struct pci_device_id mt7925_pci_device_table[] = {
	/* PCI_DEVICE：设备匹配表，PCI 核心枚举总线时逐项比对 VID:deviceID，
	   命中才会调用 mt7925_pci_probe()。*/
	{ PCI_DEVICE(PCI_VENDOR_ID_MEDIATEK, 0x7925),  
	  /* driver_data：匹配成功后随 pci_dev 带进 probe 的私有参数。
	     类型是 unsigned long，这里直接塞 char * 固件名。*/
	  .driver_data = (kernel_ulong_t)MT7925_FIRMWARE_WM },
	{ PCI_DEVICE(PCI_VENDOR_ID_MEDIATEK, 0x0717),
	  .driver_data = (kernel_ulong_t)MT7925_FIRMWARE_WM },
	{ }, 
};

static struct pci_driver mt7925_pci_driver = {
	.name = KBUILD_MODNAME,
	.id_table = mt7925_pci_device_table,
	.probe = mt7925_pci_probe,
	.remove = mt7925_pci_remove,
	.shutdown = mt7925_pci_shutdown,
	.driver.pm = pm_sleep_ptr(&mt7925_pm_ops),
};
module_pci_driver(mt7925_pci_driver);


MODULE_DEVICE_TABLE(pci, mt7925_pci_device_table);
MODULE_FIRMWARE(MT7925_FIRMWARE_WM);
MODULE_FIRMWARE(MT7925_ROM_PATCH);
```

---

## 二、probe

### 2.1 通用 PCIe probe 模板

几乎所有 PCIe 驱动的 probe 都是这套动作，顺序基本固定（**获取 → 使能 → 映射 → DMA 能力 → 中断 → 软件对象 → 向子系统注册**）：

```c
pci_enable_device()        //唤醒设备、分配资源
pci_request_regions()      //声明 BAR 归属（或 pcim_iomap_regions 一步到位）
pci_set_master()           //允许设备做 DMA master
dma_set_mask()             //声明可寻址范围
pci_alloc_irq_vectors()    //MSI/MSI-X 优先，退回 legacy INTx
ioremap(BAR)               //拿到寄存器虚拟地址
<分配私有对象 / 初始化硬件 / 申请 DMA 缓冲>
request_irq()              //中断必须在硬件就绪之后再注册
<向子系统注册 netdev / wiphy / drm_device ...>
```


### 2.2 mt7925_pci_probe

```c
static int mt7925_pci_probe(struct pci_dev *pdev, const struct pci_device_id *id)
{
	/* [1] 启用设备：电源状态拉到D0，打开 BAR 的 MEM/IO 解码 */
	pcim_enable_device(pdev);

	/* [2] 申请 + 映射 BAR0，后续所有 mt76_rr()/mt76_wr() 读写都落在这个映射上 */
	pcim_iomap_regions(pdev, BIT(0), pci_name(pdev));

	/* [3]从设备配置空间 0x04 读取当前 PCI_COMMAND 寄存器，确保 PCI_COMMAND_MEMORY 位打开*/
	pci_read_config_word(pdev, PCI_COMMAND, &cmd);
	if (!(cmd & PCI_COMMAND_MEMORY))
		pci_write_config_word(pdev, PCI_COMMAND, cmd | PCI_COMMAND_MEMORY);

	/* [4] 允许设备做 DMA master */
	pci_set_master(pdev);

	/* [5] 申请 1 个中断向量（MSI/MSI-X 优先，退回 legacy INTx），见第五节 */
	pci_alloc_irq_vectors(pdev, 1, 1, PCI_IRQ_ALL_TYPES);

	/* [6][关键] 声明 DMA引擎只能寻址 4 GB 物理地址空间（32 位总线地址），并让内核验证这个约束 */
	dma_set_mask(&pdev->dev, DMA_BIT_MASK(32));

	/* [7][特有关照] 平台疑似 ASPM 兼容性问题时，按需关闭这条 PCIe 链路的 ASPM */
	if (mt7925_disable_aspm)
		mt76_pci_disable_aspm(pdev);

	/* [8][特有] 复制一份mt7925_ops，并读取固件能力，根据固件能力裁剪出一份 ieee80211_ops，见 2.3 */
	ops = mt792x_get_mac80211_ops(&pdev->dev, &mt7925_ops,
				      (void *)id->driver_data, &features);

	/* [9][特有] 分配私有对象 mt792x_dev，并挂上ieee80211_ops 和 mt76_driver_ops */
	dev = mt76_alloc_device(&pdev->dev, sizeof(*dev), ops, &drv_ops);

	/* [10] drvdata ↔ 私有对象互达的标准手法 */
	pci_set_drvdata(pdev, dev);
	mdev = &dev->mt76;

	/* [11][特有] 总线差异注入点：填 fw_features / hif_ops / irq_map，见 2.3 */
	dev->fw_features = features;
	dev->hif_ops = &mt7925_pcie_ops;
	dev->irq_map = &irq_map;

	/* [12] 把「BAR0 的虚拟地址」和「mt76_bus_ops 」一起装进 mt76_dev */
	mt76_mmio_init(&dev->mt76, pcim_iomap_table(pdev)[0]);

	/* [13] 初始化 tasklet，见第五节 */
	tasklet_init(&mdev->irq_tasklet, mt792x_irq_tasklet, (unsigned long)dev);

	/* [14][特有] PHY 三层互指 */
	dev->phy.dev = dev;  dev->phy.mt76 = &dev->mt76;  dev->mt76.phy.priv = &dev->phy;

	/* [15][关键] 复制一份mt76核心的bus_ops，并替换为7925的 rr/wr/rmw */
	bus_ops = devm_kmemdup(&pdev->dev, dev->mt76.bus, sizeof(*bus_ops), GFP_KERNEL);
	bus_ops->rr = mt7925_rr;
	bus_ops->wr = mt7925_wr;
	bus_ops->rmw = mt7925_rmw;
	dev->mt76.bus = bus_ops;

	/* [16][特有关照] drv_own 握手的等待时间依赖它（ASPM 开着时链路要更久才醒） */
	dev->aspm_supported = mt76_pci_aspm_supported(pdev);

	/* [17][特有] 电源握手第 1 步：把芯片控制权交还给固件 */
	__mt792x_mcu_fw_pmctrl(dev);

	/* [18][特有] 电源握手第 2 步：把芯片控制权从固件手里收回到驱动 */
	__mt792xe_mcu_drv_pmctrl(dev);

	/* [19] 第一次硅片级自检：读 CHIPID / REV，全 0 就说明链路没起来 */
	dev_info(&pdev->dev, "ASIC revision: %04x\n", mt76_rr(dev, MT_HW_REV));

	/* [20][特有] 使能 EMI 休眠保护 */
	mt76_rmw_field(dev, MT_HW_EMI_CTL, MT_HW_EMI_CTL_SLPPROT_EN, 1);

	/* [21][特有] 复位 WiFi 子系统 
	   WFSYS是MTK connac 系列芯片内部的Wi-Fi 硬件子系统:一个独立的电源域/时钟域/复位域，它包含 Wi-Fi 侧的全部硬件：Wi-Fi MCU（N9/WM）、LMAC/UMAC（MAC 硬件）、WFDMA、WTBL、PLE/PSE 等 */
	mt792x_wfsys_reset(dev);

	/* [22] 注册 ISR 之前先把设备侧中断屏蔽干净 */
	mt76_wr(dev, dev->irq_map->host_irq_enable, 0); //关掉 WFDMA 的主机中断：此时中断 handler 还没注册，不能开
	mt76_wr(dev, MT_PCIE_MAC_INT_ENABLE, 0xff);     //打开 PCIe MAC 中断总开关，管的是 PCIe 链路/MAC 侧的硬件事件，可以开

	/* [23] 注册共享中断 */
	devm_request_irq(&pdev->dev, pdev->irq, mt792x_irq_handler,
			 IRQF_SHARED, KBUILD_MODNAME, dev);

	/* [24][特有] DMA初始化：建 DMA ring（TX / RX / MCU 队列 + NAPI），见第四节 */
	mt7925_dma_init(dev);

	/* [25][特有] 交给 init.c：软资源 + 异步 init_work（固件 / MAC / wiphy） */
	return mt7925_register_device(dev);
}
```

### 2.3 内联ops

probe 里内联定义，是理解"PCIe 层到底注入了什么"的关键：

```c
/* 硬件能力描述（TXWI 尺寸、offload 能力、token 数） */
static const struct mt76_driver_ops drv_ops = {
	/* txwi_size = txd size + txp size */
	.txwi_size = MT_TXD_SIZE + sizeof(struct mt76_connac_hw_txp),
	.drv_flags = MT_DRV_TXWI_NO_FREE | MT_DRV_HW_MGMT_TXQ | MT_DRV_AMSDU_OFFLOAD,
	.token_size = MT7925_TOKEN_SIZE,               /* 8192 */
	.tx_prepare_skb = mt7925e_tx_prepare_skb,      /* PCIe 专属：TXWI 写在 DMA 缓冲里 */
	.tx_complete_skb = mt76_connac_tx_complete_skb,
	.rx_check = mt7925_rx_check,
	.rx_skb = mt7925_queue_rx_skb,
	.rx_poll_complete = mt792x_rx_poll_complete,
	.sta_add = mt7925_mac_sta_add,
	.sta_event = mt7925_mac_sta_event,
	.sta_remove = mt7925_mac_sta_remove,
	.update_survey = mt792x_update_channel,
};
/* 总线操作 + MCU 生命周期 */
static const struct mt792x_hif_ops mt7925_pcie_ops = {
	.init_reset = mt7925e_init_reset,      /* = mt792x_wpdma_reset(dev, true) */
	.reset = mt7925e_mac_reset,
	.mcu_init = mt7925e_mcu_init,
	.drv_own = mt792xe_mcu_drv_pmctrl,     /* 驱动向固件要控制权 */
	.fw_own = mt792xe_mcu_fw_pmctrl,       /* 用完还回去 */
};
/* 把"逻辑中断"翻译成这颗芯片的寄存器位 */
static const struct mt792x_irq_map irq_map = {
	.host_irq_enable = MT_WFDMA0_HOST_INT_ENA,
	.tx = {
		.all_complete_mask = MT_INT_TX_DONE_ALL,
		.mcu_complete_mask = MT_INT_TX_DONE_MCU,
	},
	.rx = {
		.data_complete_mask = HOST_RX_DONE_INT_ENA2,   /* MT_RXQ_MAIN（数据帧） */
		.wm_complete_mask   = HOST_RX_DONE_INT_ENA0,   /* MT_RXQ_MCU（MCU 事件） */
	},
};
```

---

## 三、BAR 与寄存器访问

### 3.1 标准做法 vs mt7925

标准做法：`pcim_iomap_regions()` → `pcim_iomap_table(pdev)[0]` → 用 `readl/writel` 直接访问。

mt7925 多一层：它的寄存器空间**不是平坦的**，所以不能让上层直接 mmio，于是把 mt76 的 `bus_ops->rr/wr/rmw` 三个钩子换成自己的：

```c
/* mmio 后端，指向 BAR0 */
mt76_mmio_init(&dev->mt76, pcim_iomap_table(pdev)[0]);

/* 保存原 ops，复制一份再替换三个钩子 */
dev->bus_ops = dev->mt76.bus;
bus_ops = devm_kmemdup(dev->mt76.dev, dev->bus_ops, sizeof(*bus_ops), GFP_KERNEL);
if (!bus_ops) {
	ret = -ENOMEM;
	goto err_free_dev;
}
bus_ops->rr  = mt7925_rr;
bus_ops->wr  = mt7925_wr;
bus_ops->rmw = mt7925_rmw;
dev->mt76.bus = bus_ops;
```

所有 `mt76_rr/wr/rmw()` 都会先过 `__mt7925_reg_addr()` 做地址翻译，再落到真正的 `readl/writel`：
```c
static u32 mt7925_rr(struct mt76_dev *mdev, u32 offset)
{
	struct mt792x_dev *dev = container_of(mdev, struct mt792x_dev, mt76);
	u32 addr = __mt7925_reg_addr(dev, offset);

	return dev->bus_ops->rr(mdev, addr);
}
```

### 3.2 BAR 窗口

驱动代码里写的是**逻辑地址**（如 `0x820c0000` WF_UMAC_TOP），但 PCIe BAR 窗口只暴露有限物理范围，所以每条访问都要选窗口：

```c
static u32 __mt7925_reg_addr(struct mt792x_dev *dev, u32 addr)
{
	static const struct mt76_connac_reg_map fixed_map[] = {
		{ 0x830c0000, 0x000000, 0x0001000 }, /* WF_MCU_BUS_CR_REMAP */
		{ 0x54000000, 0x002000, 0x0001000 }, /* WFDMA PCIE0 MCU DMA0 */
		{ 0x820c0000, 0x008000, 0x0004000 }, /* WF_UMAC_TOP (PLE) */
		{ 0x820e0000, 0x020000, 0x0000400 }, /* WF_LMAC_TOP BN0 (WF_CFG) */
		{ 0x74030000, 0x010000, 0x0001000 }, /* PCIe MAC */
		{ 0x7c000000, 0x0f0000, 0x0010000 }, /* CONN_INFRA */
		...
		{ 0x0, 0x0, 0x0 } /* End */
	};
	int i;

	if (addr < 0x200000)                    /* ① 低地址永久可见 */
		return addr;

	mt7925_reg_remap_restore(dev);          /* 恢复上一次被切走的窗口 */

	for (i = 0; i < ARRAY_SIZE(fixed_map); i++) {
		u32 ofs;
		if (addr < fixed_map[i].phys)
			continue;
		ofs = addr - fixed_map[i].phys;
		if (ofs > fixed_map[i].size)
			continue;
		return fixed_map[i].maps + ofs;     /* ② 固定映射表命中 */
	}

	if ((addr >= 0x18000000 && addr < 0x18c00000) ||
	    (addr >= 0x70000000 && addr < 0x78000000) ||
	    (addr >= 0x7c000000 && addr < 0x7c400000))
		return mt7925_reg_map_l1(dev, addr);    /* ③ L1 */

	return mt7925_reg_map_l2(dev, addr);            /* ④ L2 */
}
```

L1 切换本体：
```c
static u32 mt7925_reg_map_l1(struct mt792x_dev *dev, u32 addr)
{
	u32 offset = FIELD_GET(MT_HIF_REMAP_L1_OFFSET, addr);
	u32 base = FIELD_GET(MT_HIF_REMAP_L1_BASE, addr);

	dev->backup_l1 = dev->bus_ops->rr(&dev->mt76, MT_HIF_REMAP_L1);
	dev->bus_ops->rmw(&dev->mt76, MT_HIF_REMAP_L1, MT_HIF_REMAP_L1_MASK,
			  FIELD_PREP(MT_HIF_REMAP_L1_MASK, base));
	/* use read to push write */
	dev->bus_ops->rr(&dev->mt76, MT_HIF_REMAP_L1);

	return MT_HIF_REMAP_BASE_L1 + offset;
}
```

---

## 四、DMA

### 4.1 DMA结构体 & 初始化链路

DMA 本质上只干两件事：
- 把 `mt76_dev` 里预留的队列槽位一个一个填上。
- 把每个槽位和设备上的一环 ring 绑起来。

先认识一下RX环和TX环：
```shell
硬件（网卡） ──写入──► 内存（RX 缓冲区） ──驱动读取──► 协议栈

协议栈 ──驱动写入──► 内存（TX 缓冲区） ──硬件读取──► 射频
```

**DMA 队列的结构体嵌套关系**

![mt76 DMA 队列：结构体嵌套关系](/images/mt76-struct-relation-map.svg)

**DMA 初始化链路**

<div style="overflow-x:auto; border:1px solid #d8dee4; border-radius:6px; padding:8px; background:#fff;">
  <img src="/images/mt76-dma-user-layout-map.svg" alt="mt76 DMA 队列初始化链路" style="width:1400px; max-width:none;">
</div>


### 4.2 DMA环的建立

**mt7925_dma_init()**
```c
static int mt7925_dma_init(struct mt792x_dev *dev)
{
	int ret;

	mt76_dma_attach(&dev->mt76);                // 挂载通用 DMA: queue_ops = mt76_dma_ops 
	ret = mt792x_dma_disable(dev, true);		// 先关掉 DMA，保证干净状态
	if (ret)
		return ret;

	/* 初始化 TX 队列 */
	//数据发送
	ret = mt76_connac_init_tx_queues(dev->phy.mt76, MT7925_TXQ_BAND0,
					 MT7925_TX_RING_SIZE, MT_TX_RING_BASE, NULL, 0);
	if (ret)
		return ret;

	//命令到固件
	mt76_wr(dev, MT_WFDMA0_TX_RING0_EXT_CTRL, 0x4);   /* command to WM */
	ret = mt76_init_mcu_queue(&dev->mt76, MT_MCUQ_WM, MT7925_TXQ_MCU_WM,
				  MT7925_TX_MCU_RING_SIZE, MT_TX_RING_BASE);
	if (ret)
		return ret;

	//固件下载
	ret = mt76_init_mcu_queue(&dev->mt76, MT_MCUQ_FWDL, MT7925_TXQ_FWDL,
				  MT7925_TX_FWDL_RING_SIZE, MT_TX_RING_BASE);
	if (ret)
		return ret;

	/* 初始化 RX 队列 */
	//固件事件
	ret = mt76_queue_alloc(dev, &dev->mt76.q_rx[MT_RXQ_MCU], MT7925_RXQ_MCU_WM,
			       MT7925_RX_MCU_RING_SIZE, MT_RX_BUF_SIZE, MT_RX_EVENT_RING_BASE);
	if (ret)
		return ret;

	//实际数据
	ret = mt76_queue_alloc(dev, &dev->mt76.q_rx[MT_RXQ_MAIN], MT7925_RXQ_BAND0,
			       MT7925_RX_RING_SIZE, MT_RX_BUF_SIZE, MT_RX_DATA_RING_BASE);
	if (ret)
		return ret;

	ret = mt76_init_queues(dev, mt792x_poll_rx);    //注册 RX NAPI 回调
	if (ret < 0)
		return ret;
	
	/* 注册 TX NAPI 回调并 enable */
	netif_napi_add_tx(dev->mt76.tx_napi_dev, &dev->mt76.tx_napi, mt792x_poll_tx);
	napi_enable(&dev->mt76.tx_napi);

	return mt792x_dma_enable(dev); // 最后打开 DMA 引擎
}
```

**mt76_init_queues** = (dev)->mt76.queue_ops->init = mt76_dma_init
```c
static int
mt76_dma_init(struct mt76_dev *dev,
	      int (*poll)(struct napi_struct *napi, int budget))
{
	struct mt76_dev **priv;
	int i;
	//为RX分配一个虚拟的netdev，作为 NAPI 的“宿主设备”。因为NAPI 必须绑定到一个 struct net_device
	dev->napi_dev = alloc_netdev_dummy(sizeof(struct mt76_dev *));
	if (!dev->napi_dev)
		return -ENOMEM;

	/* napi_dev private data points to mt76_dev parent, so, mt76_dev
	 * can be retrieved given napi_dev
	 */
	priv = netdev_priv(dev->napi_dev);
	*priv = dev;

	//为TX分配一个虚拟的netdev
	dev->tx_napi_dev = alloc_netdev_dummy(sizeof(struct mt76_dev *));
	if (!dev->tx_napi_dev) {
		free_netdev(dev->napi_dev);
		return -ENOMEM;
	}
	priv = netdev_priv(dev->tx_napi_dev);
	*priv = dev;

	//把 napi_dev 的名字设为对应的 wiphy 名字（如 phy0），方便调试时识别
	snprintf(dev->napi_dev->name, sizeof(dev->napi_dev->name), "%s",
		 wiphy_name(dev->hw->wiphy));
	dev->napi_dev->threaded = 1; //表示该 netdev 的 NAPI 使用线程化 NAPI 

	//WED = Wireless Ethernet Dispatch，是 MTK 芯片的硬件加速模块
	//初始化两个 completion，用于 WED 复位流程中等待复位完成的同步
	init_completion(&dev->mmio.wed_reset);
	init_completion(&dev->mmio.wed_reset_complete);

	//遍历所有 RX 队列，为每个RX队列注册一个 NAPI 并使能
	mt76_for_each_q_rx(dev, i) {
		netif_napi_add(dev->napi_dev, &dev->napi[i], poll);//把 dev->napi[i] 注册到 napi_dev，轮询函数为传入的 poll，这个poll在中断章节再讲解
		mt76_dma_rx_fill(dev, &dev->q_rx[i], false);  //*为该 RX 队列预填充 DMA 缓冲区
		napi_enable(&dev->napi[i]);
	}

	return 0;
}
```


**mt76_dma_rx_fill**
这是前期填为RX队列挂载DMA缓冲区的核心（TX 是按需填充，有包要发时才挂上去）
```c
int mt76_dma_rx_fill(struct mt76_dev *dev, struct mt76_queue *q,
		     bool allow_direct)
{
	int len = SKB_WITH_OVERHEAD(q->buf_size);
	int frames = 0;

	if (!q->ndesc)
		return 0;

	spin_lock_bh(&q->lock);

	while (q->queued < q->ndesc - 1) {//为ndesc-1个desc各分配一个buf
		struct mt76_queue_buf qbuf = {};
		enum dma_data_direction dir;
		dma_addr_t addr;
		int offset;
		void *buf = NULL;

		if (mt76_queue_is_wed_rro_ind(q))
			goto done;
		
		//依次查看struct pp_alloc_cache alloc ->  page_pool.ptr_ring看是否有空闲页？直接取：像系统申请一块页并dma映射后返回虚拟地址
		buf = mt76_get_page_pool_buf(q, &offset, q->buf_size);
		if (!buf)
			break;
		
		/* 把buf的虚拟地址转换为dma地址（给硬件用）*/
		addr = page_pool_get_dma_addr(virt_to_head_page(buf)) + offset;
		dir = page_pool_get_dma_dir(q->page_pool); //取 DMA 方向（RX 是 DMA_FROM_DEVICE）
		dma_sync_single_for_device(dev->dma_dev, addr, len, dir);//cache 同步，把缓冲区所有权交给设备

		qbuf.addr = addr + q->buf_offset;
done:
		qbuf.len = len - q->buf_offset;
		qbuf.skip_unmap = false;
		if (mt76_dma_add_rx_buf(dev, q, &qbuf, buf) < 0) {//* 填充q->desc[]和q->entry[]
			mt76_put_page_pool_buf(buf, allow_direct); //如果失败，归还缓冲区
			break;
		}
		frames++;//frames表示成功挂到环上的缓冲区数量
	}

	if (frames || mt76_queue_is_wed_rx(q))
		mt76_dma_kick_queue(dev, q);//通知硬件
	/*  static void mt76_dma_kick_queue(struct mt76_dev *dev, struct mt76_queue *q)
		{
			wmb();//内存屏障，防止 CPU 或编译器重排指令
			Q_WRITE(q, cpu_idx, q->head);//写寄存器通知硬件
		} 
	*/

	spin_unlock_bh(&q->lock);

	return frames;
}
```

---

## 五、中断

### 5.1 中断向量

```c
ret = pci_alloc_irq_vectors(pdev, 1, 1, PCI_IRQ_ALL_TYPES);
参数说明：
- 1: 最小向量数
- 1: 最大向量数
- PCI_IRQ_ALL_TYPES: 允许使用所有中断类型（MSI-X / MSI / Legacy INTx）
```

现代做法是"每队列一个 MSI-X 向量 + 多组 NAPI"。而MT7925 只要 1 个向量，所有 ring 共用一个中断源，靠软件在下半部按状态寄存器分流。原因是：

1. 硬件中断源数量有限，`MT_WFDMA0_HOST_INT_STA` 里一个 bit 代表一类事件；
2. 用 **tasklet + 每 ring 一个 NAPI** 的结构把"分流"从硬件搬到软件，反而更好调试（一个 IRQ、一个 trace 点：`trace_dev_irq`）。

代价：单核上一个 tasklet 串行走完分流，中断潜伏期受 tasklet 调度延迟影响。这也是 MT7925 在高 PPS 场景（小包 flood）里延迟抖动的一个来源。

### 5.2 上半部

```c
irqreturn_t mt792x_irq_handler(int irq, void *dev_instance)
{
	struct mt792x_dev *dev = dev_instance;
	//检查设备是否removed
	if (test_bit(MT76_REMOVED, &dev->mt76.phy.state))
		return IRQ_NONE;
	//关闭设备的中断使能
	mt76_wr(dev, dev->irq_map->host_irq_enable, 0);
	if (!test_bit(MT76_STATE_INITIALIZED, &dev->mphy.state))
		return IRQ_NONE;

	/* 将此task挂到当前CPU的tasklet 链表,然后执行raise_softirq_irqoff(softirq_nr);来触发软中断 */
	tasklet_schedule(&dev->mt76.irq_tasklet); 
	return IRQ_HANDLED;
}
```

### 5.3 下半部（tasklet）
这个 tasklet 在 probe 阶段注册：
```c
tasklet_init(&mdev->irq_tasklet, mt792x_irq_tasklet, (unsigned long)dev);
```

任务：清中断 + 解析中断并分流到 NAPI
```c
void mt792x_irq_tasklet(unsigned long data)   /* ← 上半部 tasklet_schedule() 排进来的那一层 */
{
	struct mt792x_dev *dev = (struct mt792x_dev *)data;
	const struct mt792x_irq_map *irq_map = dev->irq_map;
	u32 intr, mask = 0;
	//再次关闭中断
	mt76_wr(dev, irq_map->host_irq_enable, 0);
	//清除WFDMA0_HOST中断
	intr = mt76_rr(dev, MT_WFDMA0_HOST_INT_STA);
	intr &= dev->mt76.mmio.irqmask;
	mt76_wr(dev, MT_WFDMA0_HOST_INT_STA, intr);
	trace_dev_irq(&dev->mt76, intr, dev->mt76.mmio.irqmask);//调试用

	/* 解析事件类型 */
	mask |= intr & (irq_map->rx.data_complete_mask |
			irq_map->rx.wm_complete_mask |
			irq_map->rx.wm2_complete_mask);
	if (intr & dev->irq_map->tx.mcu_complete_mask)
		mask |= dev->irq_map->tx.mcu_complete_mask;
	
	/*  处理固件软件中断（MCU_CMD） */
	if (intr & MT_INT_MCU_CMD) {
		u32 intr_sw;

		intr_sw = mt76_rr(dev, MT_MCU_CMD);  //读 MT_MCU_CMD 得到固件发来的具体命令
		mt76_wr(dev, MT_MCU_CMD, intr_sw);   // ack MCU2HOST_SW_INT_STA 
		if (intr_sw & MT_MCU_CMD_WAKE_RX_PCIE) {
			mask |= irq_map->rx.data_complete_mask; //重新使能中断（位操作）
			intr |= irq_map->rx.data_complete_mask;
		}
	}

	mt76_set_irq_mask(&dev->mt76, irq_map->host_irq_enable, mask, 0);//重新使能中断

	//按事件调度napi
	if (intr & dev->irq_map->tx.all_complete_mask)//TX 完成，处理已发送的 skb、唤醒发送队列
		napi_schedule(&dev->mt76.tx_napi);
	if (intr & irq_map->rx.wm_complete_mask)
		napi_schedule(&dev->mt76.napi[MT_RXQ_MCU]);//MCU RX完成，收固件消息
	if (intr & irq_map->rx.wm2_complete_mask)
		napi_schedule(&dev->mt76.napi[MT_RXQ_MCU_WA]);//MCU WA RX 完成
	if (intr & irq_map->rx.data_complete_mask)
		napi_schedule(&dev->mt76.napi[MT_RXQ_MAIN]);//主数据 RX 完成，收网络数据包
}
```


### 5.4 NAPI 回调

![mt76 TX 环形队列：tail / dma_idx / head 三指针生命周期](/images/mt76-tx-ring-lifecycle.svg)

TX队列
```c
int mt792x_poll_tx(struct napi_struct *napi, int budget)
{
	struct mt792x_dev *dev;

	dev = container_of(napi, struct mt792x_dev, mt76.tx_napi);
	if (!mt76_connac_pm_ref(&dev->mphy, &dev->pm)) {  //如果设备处于休眠
		napi_complete(napi);						  //结束本次NAPI轮询
		queue_work(dev->mt76.wq, &dev->pm.wake_work); //把唤醒工作排进 dev->mt76.wq
		return 0;
	}
	mt76_connac_tx_cleanup(&dev->mt76); //* 清理已发送完成的 TX 缓冲区
	if (napi_complete(napi))
		mt76_connac_irq_enable(&dev->mt76, dev->irq_map->tx.all_complete_mask); //重新打开 TX 完成中断
	mt76_connac_pm_unref(&dev->mphy, &dev->pm);//释放电源管理引用计数
	return 0;
}

/* mt76_connac_tx_cleanup =  dev->queue_ops->tx_cleanup = mt76_dma_tx_cleanup
正常模式下从 tail 追到硬件 dma_idx，逐个回收描述符（解 DMA 映射、释放 skb、归还 txwi），并动态重读 dma_idx 以尽量多清 */
static void mt76_dma_tx_cleanup(struct mt76_dev *dev, struct mt76_queue *q, bool flush)
{
	struct mt76_queue_entry entry;
	int last;

	if (!q || !q->ndesc)
		return;

	spin_lock_bh(&q->cleanup_lock);
	if (flush)
		last = -1;
	else
		last = Q_READ(q, dma_idx);

	while (q->queued > 0 && q->tail != last) {
		mt76_dma_tx_cleanup_idx(dev, q, q->tail, &entry);
		mt76_queue_tx_complete(dev, q, &entry);

		if (entry.txwi) {
			if (!(dev->drv->drv_flags & MT_DRV_TXWI_NO_FREE))
				mt76_put_txwi(dev, entry.txwi);
		}

		if (!flush && q->tail == last)
			last = Q_READ(q, dma_idx);
	}
	spin_unlock_bh(&q->cleanup_lock);

	if (flush) {
		spin_lock_bh(&q->lock);
		mt76_dma_sync_idx(dev, q);
		mt76_dma_kick_queue(dev, q);
		spin_unlock_bh(&q->lock);
	}

	if (!q->queued)
		wake_up(&dev->tx_wait);
}
```

RX队列
```c
int mt792x_poll_rx(struct napi_struct *napi, int budget)//budget：本次轮询的最大包数
{
	struct mt792x_dev *dev;
	int done;

	dev = mt76_priv(napi->dev);
	if (!mt76_connac_pm_ref(&dev->mphy, &dev->pm)) {  //如果设备处于休眠
		napi_complete(napi);					      //退出轮询状态
		queue_work(dev->mt76.wq, &dev->pm.wake_work); //把唤醒工作排进 dev->mt76.wq
		return 0;
	}
	done = mt76_dma_rx_poll(napi, budget); //* 调用 mt76 通用的 DMA RX 轮询函数
	mt76_connac_pm_unref(&dev->mphy, &dev->pm);
	return done;
}


int mt76_dma_rx_poll(struct napi_struct *napi, int budget)
{
	struct mt76_dev *dev;
	int qid, done = 0, cur;

	dev = mt76_priv(napi->dev);
	qid = napi - dev->napi;

	rcu_read_lock();

	do {
		//从 RX DMA ring 取已填充的 buffer、构造 skb、经 mt76_rx 上送网络栈，cur:本次实际处理多少个包
		cur = mt76_dma_rx_process(dev, &dev->q_rx[qid], budget - done);
		mt76_rx_poll_complete(dev, qid, napi);//把处理完的空 buffer 重新挂回 ring，让硬件能继续收
		done += cur;
	} while (cur && done < budget);

	rcu_read_unlock();

	if (done < budget && napi_complete(napi))
		dev->drv->rx_poll_complete(dev, qid);//重新使能该 RX 队列的中断

	return done;
}
```

---

## 六、PCIe 电源管理

PCIe 无线设备比普通 PCIe 设备多一层复杂度：**MCU 固件也在争这块芯片的控制权**。

### 6.1 控制权争夺

probe 第 17/18 步就是这套握手，运行时每次唤醒/睡眠也要走一遍

```c
int __mt792xe_mcu_drv_pmctrl(struct mt792x_dev *dev)      /* 驱动获取控制权 */
{
	int i, err = 0;

	for (i = 0; i < MT792x_DRV_OWN_RETRY_COUNT; i++) {
		mt76_wr(dev, MT_CONN_ON_LPCTL, PCIE_LPCR_HOST_CLR_OWN);
		if (dev->aspm_supported)
			usleep_range(2000, 3000);       /* ASPM 开着时链路要更久才醒 */
		if (mt76_poll_msec_tick(dev, MT_CONN_ON_LPCTL,
					PCIE_LPCR_HOST_OWN_SYNC, 0, 50, 1))
			break;
	}
	if (i == MT792x_DRV_OWN_RETRY_COUNT) {
		dev_err(dev->mt76.dev, "driver own failed\n");
		err = -EIO;
	}
	return err;
}

int mt792xe_mcu_fw_pmctrl(struct mt792x_dev *dev)         /* 把控制权还回固件 */
{
	...
	for (i = 0; i < MT792x_DRV_OWN_RETRY_COUNT; i++) {
		mt76_wr(dev, MT_CONN_ON_LPCTL, PCIE_LPCR_HOST_SET_OWN);
		if (mt76_poll_msec_tick(dev, MT_CONN_ON_LPCTL,
					PCIE_LPCR_HOST_OWN_SYNC, 4, 50, 1))
			break;
	}
	if (i == MT792x_DRV_OWN_RETRY_COUNT) {
		dev_err(dev->mt76.dev, "firmware own failed\n");
		clear_bit(MT76_STATE_PM, &mphy->state);
		return -EIO;
	}
	...
}
```

```c
  int mt792x_wpdma_reinit_cond(struct mt792x_dev *dev)
  {
  	/* check if the wpdma must be reinitialized */
  	if (mt792x_dma_need_reinit(dev)) {
  		mt76_wr(dev, dev->irq_map->host_irq_enable, 0);
  		mt76_wr(dev, MT_PCIE_MAC_INT_ENABLE, 0x0);
  		err = mt792x_wpdma_reset(dev, false);     /* 复位所有 ring + 重新 dma_enable */
  		if (err) {
  			dev_err(dev->mt76.dev, "wpdma reset failed\n");
  			return err;
  		}
  		mt76_wr(dev, MT_PCIE_MAC_INT_ENABLE, 0xff);
  		pm->stats.lp_wake++;
  	}
  	return 0;
  }
  ```

  通用结论：**设备睡过之后 DMA 引擎的 ring 指针可能失效**，不能假设"起来继续用原来的 ring"。这也是 PCIe 驱动里"恢复流程 ≠ probe 的其中一段"的典型例子。

### 6.2 ASPM

标准做法只有一行 `pci_disable_link_state()`，mt7925 之所以要写几十行，是因为下游设备和它的上游口必须一起关：

```c
void mt76_pci_disable_aspm(struct pci_dev *pdev)
{
	struct pci_dev *parent = pdev->bus->self;      /* 上游桥 */
	u16 aspm_conf, parent_aspm_conf = 0;

	pcie_capability_read_word(pdev, PCI_EXP_LNKCTL, &aspm_conf);
	aspm_conf &= PCI_EXP_LNKCTL_ASPMC;
	if (parent) {
		pcie_capability_read_word(parent, PCI_EXP_LNKCTL, &parent_aspm_conf);
		parent_aspm_conf &= PCI_EXP_LNKCTL_ASPMC;
	}
	if (!aspm_conf && (!parent || !parent_aspm_conf))
		return;                                  /* 已经关了 */

	if (IS_ENABLED(CONFIG_PCIEASPM)) {
		int err;
		err = pci_disable_link_state(pdev, aspm_conf);   /* 优先用内核 API */
		if (!err)
			return;
	}
	/* both device and parent should have the same ASPM setting.
	 * disable ASPM in downstream component first and then upstream. */
	pcie_capability_clear_word(pdev,   PCI_EXP_LNKCTL, aspm_conf);
	if (parent)
		pcie_capability_clear_word(parent, PCI_EXP_LNKCTL, aspm_conf);
}
```


### 6.3 suspend / resume

```c
static int mt7925_pci_suspend(struct device *device)
{
	...
	pm->suspended = true;
	flush_work(&dev->reset_work);
	cancel_delayed_work_sync(&pm->ps_work);
	cancel_work_sync(&pm->wake_work);
	mt7925_roc_abort_sync(dev);                              /* ① 停异步工作 */

	err = mt792x_mcu_drv_pmctrl(dev);                        /* ② 驱动拿回芯片控制权 */
	if (err < 0)
		goto restore_suspend;

	/* always enable deep sleep during suspend to reduce power consumption */
	mt7925_mcu_set_deep_sleep(dev, true);                    /* ③ 允许固件深睡 */
	err = mt76_connac_mcu_set_hif_suspend(mdev, true);       /* ④ 通知固件主机要睡 */
	if (err)
		goto restore_suspend;

	napi_disable(&mdev->tx_napi);                            /* ⑤ 停 NAPI / worker */
	mt76_worker_disable(&mdev->tx_worker);
	mt76_for_each_q_rx(mdev, i) { napi_disable(&mdev->napi[i]); }

	/* wait until dma is idle */
	mt76_poll(dev, MT_WFDMA0_GLO_CFG,
		  MT_WFDMA0_GLO_CFG_TX_DMA_BUSY | MT_WFDMA0_GLO_CFG_RX_DMA_BUSY, 0, 1000);
	/* put dma disabled */
	mt76_clear(dev, MT_WFDMA0_GLO_CFG,
		   MT_WFDMA0_GLO_CFG_TX_DMA_EN | MT_WFDMA0_GLO_CFG_RX_DMA_EN);

	/* disable interrupt */
	mt76_wr(dev, dev->irq_map->host_irq_enable, 0);          /* ⑥ 关设备中断 */
	mt76_wr(dev, MT_WFDMA0_HOST_INT_DIS,
		dev->irq_map->tx.all_complete_mask | MT_INT_RX_DONE_ALL | MT_INT_MCU_CMD);
	mt76_wr(dev, MT_PCIE_MAC_INT_ENABLE, 0x0);
	synchronize_irq(pdev->irq);                              /* ⑦ 等 ISR 真的跑完 */
	tasklet_kill(&mdev->irq_tasklet);                        /* ⑧ 等 tasklet 落地 */

	err = mt792x_mcu_fw_pmctrl(dev);                         /* ⑨ 把芯片交回固件 */
	if (err)
		goto restore_napi;
	return 0;
	...
}
```


**这是 PCIe suspend 的教科书顺序**：

> 停生产者（work/NAPI） → 等 DMA 空闲 → 关 DMA 使能 → 关中断源 → `synchronize_irq()` + `tasklet_kill()` → 再交给电源/固件

少了 `synchronize_irq()` / `tasklet_kill()`，就会出现"刚 resume 就踩到已经释放的 NAPI/队列"的经典崩溃。resume 侧用 `local_bh_disable()` 包住 enable+schedule，则是保证 NAPI 起来那一刻不会被软中断抢占导致顺序错乱。

---

## 七、remove / shutdown

```c
static void mt7925e_unregister_device(struct mt792x_dev *dev)
{
	int i;
	struct mt76_connac_pm *pm = &dev->pm;

	cancel_work_sync(&dev->init_work);                   /* ① 停异步初始化 */
	mt76_unregister_device(&dev->mt76);                  /* ② 从子系统摘掉 netdev/wiphy */
	mt76_for_each_q_rx(&dev->mt76, i)
		napi_disable(&dev->mt76.napi[i]);            /* ③ 停 NAPI */
	cancel_delayed_work_sync(&pm->ps_work);
	cancel_work_sync(&pm->wake_work);
	cancel_work_sync(&dev->reset_work);
	mt7925_tx_token_put(dev);                            /* ④ 归还所有 token */
	__mt792x_mcu_drv_pmctrl(dev);                        /* ⑤ 拿回芯片控制权 */
	mt792x_dma_cleanup(dev);                             /* ⑥ 停 WFDMA + mt76_dma_cleanup */
	mt792x_wfsys_reset(dev);                             /* ⑦ 复位子系统 */
	skb_queue_purge(&dev->mt76.mcu.res_q);
	tasklet_disable(&dev->mt76.irq_tasklet);             /* ⑧ 确保 tasklet 不再跑 */
}

static void mt7925_pci_remove(struct pci_dev *pdev)
{
	struct mt76_dev *mdev = pci_get_drvdata(pdev);
	struct mt792x_dev *dev = container_of(mdev, struct mt792x_dev, mt76);

	mt7925e_unregister_device(dev);
	set_bit(MT76_REMOVED, &mdev->phy.state);              /* ← ISR 从此返回 IRQ_NONE */
	devm_free_irq(&pdev->dev, pdev->irq, dev);
	mt76_free_device(&dev->mt76);
	pci_free_irq_vectors(pdev);
	/* pcim_enable_device / pcim_iomap_regions / devm_kmemdup 由 devres 自动回收 */
}
```

可提炼出的通用卸载顺序：

1. 停掉所有异步/延时工作（`cancel_*_sync`），保证没有人在访问寄存器；
2. 先掐断数据源（unregister → `napi_disable`），让上层不再下发新请求；
3. 释放自己管理的业务资源（这里的 token / MCU 队列）；
4. 设备安静下来之后再拆 DMA 和中断（顺序不要反：先 DMA cleanup，再 free IRQ）；
5. **设置一个"我已死"的状态位**（`MT76_REMOVED`），让可能还在飞行中的 ISR 立刻退出；
6. 最后交给 devres 与 `pci_free_irq_vectors()` 收尾。

> 重点记住 `set_bit(MT76_REMOVED, ...)` 这行：共享 IRQ 下，这个状态位是避免 ISR 与 teardown 并发竞态的唯一手段。没有它就可能出现"ISR 跑在已经释放的 `dev` 上"。

---


## 八、PCIe 相关故障定位

| 现象 | 相关环节 | 排查方向 |
| --- | --- | --- |
| `ASIC revision: 0000` | probe 第 19 步 | BAR 读不出东西 → 链路没 up / 供电复位不对 / ASPM 干扰（先 `disable_aspm=1` 验证） |
| probe 卡在 `pci_alloc_irq_vectors` | probe 第 5 步 | legacy INTx 共享冲突、平台 `pci=nomsi` 之类的启动参数 |
| `driver own failed` | probe 第 18 步 / 运行时唤醒 | `MT_CONN_ON_LPCTL` 轮询超时 → 固件没起来或正忙；ASPM 开着时需要更长等待 |
| `Timeout for initializing firmware` | 固件（第 03 篇） | `/lib/firmware/mediatek/mt7925/` 下 patch / RAM code 缺失 |
| 不收包、中断计数不涨 | 第五节 | 先看 `MT_WFDMA0_HOST_INT_ENA` 有没有被重新打开（`napi_complete` 路径挂了）；再看 RX ring 有没有被 fill 满空 buffer |
| 发不出去但没报错 | token 机制 | token 耗尽会静默阻塞 TX；ring 满才会返回 `-ENOMEM` |
| 吞吐忽高忽低 | 6.1 / 6.2 | WPDMA 频繁 reinit + ASPM L1 反复进出，看 `lp_wake` 计数与 `lspci -vvv` 的 `LnkCtl` |
| suspend 后 resume 崩溃 | 第六节 | 缺 `tasklet_kill` / `synchronize_irq`，或 `wpdma_reinit_cond` 没跑到 |
| rmmod 时 hang / use-after-free | 第七节 | remove 顺序反了（先 free IRQ 再 dma cleanup），或漏了 `MT76_REMOVED` 状态位 |
