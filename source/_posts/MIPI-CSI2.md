---
title: MIPI-CSI2协议
date: 2026-09-04 12:00:00
tags:
  - MIPI
  - CSI-2
  - Camera
---
> 参考：https://blog.csdn.net/qq_21842097/article/details/116204313

## 〇、物理链路总览

后文所有概念（包、DT、LP/HS、时序）都运行在以下链路上。以 IMX219（2-lane）接 RK SoC 为例：

```
[sensor 引脚]                    [SoC 引脚]         方向
CLKP/CLKN  ─────────────────────► MIPI_CLKP/CLKN   时钟 lane(差分线, 源同步)
D0P/D0N    ─────────────────────► MIPI_D0P/D0N     数据 lane0 (差分对)
D1P/D1N    ─────────────────────► MIPI_D1P/D1N     数据 lane1 (差分对)
XVCLK      ◄───────────────────── MCLK             主时钟 24M(SoC 给 sensor)
SCL/SDA    ◄────────────────────► I2C              寄存器配置(双向)
RESET/PWDN ◄───────────────────── GPIO             复位/待机(SoC 控制)
```

注意：
1. **每个 lane 有两种模式**：LP（1.2V 低速，空闲/握手）和 HS（低摆幅差分，真正高速传数据，时钟 lane 持续翻转）
2. **两种时钟别搞反**：XVCLK = SoC 给 sensor 干活用的主时钟（24M）；MIPI CLK lane = sensor 给 SoC 的传输时钟——**方向相反**

> 引脚级完整接线图、LP/HS 时序细节见第四节。

---

## 一、协议层：包的结构

先看 CSI-2 的分层，理解"包"处在哪一层：

| 层 | 职责 |
|---|---|
| 应用层 | sensor 生成像素数据 / SoC 侧 ISP 处理 |
| **协议层** | 把像素打包成包、多数据流交织与重建（本节） |
| 物理层 | D-PHY 电气传输（第四节） |

协议层内部再分 3 个子层：
1. **像素/字节打包层**：像素格式（RAW/YUV/RGB）与字节流的互转（第二节详述）
2. **低级协议 LLP（Low Level Protocol）**：定义 SoT 与 EoT 之间、以字节为最小单元的包格式——长短包、包头、CRC/ECC 都在这一层（本节主体）
3. **Lane 管理层**：多 lane 时字节流的分发（发送端）与合并（接收端）（见 1.5）

**包（Packet）是 CSI-2 的基本传输单元**：没有地址总线，所有信息靠包承载，靠包头里的数据类型（DT）区分。每个包由 SoT 开始、EoT 结束，包与包之间是 LP 态或 HS 间隙。

### 1.1 短包 Short Packet（4 字节）

{% asset_img short_packet.png Short Packet Structure %}

- **DI（Data Identifier）**：高 2 bit 是虚通道 VC（见 1.3），低 6 bit 是**数据类型 DT**
- **DT（短包区 0x00~0x0F）**：
  - `0x00~0x03`：同步短包——帧开始 FS / 帧结束 FE / 行开始 LS / 行结束 LE
  - `0x04~0x07`：**通用短包**——在数据流中插入控制信号，如触发快门、控制闪光灯（sensor 按厂商定义）
- **Data**：16-bit 载荷。帧包放**帧号**，行包放**行号**（多数 sensor 不用，填 0）
- **ECC**：单字节纠错码，保护前面 24 bit，能纠正 1 bit 错、检出 2 bit 错

短包**没有负载数据，因此也没有 CRC**——4 字节就靠 ECC 保护。

### 1.2 长包 Long Packet（携带像素数据）

{% asset_img long_packet.png Long Packet Structure %}

包 = **SoT + 包头 PH + 负载 + 包尾 PF（仅长包）+ EoT**。各字段：

- **SoT**：Start of Transmission，同步序列 0xB8，D-PHY 层用它在 HS 突发里找包边界
- **包头 PH（4 字节）**：
  - `DI`（Data Identifier，8 bit）：`[VC(2) | DT(6)]`，见 1.1/1.3
  - `WC`（Word Count，16 bit）：**本包负载数据的字节数**（最大 65535）
  - `ECC`（8 bit）：保护整个 4 字节包头（32 bit），纠 1 位检 2 位
- **PF（Packet Footer，仅长包有）**：`CRC-16`（多项式 `x^16 + x^12 + x^5 + 1`），只保护**负载数据**，逐字节计算
- **EoT**：End of Transmission 0x37

> 实用结论：包头（DI/WC）错由 ECC 兜底，负载错由 CRC 兜底——分层防护。抓包看波形时，找 0xB8 起始、0x37 结束即可定位一个包。

**负载长度约束**：WC 必须是**该像素格式最小传输单元**的整数倍。如 YUV422 8bit 每 2 像素共享 1 组 UV（=4 字节），最小包单元就是 2 像素/4 字节，任何行长都是它的整数倍；RAW 格式的约束见第二节对齐规则。

### 1.3 虚通道 VC

虚拟通道的作用是在交织传输的不同数据流中，区分出各个数据流所属的逻辑上的通道。在SOC侧CSI模块处理时，可以根据不同的虚拟通道ID将每个摄像头的数据转发至各自的内存区域。使用场景：
- **多 sensor 共用同一 CSI 口**：多个 sensor 数据经串行器/MUX 后接一个 CSI 接收端，靠 VC 区分来源——如 **MAX9286** 把 4 路同轴相机合并成一路 CSI-2，每路相机独占一个 VC（0~3），解串器在 SoC 端拆成 4 个 v4l2 节点
- **多路数据交错**：同一 sensor 的 RAW 像素 + 嵌入式元数据（embedded data）走不同 VC 同时传，互不阻塞
- **低分辨率叠加**：多 sensor 各占 1~2 lane 拼成一路宽 lane CSI，按 VC 分通道接收。注意 VC 与 DT 是包头 DI 里**两个独立字段**：VC 只管"走哪个通道"，DT 仍是独立的 6 bit、64 种，二者互不影响
- **v1.x 基础能力**：包头 DI = `[VC(2) | DT(6)]`，VC = 0~3，共 4 路
- **v2.0+ VCX 扩展**：包头引入 VCX 字段，与 VC 拼成完整通道号 `[VCX : VC]`——D-PHY 下 VCX 为 2 bit，共 4 bit 通道 ID，0~15 共 16 路；C-PHY 下 VCX 为 3 bit，共 5 bit 通道 ID，最多 32 路
- **前提**：VCX 是可选功能，**sensor 发送端与 CSI host 接收端必须都支持并开启**才生效；没开 VCX 时链路仍是 4 路

{% asset_img vc.png vc Structure %}


RK3588 上 `rkcif` 支持按 VC 拆分为 `rkcif_mipi_lvds*_vir*` 虚拟通道节点，DTS 里每个虚拟节点对应一个 `virtual-channel`：

```dts
&rkcif_mipi_lvds2 {
    status = "okay";
    port {
        rkcif_mipi_lvds2_in: endpoint {
            remote-endpoint = <&mipi2_csi2_output>;
        };
    };
};

&rkcif_mipi_lvds2_sditf {
    status = "okay";
    rockchip,cif-sditf-name = "mipi-csi2";
};
```

### 1.4 数据类型 DT 速查表

DT 用 6 bit，按**值域分大类**（低 4 bit 常是该类的格式变体）：

```
0x00~0x07  短包区（同步 + 通用短包）
0x08~0x0F  保留
0x10~0x17  通用长包区（0x12 = embedded data 元数据行，sensor 常用）
0x18~0x1F  YUV 长包
0x20~0x27  RGB 长包
0x28~0x2F  RAW 长包（RAW6~RAW20）
0x30~0x3F  用户自定义长包（厂商私有，厂商自定义元数据常落此区）
```

常用值：

| DT (hex) | 含义 | V4L2 media bus code 示例 |
|---|---|---|
| 0x00 / 0x01 | 帧开始 FS / 帧结束 FE | - |
| 0x02 / 0x03 | 行开始 LS / 行结束 LE | - |
| 0x04~0x07 | 通用短包（快门/闪光灯等控制） | - |
| 0x12 | embedded data（元数据行，raw 图前几行） | MEDIA_BUS_FMT_METADATA_* |
| 0x18~0x1F | YUV 长包（420/422，具体变体见 sensor 手册） | MEDIA_BUS_FMT_YUYV8_1X16 等 |
| 0x20 | RGB888 | MEDIA_BUS_FMT_RGB888_1X24 |
| 0x28~0x2F | RAW6/7/8/10/12/14/16/20 | MEDIA_BUS_FMT_SRGGB10_1X10 等 |
| 0x30~0x3F | 用户自定义（厂商私有，embedded data 常在此区） | - |

> 驱动层最常用到的映射：`MEDIA_BUS_FMT_SRGGB10_1X10` ↔ DT 0x2B（RAW10）。协议字段里的 Bayer 顺序**不影响 DT**——RAW10 就是 RAW10，Bayer 排列是 sensor 里读出的物理顺序，由 V4L2 bus code 单独表达。

### 1.5 多 Lane 分发（Lane Management）

CSI-2 用 N 条数据 lane 并行传输，**发送端内部的Lane Distribution Function（LDF）把包内字节轮流分发到各 lane，接收端的Lane Merging Function（LMF）再按同样规则合并**。

以 2-lane 为例：
```
包字节流:  B0 B1 B2 B3 B4 B5 B6 B7 ...
            │  │  │  │  │  │  │  │
lane0:    B0    B2    B4    B6       
lane1:       B1    B3    B5    B7    
```

要点：

- **分发单位是字节**，不是 bit/像素——所以接收端把 N 条 lane 的字节交替拼接即可还原原始包，与 DT 无关
- **每条 lane 内连续发自己那份字节**（上图竖向看是流水式，实际实现是"轮转取字节送到对应 lane 的 HS 突发"），lane 之间没有额外对齐开销
- **行尾收尾**：一行字节数若不是 N 的整数倍，比如 M 个字节，而 M % N = R（R为余数），那么在最后一个传输周期（时钟周期）里，只有前 R 条Lane上有有效数据，剩下的 N - R 条Lane没有任何字节需要发送，**LDF把有数据的Lane正常发送，没有数据的 lane 置为 Invalid Data（在D-PHY物理层通常表现为HS-0状态）**。做完这一拍后，所有Lane（包括有数据的）同步直接进入EoT（End of Transmission）状态，即切换到低功耗状态（LP-11）
- 因此算带宽/时序时，行长必须是**字节级**的，且 WC 不因多 lane 而变（WC 是包内总字节数）

> 驱动侧几乎不用管分发细节——CSI host 控制器自动做分发/合并。真正要关心的是 `data-lanes` 声明了几对数据线（决定速率上限），以及 sensor 配置的行字节数尽量对齐 lane 数（减小 Invalid Data 占比）。

---

## 二、RAW 打包格式（最容易算错的地方）

sensor 内部 ADC 是 N bit，但 MIPI 是 8 bit 字节流，所以 N bit 数据要**按位拼装**成字节。这是几乎所有带宽计算出错的根源。

| 格式 | 位数 | 打包规则 | 每像素平均 bit | 对齐 |
|---|---|---|---|---|
| RAW8 | 8 | 1 像素 1 字节 | 8 | 天然对齐 |
| RAW10 | 10 | **4 字节装 3 像素**（32 bit 装 30 bit） | 10.67 | 每 3 像素对齐 |
| RAW12 | 12 | **3 字节装 2 像素**（24 bit 装 24 bit） | 12 | 每 2 像素对齐 |
| RAW14 | 14 | **7 字节装 4 像素**（56 bit 装 56 bit） | 14 | 每 4 像素对齐 |
| RAW16 | 16 | 2 字节装 1 像素 | 16 | 2 字节对齐 |

RAW10 具体排布（3 像素 P1P2P3 → 4 字节 B0B1B2B3）：

```
B0 = P1[9:2]       高 8 位在前
B1 = P2[9:2]
B2 = P3[9:2]
B3 = {P3[1:0], P2[1:0], P1[1:0]}   低 2 位拼在一个字节里
```

RAW12（2 像素 → 3 字节）：
```
B0 = P1[11:4]
B1 = P2[11:4]
B2 = {P2[3:0], P1[3:0]}
```

> **实战含义**：
> 1. 行像素数可能不是打包单位的整数倍，行尾要 **padding 到字节对齐**（sensor 自动处理，但算 WC 时要按整行打包后字节数算）
> 2. 从内存里 dump RAW 图时，不能简单按 `width*2`（RAW10）去解读——要按 4B/3px 拆包，或用 ISP/解包器先转成 unpacked
> 3. 带宽计算必须用**打包后的位数**（见下文第五节），用 10 bit 裸算会虚高 6.25%

---

## 三、帧结构：一帧是怎么拼起来的

典型 sensor（如 IMX219）出流时一帧的包序列：

```
FS(0x00, frame=1)                       <- 帧开始短包
  LS(0x02)  LongPacket(Raw10 行数据)    <- 每行一个长包
  LS(0x02)  LongPacket(...)
  ...
  LE(0x03)                              <- 可选，部分 sensor 不用
FE(0x01, frame=1)                       <- 帧结束短包
```

- 同一帧内每行长包之间的间隔是 **HBlank**（水平消隐），由 D-PHY 的 LP 态或 HS 间隙填充
- 两帧之间是 **VBlank**（垂直消隐）
- **没有独立 VSYNC/HSYNC 线**（对比 DVP 并口），帧/行同步信息就是 FS/FE/LS/LE 短包——这就是 CSI-2 省引脚的原因，也意味着**接收端必须能正确解析短包**，否则整个流都错位

---

## 四、D-PHY 信号与 HS 时序

CSI-2 最常用 D-PHY，1 条差分时钟 lane + 1~4 条差分数据 lane，**双沿采样（DDR）**。高速模式下，每对 lane 都工作在**低电压摆幅的差分状态**，单 lane 数据速率 **80Mbps ~ 1500Mbps**（D-PHY v1.2）。

### 4.1 物理接口：sensor 与 SoC 怎么接线

以 IMX219（2-lane）接到 RK SoC 为例，实际接线：

```
   [sensor 引脚]                 [RK SoC CSI host 端]       流向
   CLKP --------------------------> MIPI_CLKP              
   CLKN --------------------------> MIPI_CLKN   时钟 lane(差分线, 源同步)
   D0P  --------------------------> MIPI_D0P               
   D0N  --------------------------> MIPI_D0N    数据 lane0(差分对)
   D1P  --------------------------> MIPI_D1P               
   D1N  --------------------------> MIPI_D1N    数据 lane1(差分对)
                                                    

   下面是"配置/控制线"，不属于 MIPI，但"点不亮"排障必查。
   和上面 MIPI 线一样，每条横线也是一根真实导线，箭头 = 信号流向：

   [sensor 引脚]                 [SoC 引脚]          流向
   XVCLK  <---------------------- MCLK(输出)           SoC -> sensor: 主时钟 24M
   SCL    <---------------------> I2C_SCL              双向: 寄存器读写
   SDA    <---------------------> I2C_SDA              双向
   RESET  <---------------------- GPIO(输出)           SoC -> sensor: 复位(低有效)
   PWDN   <---------------------- GPIO(输出)           SoC -> sensor: 待机控制


   - 读图: MIPI 差分线(上面 6 行)全是 sensor -> SoC 单向, 时钟 lane 也是(源同步);
     P/N 两根线并行同向走同一信号(电压差表示 0/1), 所以画两行但算 1 个 lane
   - XVCLK 和 MCLK 是同一根线的两个叫法: sensor 侧引脚叫 XVCLK, SoC 侧叫 MCLK
```

要点：

- **lane 数量是物理事实**：模组与 SoC 之间焊了几对数据线就是几 lane。DTS 里 `data-lanes = <1 2>` 只是告诉驱动"第 0、1 对在用"，不会凭空多出硬件没有的 lane
- 时钟 lane 在 HS 期间**持续翻转**，数据 lane 在时钟上下沿各采 1 bit（DDR）——所以数据率 = 时钟频率 x 2
- 差分线要求**成对等长、100Ω 差分阻抗**，FPC/排线过长或阻抗失控是"高速花屏、低速正常"这类怪问题的物理根源
- 一路 CSI 口物理上同一时刻只能有一个 sensor 出流（数据 lane 是共享总线），多 sensor 要么加 MUX 分时、要么换更多路的 CSI 口


### 4.2 状态与切换序列

数据 lane:

| 状态 | Dp/Dn | 用途 |
|---|---|---|
| LP-11 | 1/1 | 空闲（Idle），所有传输的起终点 |
| LP-01 | 0/1 | TX 请求进入 HS / Escape 入口先导 |
| LP-10 | 1/0 | Escape 入口序列用（TX 驱动）；双向 lane 时表示"对端请求" |
| LP-00 | 0/0 | HS 建立序列的过渡态 |
| HS-0 / HS-1 | 差分 | 高速数据传输（低摆幅差分电平 0/1） |


时钟 lane: 与Data Lane一样，Clock Lane也有两种模式，高速传输模式与低功耗模式。

一次 HS 突发（如传一行数据）的完整序列：

```
LP-11 ──①──► LP-01 ──②──► LP-00 ──③──► HS-0(若干UI) ──④──► HS数据 ──⑤──► HS-1(TRAIL) ──⑥──► LP-11

① 从空闲发请求：Dp 拉低(=0)、Dn 保持高(=1)，进入 LP-01
② 两线全 0（LP-00）：预告"马上切 HS"
③ 打开差分驱动，保持 HS-0 若干UI（T_HS_ZERO），等 RX 的 HS 接收器从 LP 切到 HS 并稳定，然后发 SoT 同步码
④ 正式像素数据：SoT 同步码 + 每行一个长包
⑤ 保持 HS-1 一段（T_HS_TRAIL）：防 RX 漏采最后 1bit
⑥ 关差分驱动，回到 LP-11（本行传完，等下个 HS 突发）
```

> **为什么驱动里常说 "要看到 LP-11"**：CSI host 的 clock lane 在没有 HS 时**必须收到稳定的 LP-11** 才算链路 ready。

### 4.3 关键时序参数（D-PHY v1.2 规范值）

| 参数 | 含义 | 典型值 |
|---|---|---|
| UI | 单位间隔 = 1 / (2*link_freq) | @456MHz -> ~1.1ns |
| T_LPX | LP 最小脉冲宽 | 50ns |
| T_HS_PREPARE | LP-00 前的准备时间 | 40ns + 4*UI |
| T_HS_ZERO | HS-0 保持时间 | 105ns + 6*UI |
| T_HS_TRAIL | 数据结束回到 LP 的拖尾 | 60ns + 4*UI |
| T_HS_EXIT | HS 完全退出时间 | 100ns |
| T_INIT | 上电初始化 | 100us |
| T_CLK_MISS / T_CLK_SETTLE | 时钟 lane 稳定时间 | 时钟速率相关 |

**UI（单位间隔）是什么**：UI = 传 1 bit 所需时间 = `1 / (2 * link_freq)`（DDR 双沿采样，每时钟周期传 2 bit，故除以 2）。@456MHz 时 `UI ≈ 1.1ns`。

这些参数是 **D-PHY controller（CSI host）负责生成的**，sensor 侧按 datasheet 配置自己的 PHY 与之匹配。**常见不匹配症状**：

- 速率配太高超过 PHY 能力 -> HS 误码、丢 SoT -> 画面花屏/丢帧
- 线长/阻抗不匹配 -> T_HS_SETTLE 不够 -> 首字节错位，整帧错乱

---

## 五、带宽与时序计算

衔接 imx219 文章的公式，这里给出**通用版**：

### 5.1 像素率、链路速率、带宽约束

```
像素率  pixel_rate = 每帧像素总数 * 帧率 = (HTS * VTS) * fps

单 lane 数据速率(bit/s)  = link_freq * 2(DDR)
链路总带宽(bit/s)       = link_freq * 2 * lanes

约束：链路总带宽 >= 像素率 * 每像素打包后位数
      即 link_freq * 2 * lanes >= pixel_rate * bpp_packed
```

> RAW10 的 `bpp_packed = 10.67`（不是 10！），RAW8 才是 8。用裸位数算会出现"明明算够却丢帧"的假象。

### 5.2 从需求反推 link_freq 实例

例：1080p30、RAW10、2-lane：

```
pixel_rate  = 2200(HTS) * 1125(VTS) * 30 = 74.25 Mpix/s   <- 含消隐的 HTS/VTS！
实际传感器表里的 HTS/VTS 要大于 1920/1080
每像素 10.67 bit -> 需求带宽 = 74.25M * 10.67 = 792 Mbps
2-lane 单 lane 需 >= 396 Mbps -> 链路(每 lane 时钟) >= 198 MHz DDR
选档：link_freq = 228MHz? 裕量 = 228*2*2 = 912 vs 792 -> 14% 裕量，够用
```

> 常见错误：用有效分辨率 1920*1080 去算像素率，忘了 HTS/VTS 是含消隐的总值。**带宽必须按含消隐的像素率算**，因为 MIPI 在消隐期也要维持时序（虽然空载，但帧时长由 VTS 决定）。

### 5.3 帧率调节的两个旋钮

```
fps = pixel_rate / (HTS * VTS)
```

- 调 **VTS**（vblank 延长）-> 帧率变慢，带宽不变（pixel_rate 是 sensor 内部时钟，改 VTS 不影响 pixel_rate，只影响 fps）
- 调 **pixel_rate**（PLL 倍频）-> 帧率变快，同时必须重新评估 MIPI 带宽是否超限

---

## 六、与 V4L2 / DTS 的对接

### 6.1 sensor 端 DTS 三个关键属性

```dts
&i2c2 {
    imx219: imx219@10 {
        compatible = "sony,imx219";
        reg = <0x10>;
        clocks = <&clk_cam_24m>;          /* XVCLK */
        rockchip,camera-module-name = "...";

        port {
            imx219_out: endpoint {
                remote-endpoint = <&csi2_dphy_input>;   /* 拓扑：往 D-PHY 指 */
                data-lanes = <1 2>;                     /* D-PHY 物理 lane 序 */
                link-freqs = <456000000>;               /* link_freq 候选列表（升序） */
            };
        };
    };
};
```

- `data-lanes`：**序号即物理 lane 编号**。`<1 2>` = 用 lane0、lane1；`<2 1>` = 接线时 lane 交叉，接收端按此重映射。**物理接反但 DTS 写对也能通**——这是排查 lane swap 的切入点
- `link-freqs`：单位 Hz，必须是**升序**，索引与驱动里 `link_freq_menu[]` 一一对应，`v4l2_ctrl_new_int_menu` 的默认 index 指向默认模式用的那档

### 6.2 驱动上报：link_freq / pixel_rate 两个只读 ctrl

```c
/* 从 DTS link-freqs 建菜单，运行时按模式上报 */
imx219_init_controls() {
    link_freq = v4l2_ctrl_new_int_menu(&imx219->ctrl_handler,
                    &imx219_ctrl_ops, V4L2_CID_LINK_FREQ,
                    ARRAY_SIZE(link_freq_menu)-1, 0, link_freq_menu);
    pixel_rate = v4l2_ctrl_new_std(&imx219->ctrl_handler,
                    &imx219_ctrl_ops, V4L2_CID_PIXEL_RATE, 0,
                    INT_MAX, 1, IMX219_DEFAULT_PIXEL_RATE);
}
```

host 端（D-PHY/CSI 驱动）会读这两个值来决定自己的 PHY 分频与时钟配置；**两边不一致 = 链路不通或间歇性丢帧**。改模式时若 pixel_rate/link_freq 变了，必须用 `__v4l2_ctrl_s_ctrl()` 在 `set_pad_format` 里联动更新，否则 host 还在按旧速率收。

### 6.3 media bus code 与协议的对应

`enum_mbus_code` 返回的 `MEDIA_BUS_FMT_SRGGB10_1X10` 同时表达了三件事：

| 字段 | 含义 | 对应协议侧 |
|---|---|---|
| SRGGB | Bayer 排列 | sensor 读出方向（flip 影响） |
| 10 | 位深 | DT = RAW10 (0x2B)，决定打包格式 |
| 1X10 | 每像素占位 | 1 像素 -> 10 bit（打包后线上 10.67） |

flip 后 Bayer 顺序变了，bus code 必须同步改（imx219 文章的 6.8 节讲过枚举随 flip 漂移的坑），但 **DT 永远是 0x2B 不变**——因为 RAW10 就是 RAW10。

### 6.4 整条链路数据流

```
sensor (I2C)
  |  RAW10 over D-PHY 2-lane (data-lanes=<1 2>)
  v
csi2_dphy (D-PHY 接收+重映射 lane)
  v
mipi2_csi2 (CSI-2 controller：解析 SoT/包/CRC/VC)
  v
rkcif (capture：解包->DMA 进内存)   <- 输出到内存的是 unpacked 的
  v
rkcif_mipi_lvds2_sditf / rkisp0_vir0 (v4l2 video 节点)
```

> **解包发生在哪**：多数 SoC（含 RK）的 CSI/capture 控制器内部把 RAW10 解包成 16-bit/像素再 DMA 到内存，所以用户态拿到的 buffer 是**每个像素独立字节**，不是线上打包格式。只有直通抓线上数据的场景才需要自己解包。

---

## 七、调试：症状 -> 排查对照表

| 症状 | 可能原因 | 首查手段 |
|---|---|---|
| 黑屏、CSI 收不到任何帧 | sensor 没进 HS 出流；clock lane 停 LP-11 | test pattern 隔离；看 CSI 状态寄存器；示波器看是否有 HS 突发 |
| 画面花屏/大量丢帧 | link_freq 超 PHY 能力；DDR 带宽不足 | 降档/核对 link-freqs；查 rkcif 错误计数 |
| 图像整帧错位（行/列错乱） | lane swap（物理接线 vs data-lanes） | 核对 DTS data-lanes 与接线 |
| 图像正常但偏色 | Bayer/格式协商错；VC 对错 | 查 bus code、DT；试 test pattern 判链路还是格式 |
| 间歇性首行花屏 | T_HS_SETTLE/TRAIL 时序余量不足 | 加 HS settle 寄存器/改 PHY 配置 |
| 有图像但帧率减半 | VBlank/HTS 配置错；时钟分频错 | 核对 VTS/HTS 与 fps 公式 |
| dmesg 报 CRC/ECC 错误 | 信号完整性问题（线长、阻抗、串扰） | 降速验证；查 PCB 走线 |

### 7.1 RK3588 上快速定位

```bash
# 1. 链路拓扑与格式
media-ctl -p -d /dev/media0

# 2. sensor 出流状态与速率
v4l2-ctl -d /dev/v4l-subdev0 --list-ctrls | grep -E "link_freq|pixel_rate"
v4l2-ctl -d /dev/v4l-subdev0 -c test_pattern=2   # 内置彩条，隔离光学通路

# 3. CSI/capture 错误计数（RK 系列）
cat /sys/kernel/debug/rkcif/mipi_lvds2   # 或 dmesg | grep -i rkcif

# 4. 抓一帧看数据是否解包正确
v4l2-ctl -d /dev/video0 --set-fmt-video=width=1920,height=1080 --stream-mmap --stream-count=1
```

**判断链路 vs 格式的思路**：
1. 先开 sensor 的 test pattern -> 若图像正确，说明 MIPI 链路+解包 OK，问题在格式/光学
2. 出花屏 -> 查 lane/VC/DT/速率
3. 完全黑屏 -> 先确认 LP-11、HS 突发是否存在（示波器/逻辑分析仪），再看 CSI 状态寄存器

---

## 八、面试高频题

> **问**：CSI-2 相比 DVP 并口省了哪些引脚？代价是什么？

省了 VSYNC/HSYNC/时钟/多位数据线，只留差分 lane。代价：帧/行同步要用短包在协议层表达，接收端必须具备完整的包解析状态机；信号完整性要求高（差分、高速）。

> **问**：CSI-2 一个包能传多大？

长包 WC 是 16-bit，数据最多 65535 字节。一行的 RAW 数据通常远小于此，所以每行一个长包没问题；超长行（如大分辨率 RAW 未分包）会超限，需要按行拆分。

> **问**：帧号怎么传？有什么用？

FS/FE 短包的 16-bit Data 里放帧号。接收端可用于检测丢帧（帧号跳变）、多路交错时对齐。

> **问**：CRC 保护范围？包头错怎么办？

CRC 只保护长包数据载荷；包头（DT+WC）用 ECC。1 bit 错 ECC 纠正、2 bit 错检出不纠——接收端通常丢弃该包，所以 CRC 错误往往表现为丢帧/丢行而不是坏像素。

> **问**：4-lane 比 2-lane 带宽翻倍，为什么 sensor 常选 2-lane？

lane 数受 sensor 引脚/封装、SoC 资源、信号完整性（高速 lane 越多布线越难）约束。低分辨率低帧率下 2-lane 足够（IMX219 1080p30 只需 912Mbps，2-lane @456MHz 满载 1824Mbps 还有余量）。

> **问**：RAW10 打包为什么是 4B/3px？直接 2B/1px 不行吗？

2B/1px 浪费 6 bit（每像素 16 bit 槽只装 10 bit），带宽浪费 60%。4B/3px 用 32 bit 装 30 bit，只浪费 2 bit，传输效率 93.75%。

> **问**：多个 sensor 共用一个 CSI 口，怎么区分数据？

用 VC（虚通道）。每个 sensor 配不同 VC，接收端按 VC 分发。前提是这些 sensor 的 lane 数总和不超过 CSI 口 lane 数，且通过 MUX/同总线汇聚。

> **问**：换分辨率/帧率时，MIPI 速率要不要重新协商？

要。链路协商链是：DTS `link-freqs` 列表 -> 驱动 `link_freq` ctrl 菜单 -> host PHY 分频。模式变化后 sensor 上报的 pixel_rate/link_freq 变了，host 必须跟着重配。驱动里常见 bug 就是只改了 sensor 寄存器表，忘了同步 `link_freq`/`pixel_rate` ctrl。
