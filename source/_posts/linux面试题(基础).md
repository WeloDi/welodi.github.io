---
title: Linux BSP 面试题总结（基础篇）
date: 2026-08-05 06:55:10
tags:
  - Linux
  - BSP
  - 面试
  - 驱动开发
  - 嵌入式
---

## 一、C 语言基础

### 1. volatile 关键字详解

**答：**
volatile 告诉编译器：该变量的值可能被「编译器无法预知」的方式改变，每次访问都必须从内存重新读取，禁止优化到寄存器中
```c

// 场景1：硬件寄存器（MMIO）
volatile uint32_t *reg = (volatile uint32_t *)ioremap(0xfec80000, 4);
*reg = 0x01;  // 强制写入硬件
val = *reg;   // 强制从硬件读取

// 场景2：中断中修改的全局变量
volatile int irq_flag = 0;
void interrupt_handler(void) {
    irq_flag = 1;  // 中断中修改
}
while (!irq_flag);  // 主循环必须每次都重新读取

// 场景3：多线程共享变量
volatile int running = 1;
void worker_thread(void) {
    while (running) { /* 工作 */ }
}
```

**典型反例（不加 volatile 的后果）：**
```c
// 假设想让 LED 闪烁
*led_reg = 0x01;
*led_reg = 0x00;
*led_reg = 0x01;
// 编译器优化后可能只执行最后一次赋值！
```

### 2. 内存分区
<img src="内存分区.png" alt="内存分区">

| 区域 | 管理方式 | 生长方向 | 存放内容 |
|------|---------|---------|---------|
| **栈（Stack）** | 编译器自动分配释放，LIFO，速度快 | 高→低 | 局部变量、`const` 局部变量、函数参数/返回值 |
| **堆（Heap）** | 程序员 `malloc`/`free` 管理，速度较慢但自由 | 低→高 | 动态分配的内存，需手动释放否则内存泄漏 |
| **全局区（静态区）** | 编译时确定，程序运行期间存在，可读写 | — | `.data`段：已初始化全局/静态变量；`.bss`段：未初始化（或初始化为0）的全局/静态变量，不占可执行文件空间 |
| **常量区** | 编译时确定，只读 | — | 字符串、数字、`const` 修饰的全局变量 |
| **代码区** | 编译时确定，只读 | — | 程序可执行代码、`#define` 宏可能存放于此 |


### 3. 进程与线程的核心区别与通信方式

| 对比项 | 进程（Process） | 线程（Thread） |
|--------|---------------|---------------|
| **资源拥有** | 独立的地址空间、文件描述符、信号处理 | 共享进程的地址空间和资源 |
| **调度单位** | 进程是资源分配单位 | 线程是 CPU 调度单位 |
| **切换开销** | 大（需要切换页表、刷新 TLB） | 小（共享地址空间，无需切换页表） |
| **通信方式** | 需要 IPC（见下方） | 直接共享全局变量、堆内存 |
| **独立性** | 高，一个进程崩溃不影响其他进程 | 低，一个线程崩溃可能导致整个进程崩溃 |
| **创建开销** | fork() 开销大 | pthread_create() 开销小 |


**进程间通信（IPC）方式：**

| 方式 | 特点 | 使用场景 |
|------|------|---------|
| **无名管道（pipe）** | 单向流，父子进程用 | 简单数据传输 |
| **有名管道（FIFO）** | 无亲缘关系进程也可用 | 不同进程间通信 |
| **信号（signal）** | 异步通知，信息量少 | 通知事件（如 SIGTERM） |
| **共享内存（shm）** | 最快，直接读写内存 | 大批量数据交换 |
| **信号量（semaphore）** | 同步/互斥访问共享资源 | 进程间同步 |
| **消息队列（msgqueue）** | 消息传递，内核管理 | 结构化消息通信 |
| **Socket** | 跨网络通信 | 不同主机间通信 |
| **Netlink** | 内核与用户空间通信 | 内核态与用户态双向通信 |

**内核中的线程：**
- `kthread_create()` / `kthread_run()`：创建内核线程
- 内核线程没有独立的地址空间（mm = NULL），共享内核地址空间
- 内核线程不可切换到用户态

### 4. 链表操作

**答：** 内核中大量使用双向链表（`list_head`），而非自定义链表结构：

```c
// 内核链表结构
struct list_head {
    struct list_head *next, *prev;
};

// 嵌入结构体的方式使用（与内核风格一致）
struct sensor_info {
    int id;
    struct list_head list;  // 链表节点嵌入到结构中
};

// 初始化链表头
LIST_HEAD(sensor_list);

// 添加节点
list_add_tail(&info->list, &sensor_list);  // 尾插

// 遍历
struct sensor_info *pos;
list_for_each_entry(pos, &sensor_list, list) {
    pr_info("sensor id: %d\n", pos->id);
}
```

**设计优点：** `list_head` 内嵌而非外挂，通过 `container_of` 宏从链表节点反推出结构体首地址，避免了为每种数据类型写一套链表操作。

### 5. 常用 C 语言问题

#### 5.1 static 关键字的作用

```c
// 1. 修饰局部变量：生命周期变为整个程序运行期，但作用域不变
void count_calls(void) {
    static int n = 0;  // 只初始化一次，函数返回后值保留
    n++;
    printf("called %d times\n", n);
}

// 2. 修饰全局变量/函数：作用域限定在当前文件（其他文件 extern 不到）
static int internal_var;       // 仅本文件可见
static void helper_func(void); // 仅本文件可见
```

#### 5.2 const 修饰指针


```c
const int *p;       // 指向的内容只读：*p 不可改，p 可改（常量指针 → 常量的指针）
int *const p;       // 指针本身只读：p 不可改，*p 可改（指针常量 → 指针是常量）
const int *const p; // 两者都只读：*p 和 p 都不可改
```

记忆口诀：`const` 在 `*` 左边 → 内容只读；`const` 在 `*` 右边 → 指针只读。


#### 5.3 字节对齐


```c
// 结构体默认对齐：按最大成员对齐，可能有填充（padding）
struct foo {
    char  a;   // 1 byte
               // 3 bytes padding
    int   b;   // 4 bytes
    short c;   // 2 bytes
               // 2 bytes padding → 共 12 bytes
};

// packed：取消对齐，紧凑排列（节省空间，但访问效率降低，某些 CPU 可能异常）
struct foo_packed {
    char  a;
    int   b;
    short c;
} __attribute__((packed));  // 共 7 bytes

// aligned(x)：强制按 x 字节对齐
char buf[64] __attribute__((aligned(16)));  // buf 地址 16 字节对齐
```

**追问：** 为什么需要对齐？未对齐访问在 ARM 上会怎样？


为什么需要对齐：

1. **CPU 硬件要求**：许多 CPU 的 load/store 指令要求地址对齐，否则直接抛硬件异常
2. **性能**：即使 CPU 支持非对齐访问，也需要多次总线操作来拼接数据，比对齐访问慢 2~3 倍
3. **原子性破坏**：跨 cache line（如 4 字节变量横跨两个 64 字节 cache line）时，单次读写变成两次总线操作，无法保证原子性


#### 5.4 大端小端

```c
// 小端（Little Endian）：低字节在低地址（x86、ARM 默认小端）
// 大端（Big Endian）：    高字节在低地址（网络字节序、部分 DSP）

// 判断方法
int is_little_endian(void) {
    int x = 1;
    return *(char *)&x;  // 小端返回 1，大端返回 0
}
```

内核中常用 `__cpu_to_le32()` / `le32_to_cpu()` 系列宏做字节序转换。


### 6. 并发与锁

#### 6.1 什么是死锁？如何避免？

**答：** 两个或多个线程互相等待对方持有的锁，导致全部阻塞。

死锁四个必要条件（缺一不可）：
1. **互斥**：资源只能被一个线程占用
2. **持有并等待**：持有锁的同时等待其他锁
3. **不可剥夺**：已持有的锁不能被强制释放
4. **循环等待**：形成 A 等 B、B 等 C、C 等 A 的环路

```c
// 死锁示例
void thread_a(void) {                void thread_b(void) {
    mutex_lock(&lock1);                 mutex_lock(&lock2);
    mutex_lock(&lock2);  // 等 lock2    mutex_lock(&lock1);  // 等 lock1
    ...                                 ...
    mutex_unlock(&lock2);               mutex_unlock(&lock1);
    mutex_unlock(&lock1);               mutex_unlock(&lock2);
}                                    }
```

**避免方法：**
- 固定加锁顺序（所有线程按相同顺序获取锁）
- 使用 `trylock` + 回退重试
- 减少锁的持有时间
- 使用 lockdep（内核死锁检测工具）辅助排查

#### 6.2 锁的粒度如何权衡？

**答：**

| 粒度 | 优点 | 缺点 |
|------|------|------|
| **粗粒度**（一把大锁） | 实现简单，不易死锁 | 并发度低，性能差 |
| **细粒度**（多把锁，如每个结构体一把） | 并发度高，性能好 | 实现复杂，容易死锁 |

**原则：** 从粗粒度开始，用 profiling（perf、lock_stat）定位锁竞争热点，再对热点做细化。



**注意：** 读写锁本身有开销（维护读者计数），只有在读远多于写时才比 mutex 有优势。`RCU` 在读极多的场景下比读写锁更优。

---

## 二、Linux 内核基础

### 1. 内核态与用户态的区别？如何切换？

**答：**
- 用户态：权限受限，不能直接访问硬件，运行在虚拟地址空间
- 内核态：可以访问所有硬件资源，执行特权指令
- 切换方式：系统调用（`open/read/ioctl`）、异常（缺页异常）、外设中断

**追问：** `copy_from_user` / `copy_to_user` 的作用？为什么需要这两个函数？

### 2. 系统调用流程

```
用户态应用程序
    ↓ 调用 open/read/write/ioctl 等库函数
    ↓ glibc 封装（如 syscall() 或 svc #0 指令）
    ↓ CPU 触发异常/软中断，切换到内核态
    ↓ 内核根据系统调用号（sys_call_table）查找对应处理函数
    ↓ 执行内核函数（如 sys_open / vfs_open）
    ↓ 返回结果，切换回用户态
```

以 ARM64 为例：
```c
// 用户态调用 open()
fd = open("/dev/video0", O_RDWR);

// 内核中：
// 1. SVC #0 触发异常，进入异常向量表 el0_sync
// 2. el0_svc -> el0_svc_handler -> invoke_syscall
// 3. sys_call_table[__NR_openat] 找到 sys_openat
// 4. sys_openat -> do_sys_open -> do_filp_open -> path_openat
// 5. 最终调用文件系统/驱动层的 open 回调
```


### 3. 字符设备驱动框架

**答：** 字符设备是 Linux 驱动中最基础的设备类型，核心四步：

```c
// 1. 分配主次设备号
alloc_chrdev_region(&dev, 0, 1, "mydev");

// 2. 初始化并注册字符设备
cdev_init(&my_cdev, &fops);
cdev_add(&my_cdev, dev, 1);

// 3. 创建设备节点（自动生成 /dev/xxx）
class_create(THIS_MODULE, "myclass");
device_create(cls, NULL, dev, NULL, "mydev");

// 4. 实现 file_operations 结构体
static struct file_operations fops = {
    .owner   = THIS_MODULE,  // 防止模块卸载时 fops 仍在用
    .open    = my_open,
    .read    = my_read,
    .write   = my_write,
    .release = my_release,
};
```

**追问：** `.owner = THIS_MODULE` 的作用？（模块引用计数保护，防止在使用设备时模块被 `rmmod`）



### 4. 内核同步机制

| 机制 | 特点 | 适用场景 |
|------|------|---------|
| 自旋锁（spinlock） | 忙等待，不睡眠 | 中断上下文、短临界区 |
| 信号量（semaphore） | 可睡眠 | 进程上下文、长临界区 |
| 互斥锁（mutex） | 可睡眠，优先级继承 | 进程上下文 |
| 原子操作（atomic_t） | 硬件级别保证 | 简单计数器、标志位 |
| RCU（Read-Copy-Update） | 读无锁 | 读多写少的场景 |
| 完成量（completion） | 同步等待事件 | 异步操作完成通知 |

**追问：** 自旋锁在单核 CPU 上还有效吗？为什么中断里不能用 mutex？

### 5. CPU 时间调度策略

**答：** Linux 内核支持多种调度策略，分为普通调度类和实时调度类：

```
调度策略分类：

  普通进程（非实时）：SCHED_NORMAL（CFS 完全公平调度器）
                      SCHED_BATCH（批处理，吞吐优先）
                      SCHED_IDLE（最低优先级，纯后台）

  实时进程：SCHED_FIFO  （优先级抢占，无时间片，自己放弃或被抢占）
            SCHED_RR    （优先级抢占，有时间片轮转）
            SCHED_DEADLINE（截止时间优先，满足 deadline 要求）
```

**CFS（完全公平调度器）核心原理：**

| 概念 | 说明 |
|------|------|
| **vruntime**（虚拟运行时间） | 每个进程的累积运行时间，按权重归一化 |
| **红黑树（RB-Tree）** | 按 vruntime 排序，左子树 vruntime 小 |
| **挑选原则** | 每次选 vruntime 最小的进程运行（红黑树最左节点） |
| **权重（nice值）** | nice -20 → 权重最大，vruntime 增长慢，获得更多 CPU |
| **调度周期** | 一个周期内所有可运行进程至少运行一次 |
| **最小粒度** | 单次最小运行时间（通常 0.75ms ~ 1ms） |

```
调度决策流程：

  系统定时器中断（tick）
         ↓
  update_curr(): 更新当前进程的 vruntime
         ↓
  check_preempt_tick(): 检查是否需要抢占
         ↓
  pick_next_task(): 从红黑树选择下一个进程
         ↓
  context_switch()
         ↓
  切换到新进程
```

**优先级范围：**

```
nice值范围：-20（最高优先级） ~ +19（最低优先级）
  nice -20  → 权重 88761（几乎抢占所有 CPU）
  nice 0    → 权重 1024
  nice 19   → 权重 15（几乎得不到 CPU）

实时优先级：0 ~ 99（数值越大优先级越高）
  实时进程优先级（0~99）永远高于普通进程（nice -20~+19）
```

**实际面试追问：**
- **CFS 为什么用红黑树而不是其他数据结构？**（增删查 O(log n)，最左节点 O(1)）
- **什么是调度抖动（Jitter）？**（调度延迟的不确定性，实时系统的大敌）
- **Tickless（NO_HZ）模式是什么？**（空闲时不产生定时中断，降低功耗）
- **什么是负载均衡（Load Balance）？**（多核下如何把进程迁移到空闲 CPU）
- **CFS 和 RT 调度类的关系？**（RT 永远优先，可能导致普通进程饥饿）
- **SCHED_FIFO 和 SCHED_RR 的区别？**（FIFO 无限运行直到主动放弃，RR 有时间片轮转）


**追问：** 为什么不能把所有事情都在顶半部完成？（长时间关中断会导致系统响应延迟增大、丢失其他中断）

### 6. 中断下半部的几种机制的区别与适用场景

| 机制 | 实现基础 | 上下文 | 可睡眠 | 并发性 | 典型场景 |
|------|---------|--------|--------|--------|---------|
| **软中断 softirq** | 内核静态分配（`NR_SOFTIRQS` 个），编译时固定 | 中断上下文 | ❌ 不可睡眠 | 同类型可在多核并行执行 | 网络 RX/TX、块设备层、高吞吐场景 |
| **tasklet** | 基于 softirq（`TASKLET_SOFTIRQ` / `HI_SOFTIRQ`） | 中断上下文 | ❌ 不可睡眠 | 同类型串行，不会并行 | 小批量数据传递、GPIO 触发、简单 I2C/SPI 操作 |
| **工作队列 workqueue** | 内核线程（`kworker`） | 进程上下文 | ✅ 可睡眠 | 可并行，系统自动管理 | 需要睡眠的操作（I2C 读写、GPIO 操作、内存分配） |

**选择原则：**
- 需要睡眠 → 必须用 workqueue
- 任务非常轻量、频繁触发 → softirq（如网卡收包）
- 轻量但不需要极致性能 → tasklet（简单，推荐）
- 需要高并发处理 → softirq 或 workqueue + 多 worker

**追问：** `tasklet_schedule()` 和 `tasklet_hi_schedule()` 的区别？`workqueue` 和 `system_wq` 的关系？

---

## 三、内存管理

### 1. 内核空间内存分配

**答：**
| 函数 | 特点 |
|------|------|
| `kmalloc()` | 物理连续，大小有限，最快 |
| `kzalloc()` | kmalloc + 清零 |
| `vmalloc()` | 虚拟连续，物理不连续，适合大内存 |
| `kmap()` | 临时映射高端内存 |
| `ioremap()` | 将物理地址映射到内核虚拟地址空间，用于访问硬件寄存器 |



`GFP_KERNEL` 和 `GFP_ATOMIC` 的使用场景：

| 标志 | 可睡眠 | 适用场景 | 注意事项 |
|------|--------|---------|---------|
| `GFP_KERNEL` | ✅ 是 | 进程上下文（系统调用、工作队列） | 可能睡眠等待内存回收，**禁止**在中断/自旋锁内使用 |
| `GFP_ATOMIC` | ❌ 否 | 中断上下文、软中断、tasklet、自旋锁内 | 不会阻塞，分配失败立即返回 NULL |
