---
title: suspend-resume
date: 2026-06-11 14:19:55
tags: 
excerpt: Linux 内核休眠唤醒机制详解，包括 freeze 流程、suspend 流程、resume 流程的完整分析。
---

> 参考
>
> https://www.cnblogs.com/LoyenWang/p/11372679.html
> https://blog.csdn.net/weixin_41028159/article/details/131012793#:~:text=调用
> https://blog.csdn.net/qq_48458789/article/details/136333955



# 总览图

<img src="whiteboard_exported_image.png" alt="whiteboard_exported_image">



# Suspend流程

用户空间执行如下操作，会通过sysfs触发suspend的执行：

```C
echo "freeze" > /sys/power/state
echo "standby" > /sys/power/state
echo "mem" > /sys/power/state
```

相应的处理代码在 /kernel/power/main.c 中：

```c
static ssize_t state_store(struct kobject *kobj, struct kobj_attribute *attr,
               const char *buf, size_t n)
{
    suspend_state_t state;
    int error;

    error = pm_autosleep_lock();
    if (error)
        return error;

    if (pm_autosleep_state() > PM_SUSPEND_ON) {
        error = -EBUSY;
        goto out;
    }

    state = decode_state(buf, n);
    if (state < PM_SUSPEND_MAX) {
        if (state == PM_SUSPEND_MEM)
            state = mem_sleep_current;

        error = pm_suspend(state); //开始处理实际的suspend过程
    } else if (state == PM_SUSPEND_MAX) {
        error = hibernate();
    } else {
        error = -EINVAL;
    }

 out:
    pm_autosleep_unlock();
    return error ? error : n;
}
```



power/suspend.c

```C
int pm_suspend(suspend_state_t state)
{
    int error;

    if (state <= PM_SUSPEND_ON || state >= PM_SUSPEND_MAX)
        return -EINVAL;

    pr_info("suspend entry (%s)\n", mem_sleep_labels[state]);
    error = enter_state(state);
    if (error) {
        suspend_stats.fail++;
        dpm_save_failed_errno(error);
    } else {
        suspend_stats.success++;
        ktime_get_ts64(&suspend_stats.last_success_resume_time);
    }
    pr_info("suspend exit\n");
    return error;
}
static int enter_state(suspend_state_t state)
{
    int error;

    // 跟踪挂起/恢复的事件，记录挂起进入的开始
    trace_suspend_resume(TPS("suspend_enter"), state, true);
    if (state == PM_SUSPEND_TO_IDLE) {
        // 如果配置了PM_DEBUG，并且测试级别不符合挂起到空闲状态的要求
#ifdef CONFIG_PM_DEBUG
        if (pm_test_level != TEST_NONE && pm_test_level <= TEST_CPUS) {
            pr_warn("Unsupported test mode for suspend to idle, please choose none/freezer/devices/platform.\n");
            return -EAGAIN; // 返回错误码，表示现在不合适执行挂起操作
        }
#endif
    } else if (!valid_state(state)) {
        return -EINVAL;
    }
    // 尝试获取系统转换互斥锁，如果失败则返回忙错误
    if (!mutex_trylock(&system_transition_mutex))
        return -EBUSY;

    if (state == PM_SUSPEND_TO_IDLE)
        s2idle_begin(); // 开始挂起到空闲状态的流程

    // 如果启用了挂起时的文件系统同步
    if (sync_on_suspend_enabled) {
        // 跟踪挂起/恢复的事件，记录文件系统同步的开始
        trace_suspend_resume(TPS("sync_filesystems"), 0, true);
        ksys_sync_helper(); // 同步文件系统
        trace_suspend_resume(TPS("sync_filesystems"), 0, false); // 记录文件系统同步的结束
    }

    // 打印调试信息，准备系统进入睡眠状态
    pm_pr_dbg("Preparing system for sleep (%s)\n", mem_sleep_labels[state]);
    // 清除那些可能在上一次挂起尝试中设置的标志。确保下一次挂起尝试不会受到之前状态的影响
    pm_suspend_clear_flags(); 
    error = suspend_prepare(state); // 准备挂起，涉及保存状态等操作
    if (error)
        goto Unlock;

    // 如果设置了冻结测试，跳转到Finish标签处
    if (suspend_test(TEST_FREEZER))
        goto Finish;

    // 跟踪挂起/恢复的事件，记录挂起进入的结束
    trace_suspend_resume(TPS("suspend_enter"), state, false);
    pm_pr_dbg("Suspending system (%s)\n", mem_sleep_labels[state]);
    pm_restrict_gfp_mask(); // 限制内存分配掩码
    error = suspend_devices_and_enter(state); // 挂起设备并进入指定状态
    pm_restore_gfp_mask(); // 恢复内存分配掩码

Finish:
    events_check_enabled = false; // 禁用事件检查
    pm_pr_dbg("Finishing wakeup.\n"); // 打印调试信息，完成唤醒过程
    suspend_finish(); // 完成挂起后的收尾工作
Unlock:
    mutex_unlock(&system_transition_mutex); // 释放系统转换互斥锁
    return error; // 返回操作结果，0表示成功，非0表示错误码
}
```

进入到suspend_prepare()中以后，它会给suspend分配一个虚拟终端来输出信息，然后广播一个系统要进入suspend的Notify，关闭掉用户态的helper进程，然后依次调用suspend_freeze_processes()冻结所有的进程，这里会保存所有进程当前的状态，也许有一些进程会拒绝进入冻结状态，当有这样的进程存在的时候， 会导致冻结失败，此函数就会放弃冻结进程，并且解冻刚才冻结的所有进程。

```C
static int suspend_prepare(suspend_state_t state)
{
        int error;

        // 检查suspend_ops是否有提供.enter回调，该回调会在后面使用到
        if (!sleep_state_supported(state))
                return -EPERM;

        // 将当前console切换到一个虚拟console。
        pm_prepare_console();

        // 调用电源管理通知链，通知所有注册的监听者系统即将挂起
        error = pm_notifier_call_chain_robust(PM_SUSPEND_PREPARE, PM_POST_SUSPEND);
        if (error)
                goto Restore;

        // 开始跟踪挂起/恢复过程，标记冻结进程的开始
        trace_suspend_resume(TPS("freeze_processes"), 0, true);
        // 尝试冻结所有进程，以准备挂起
        error = suspend_freeze_processes();
        // 标记冻结进程的结束
        trace_suspend_resume(TPS("freeze_processes"), 0, false);
        if (!error)
                return 0; // 如果冻结成功，返回 0 表示成功

        // 如果冻结失败，记录失败原因并更新挂起统计信息
        log_suspend_abort_reason("One or more tasks refusing to freeze");
        suspend_stats.failed_freeze++;
        dpm_save_failed_step(SUSPEND_FREEZE);
        // 再次调用通知链，通知挂起准备失败
        pm_notifier_call_chain(PM_POST_SUSPEND);

Restore:
        // 恢复控制台到之前的状态
        pm_restore_console();
        return error; // 返回错误码
}
static inline int suspend_freeze_processes(void)
{
    int error;

    error = freeze_processes();

    if (error)
        return error;

    error = freeze_kernel_threads();

    if (error)
        thaw_processes();

    return error;
}
```

此时开始休眠所有外设，当所有的设备休眠以后， suspend_ops->prepare()会被调用， 这个函数通常会作一些准备工作来让设备进入休眠。  

接下来多核CPU中的非启动CPU会被关掉，通过注释看到是避免这些其他的CPU造成race  condio，接下来的以后只有一个CPU在运行了。

接下来suspend_enter()会被调用， 这个函数会关闭arch irq， 调用  device_power_down()， 它会调用suspend_late()函数，  这个函数是系统真正进入休眠最后调用的函数，通常会在这个函数中做最后的检查，如果检查没问题， 接下来休眠所有的系统设备和总线，并且调用  suspend_pos->enter() 来使CPU进入省电状态，这时就已经休眠了，代码的执行也就停在这里了。

```C
int suspend_devices_and_enter(suspend_state_t state)
{
        int error;
        bool wakeup = false;

        // 再次检查suspend_ops是否有提供.enter回调
        if (!sleep_state_supported(state))
                return -ENOSYS;

        // 设置目标挂起状态
        pm_suspend_target_state = state;

        // 如果挂起状态是PM_SUSPEND_TO_IDLE，则设置无平台挂起标志
        if (state == PM_SUSPEND_TO_IDLE)
                pm_set_suspend_no_platform();

        /* 开始平台特定的挂起准备操作：
        如果平台注册了suspend_ops (通常在kernel/arch/arm/mach-xx/pm.c中调用suspend_set_ops),
        就会在platform_suspend_begin中调用 suspend_ops->begin()； */
        error = platform_suspend_begin(state);
        if (error)
                goto Close;

        suspend_console();       // 挂起控制台输出，以避免在挂起过程中干扰 
        suspend_test_start();    // 记录系统挂起的开始时间点
        
        // 开始挂起所有设备，会调用所有设备的->prepare和->suspend回调函数
        error = dpm_suspend_start(PMSG_SUSPEND);
        if (error) {
                // 如果有设备挂起失败或检测到早期唤醒事件，打印错误并记录原因
                pr_err("Some devices failed to suspend, or early wake event detected\n");
                log_suspend_abort_reason(
                                "Some devices failed to suspend, or early wake event detected");
                goto Recover_platform;
        }
        // 完成设备挂起测试
        suspend_test_finish("suspend devices");
        // 如果设备挂起测试失败，则跳转到恢复平台状态
        if (suspend_test(TEST_DEVICES))
                goto Recover_platform;

        // 尝试进入挂起状态，如果需要，可以重复尝试
        do {
                error = suspend_enter(state, &wakeup);
        } while (!error && !wakeup && platform_suspend_again(state));

        // 标签Resume_devices: 用于在恢复设备时跳转到这里
 Resume_devices:
        suspend_test_start();
        // 结束设备的恢复过程
        dpm_resume_end(PMSG_RESUME);
        suspend_test_finish("resume devices");
        // 记录恢复控制台的跟踪信息
        trace_suspend_resume(TPS("resume_console"), state, true);
        resume_console();
        trace_suspend_resume(TPS("resume_console"), state, false);

 Close:
        // 结束平台恢复操作
        platform_resume_end(state);
        pm_suspend_target_state = PM_SUSPEND_ON;
        return error;

 Recover_platform:
        // 如果在挂起过程中出现错误，尝试恢复平台状态
        platform_recover(state);
        goto Resume_devices;
}
//   drivers/base/power/main.c
int dpm_suspend_start(pm_message_t state)
{
    ktime_t starttime = ktime_get();
    int error;
    
    //确保在系统进入挂起状态之前，所有设备都已经做好准备
    error = dpm_prepare(state);
    if (error) {
        suspend_stats.failed_prepare++;
        dpm_save_failed_step(SUSPEND_PREPARE);
    } else
    //所有设备正式进入睡眠
        error = dpm_suspend(state);
    dpm_show_time(starttime, state, error, "start");
    return error;
}


int dpm_prepare(pm_message_t state)
{
    int error = 0;

    trace_suspend_resume(TPS("dpm_prepare"), state.event, true);
    might_sleep();//标记当前函数可能会进入睡眠状态。这是内核调试和安全性检查的一部分。

    wait_for_device_probe();//等待所有已知的设备完成它们的probe过程

    device_block_probing();//禁止新设备执行probe

    mutex_lock(&dpm_list_mtx);
    while (!list_empty(&dpm_list) && !error) {
        struct device *dev = to_device(dpm_list.next);

        get_device(dev); //增加设备的引用计数

        mutex_unlock(&dpm_list_mtx);

        trace_device_pm_callback_start(dev, "", state.event);
        error = device_prepare(dev, state);    //通知设备驱动程序准备挂起
        trace_device_pm_callback_end(dev, error);

        mutex_lock(&dpm_list_mtx);

        if (!error) {
            dev->power.is_prepared = true;    //标记设备已准备好挂起。
            //将设备从当前列表移动到已准备好的设备列表dpm_prepared_list
            if (!list_empty(&dev->power.entry))
                list_move_tail(&dev->power.entry, &dpm_prepared_list);
        } else if (error == -EAGAIN) {
            error = 0;
        } else {
            dev_info(dev, "not prepared for power transition: code %d\n",
                 error);
            log_suspend_abort_reason("Device %s not prepared for power transition: code %d",
                         dev_name(dev), error);
        }

        mutex_unlock(&dpm_list_mtx);

        put_device(dev);//减少设备的引用计数

        mutex_lock(&dpm_list_mtx);
    }
    mutex_unlock(&dpm_list_mtx);
    trace_suspend_resume(TPS("dpm_prepare"), state.event, false);
    return error;
}

int dpm_suspend(pm_message_t state)
{
    ktime_t starttime = ktime_get();
    int error = 0;

    trace_suspend_resume(TPS("dpm_suspend"), state.event, true);
    might_sleep();
    
    //处理设备频率和CPU频率的挂起操作
    devfreq_suspend();
    cpufreq_suspend();

    mutex_lock(&dpm_list_mtx);
    pm_transition = state;
    async_error = 0;
    while (!list_empty(&dpm_prepared_list)) {
        struct device *dev = to_device(dpm_prepared_list.prev);

        get_device(dev);

        mutex_unlock(&dpm_list_mtx);

        error = device_suspend(dev);    //睡眠设备

        mutex_lock(&dpm_list_mtx);

        if (error) {
            pm_dev_err(dev, state, "", error);
            dpm_save_failed_dev(dev_name(dev));
        } else if (!list_empty(&dev->power.entry)) {
            list_move(&dev->power.entry, &dpm_suspended_list);
        }

        mutex_unlock(&dpm_list_mtx);

        put_device(dev);

        mutex_lock(&dpm_list_mtx);

        if (error || async_error)
            break;
    }
    mutex_unlock(&dpm_list_mtx);
    async_synchronize_full();    //等待所有异步操作完成
    if (!error)
        error = async_error;
    if (error) {
        suspend_stats.failed_suspend++;
        dpm_save_failed_step(SUSPEND_SUSPEND);
    }
    dpm_show_time(starttime, state, error, NULL);
    trace_suspend_resume(TPS("dpm_suspend"), state.event, false);
    return error;
}
```



```C
static int suspend_enter(suspend_state_t state, bool *wakeup)
{
    int error, last_dev;

    // 准备平台挂起
    error = platform_suspend_prepare(state);
    if (error)
        goto Platform_finish; 

    // 挂起设备（late阶段）
    error = dpm_suspend_late(PMSG_SUSPEND);
    if (error) {
        // 记录最后一个失败的设备
        last_dev = suspend_stats.last_failed_dev + REC_FAILED_NUM - 1;
        last_dev %= REC_FAILED_NUM;
        pr_err("late suspend of devices failed\n");
        log_suspend_abort_reason("late suspend of %s device failed",
                                 suspend_stats.failed_devs[last_dev]);
        goto Platform_finish; 
    }

    // 平台挂起准备（late阶段）
    error = platform_suspend_prepare_late(state);
    if (error)
        goto Devices_early_resume;

    // 挂起设备（noirq阶段）
    error = dpm_suspend_noirq(PMSG_SUSPEND);
    if (error) {
        // 记录最后一个失败的设备
        last_dev = suspend_stats.last_failed_dev + REC_FAILED_NUM - 1;
        last_dev %= REC_FAILED_NUM;
        pr_err("noirq suspend of devices failed\n");
        log_suspend_abort_reason("noirq suspend of %s device failed",
                                 suspend_stats.failed_devs[last_dev]);
        goto Platform_early_resume; 
    }

    // 平台挂起准备（noirq阶段）
    error = platform_suspend_prepare_noirq(state);
    if (error)
        goto Platform_wake;

    // 测试平台挂起
    if (suspend_test(TEST_PLATFORM))
        goto Platform_wake; 

    // 特殊处理PM_SUSPEND_TO_IDLE状态
    if (state == PM_SUSPEND_TO_IDLE) {
        s2idle_loop(); // 进入s2idle循环
        goto Platform_wake; 
    }

    // 禁用非引导CPU
    error = pm_sleep_disable_secondary_cpus();
    if (error || suspend_test(TEST_CPUS)) {
        log_suspend_abort_reason("Disabling non-boot cpus failed");
        goto Enable_cpus;
    }

    // 禁用中断
    arch_suspend_disable_irqs();
    BUG_ON(!irqs_disabled()); // 断言中断已禁用

    // 设置系统状态为挂起
    system_state = SYSTEM_SUSPEND;

    // 挂起syscore
    error = syscore_suspend();
    if (!error) {
        // 检查是否有唤醒事件
        *wakeup = pm_wakeup_pending();
        if (!(suspend_test(TEST_CORE) || *wakeup)) {
            // 执行挂起操作
            trace_suspend_resume(TPS("machine_suspend"), state, true);
            error = suspend_ops->enter(state);// 系统真正进入睡眠，并会在其中阻塞，直到被唤醒
            trace_suspend_resume(TPS("machine_suspend"), state, false);
        } else if (*wakeup) {
            error = -EBUSY; // 如果有唤醒事件，设置错误码
        }
        syscore_resume(); // 恢复syscore
    }

    // 设置系统状态为运行
    system_state = SYSTEM_RUNNING;

    // 启用中断
    arch_suspend_enable_irqs();
    BUG_ON(irqs_disabled()); // 断言中断已启用

Enable_cpus:
    pm_sleep_enable_secondary_cpus(); // 启用非引导CPU

Platform_wake:
    platform_resume_noirq(state); // 平台恢复（noirq阶段）
    dpm_resume_noirq(PMSG_RESUME); // 恢复设备（noirq阶段）

Platform_early_resume:
    platform_resume_early(state); // 平台恢复（early阶段）

Devices_early_resume:
    dpm_resume_early(PMSG_RESUME); // 恢复设备（early阶段）

Platform_finish:
    platform_resume_finish(state); // 平台恢复完成
    return error; // 返回错误码
}
```
