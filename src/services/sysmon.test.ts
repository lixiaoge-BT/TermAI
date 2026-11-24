import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSample,
  computeSample,
  formatRate,
  formatKb,
  formatPercent,
  cpuChartMax,
  SAMPLE_COMMAND,
  type RawStats,
} from "./sysmon";

/** 一段贴近 CentOS 7 真机的采样输出 */
function rawOutput(
  over: { cpu?: string; net?: string; io?: string; mem?: string; phy?: string; df?: string } = {}
): string {
  return `@@UP@@
123456.78 900000.00
@@CPU@@
${over.cpu ?? "cpu  1000 20 500 8000 200 0 30 10 0 0"}
@@LOAD@@
0.52 0.41 0.30 2/215 12345
@@CORES@@
4
@@MEM@@
${over.mem ?? `MemTotal:        7831476 kB
MemFree:          512000 kB
MemAvailable:    5242880 kB
Buffers:          120000 kB
Cached:          1500000 kB
SReclaimable:     100000 kB
Shmem:             28948 kB
SwapTotal:       2097148 kB
SwapFree:        2097148 kB`}
@@NET@@
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0
  eth0: 1000000 800 0 0 0 0 0 0 400000 600 0 0 0 0 0 0
  docker0: 2000 20 0 0 0 0 0 0 3000 30 0 0 0 0 0 0
  veth45d0bdd: 700 7 0 0 0 0 0 0 900 9 0 0 0 0 0 0
  virbr0: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0
@@PHY@@
${over.phy ?? "eth0"}
@@IO@@
${over.io ?? `   8       0 sda 1000 100 40000 500 2000 200 80000 900 0 1200 -1 0 0 0 0 0 0
   8       1 sda1 900 90 39000 490 1900 190 79000 890 0 1100 -1 0 0 0 0 0 0
 253       0 dm-0 800 0 30000 400 1500 0 60000 700 0 900 -1 0 0 0 0 0 0
   7       0 loop0 10 0 10 1 0 0 0 0 0 1 -1 0 0 0 0 0 0
 202       0 xvda 500 0 20000 200 800 0 40000 400 0 600 -1 0 0 0 0 0 0`}
@@DF@@
${over.df ?? `Filesystem              1024-blocks     Used Available Capacity Mounted on
devtmpfs                    3977952        0   3977952       0% /dev
tmpfs                       3994920        0   3994920       0% /dev/shm
tmpfs                       3994920    28944   3965976       1% /run
/dev/mapper/centos-root    38770180 18995424  19774756      49% /
/dev/sda1                   1038336   227880    810456      22% /boot
overlay                    38770180 18995424  19774756      49% /var/lib/docker/overlay2/abc/merged`}
@@END@@`;
}

describe("parseSample", () => {
  it("非 Linux（没有 /proc/stat）返回 null，不去重试", () => {
    assert.equal(parseSample(""), null);
    assert.equal(parseSample("@@UP@@\n1.0\n"), null);
    assert.equal(parseSample("bash: /proc/stat: No such file or directory"), null);
  });

  it("输出被超时截断（没有 @@END@@）判为不可用，而不是当成全是 0", () => {
    const full = rawOutput();
    const cut = full.slice(0, full.indexOf("@@NET@@"));
    // 截断帧若被采信，网速/IO 会「掉到 0」而不是保持上一帧
    assert.equal(parseSample(cut), null);
    assert.ok(parseSample(full));
  });

  it("CPU jiffies 解析正确（含 iowait/steal 单列）", () => {
    const r = parseSample(rawOutput(), 1000)!;
    assert.equal(r.cpuIdle, 8000);
    assert.equal(r.cpuIowait, 200);
    assert.equal(r.cpuSteal, 10);
    // user+nice+system+idle+iowait+irq+softirq+steal
    assert.equal(r.cpuTotal, 1000 + 20 + 500 + 8000 + 200 + 0 + 30 + 10);
  });

  it("内存用 MemAvailable，没有该字段时按 Free+Buffers+Cached+SReclaimable−Shmem 估", () => {
    const r = parseSample(rawOutput(), 1)!;
    assert.equal(r.memTotalKb, 7831476);
    assert.equal(r.memAvailKb, 5242880);
    assert.equal(r.memCachedKb, 1_500_000 + 120_000);

    const old = rawOutput({
      mem: "MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 150 kB",
    });
    const r2 = parseSample(old, 1)!;
    assert.equal(r2.memAvailKb, 300);

    // 共享内存（Shmem）计入 Cached 但不可回收，不能算进可用量
    const shm = rawOutput({
      mem: "MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 150 kB\nSReclaimable: 60 kB\nShmem: 40 kB",
    });
    const r3 = parseSample(shm, 1)!;
    assert.equal(r3.memAvailKb, 320); // 100+50+150+60-40
  });

  it("网速只算真实网卡：lo / docker0 / veth / virbr 全部排除", () => {
    const r = parseSample(rawOutput(), 1)!;
    // 只有 eth0（PHY 白名单）；docker0 与 veth 承载的是同一份容器流量，
    // 加进去会让网速翻倍甚至三倍
    assert.equal(r.netRx, 1_000_000);
    assert.equal(r.netTx, 400_000);
  });

  it("没有 /sys（PHY 为空）时退回按名字识别虚拟网卡", () => {
    const r = parseSample(rawOutput({ phy: "" }), 1)!;
    // 仍只留 eth0：正则黑名单兜底
    assert.equal(r.netRx, 1_000_000);
    assert.equal(r.netTx, 400_000);
  });

  it("vlan 子接口不计（它与父接口是同一份流量）", () => {
    const withVlan = rawOutput().replace(
      "  eth0: 1000000 800 0 0 0 0 0 0 400000 600 0 0 0 0 0 0",
      "  eth0: 1000000 800 0 0 0 0 0 0 400000 600 0 0 0 0 0 0\n  eth0.100: 500000 400 0 0 0 0 0 0 200000 300 0 0 0 0 0 0"
    );
    // eth0.100 也有 /sys/.../device，必须显式排除
    const r = parseSample(withVlan.replace("@@PHY@@\neth0", "@@PHY@@\neth0\neth0.100"), 1)!;
    assert.equal(r.netRx, 1_000_000);
  });

  it("块设备只算整盘：分区 / dm- / loop 都不计入（否则 IO 翻倍）", () => {
    const r = parseSample(rawOutput(), 1)!;
    // 只有 sda 与 xvda
    assert.equal(r.ioSectorsRead, 40_000 + 20_000);
    assert.equal(r.ioSectorsWritten, 80_000 + 40_000);
    assert.equal(r.ioOps, (1000 + 2000) + (500 + 800));
    assert.equal(r.ioTicks, 1200 + 600);
    assert.deepEqual(r.ioDevTicks, { sda: 1200, xvda: 600 });
  });

  it("分区按使用率降序，只保留真实文件系统（tmpfs/devtmpfs/overlay 排除）", () => {
    const r = parseSample(rawOutput(), 1)!;
    assert.deepEqual(
      r.disks.map((d) => [d.mount, d.usePct]),
      [
        ["/", 49],
        ["/boot", 22],
      ]
    );
    // 状态栏指标取最满的那块
    assert.equal(r.diskMount, "/");
    assert.equal(r.diskTotalKb, 38770180);
    assert.equal(r.diskUsedKb, 18995424);
  });

  it("最满的不是 / 时也能报出来（/boot 满会把状态栏的 49% 掩盖掉）", () => {
    const df = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/mapper/centos-root 38770180 18995424 19774756 49% /
/dev/sda1 1038336 1030000 8336 100% /boot`;
    const r = parseSample(rawOutput({ df }), 1)!;
    assert.equal(r.diskMount, "/boot");
    assert.equal(r.disks[0].usePct, 100);
  });

  it("使用率优先用 df 的 Capacity 字段（reserved blocks 口径）", () => {
    // ext4 默认留 5% 给 root：used/total 会算成 60%，df 口径是 63%
    const df = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/sda1 1000000 600000 350000 63% /data`;
    const r = parseSample(rawOutput({ df }), 1)!;
    assert.equal(r.disks[0].usePct, 63);
  });

  it("根分区与负载", () => {
    const r = parseSample(rawOutput(), 1)!;
    assert.deepEqual(r.load, [0.52, 0.41, 0.3]);
    assert.equal(r.cores, 4);
  });

  it("容器里缺 /proc/diskstats 时只丢 IO 指标，不整体失败", () => {
    const r = parseSample(rawOutput({ io: "" }), 1)!;
    assert.equal(r.ioTicks, 0);
    assert.deepEqual(r.ioDevTicks, {});
    assert.equal(r.memTotalKb, 7831476);
  });

  it("采样命令不依赖 sysstat/iostat，纯 /proc 读取", () => {
    for (const bin of ["iostat", "sar", "mpstat", "free", "top"]) {
      assert.ok(!new RegExp(`(^|\\s)${bin}(\\s|$)`).test(SAMPLE_COMMAND), `不该依赖 ${bin}`);
    }
    assert.ok(SAMPLE_COMMAND.includes("/proc/stat"));
    // df 可能卡在网络文件系统上，必须有超时兜底
    assert.ok(SAMPLE_COMMAND.includes("timeout"));
    assert.ok(SAMPLE_COMMAND.includes("@@END@@"), "结束标记用于判断这一帧是否完整");
  });
});

describe("computeSample", () => {
  const base = (over: Partial<RawStats> = {}): RawStats => ({
    at: 0,
    uptime: 100,
    cpuTotal: 1000,
    cpuIdle: 800,
    cpuIowait: 50,
    cpuSteal: 0,
    cores: 4,
    load: [0, 0, 0],
    memTotalKb: 1000,
    memFreeKb: 100,
    memAvailKb: 400,
    memCachedKb: 200,
    swapTotalKb: 0,
    swapFreeKb: 0,
    netRx: 0,
    netTx: 0,
    ioTicks: 0,
    ioSectorsRead: 0,
    ioSectorsWritten: 0,
    ioOps: 0,
    ioDevTicks: {},
    disks: [],
    diskTotalKb: 1000,
    diskUsedKb: 500,
    diskMount: "/",
    ...over,
  });

  it("首帧无差值：百分比为 0 且 deltaReady=false", () => {
    const s = computeSample(null, base());
    assert.equal(s.deltaReady, false);
    assert.equal(s.cpu, 0);
    assert.equal(s.netRxBps, 0);
    // 静态指标仍可用
    assert.equal(s.memUsedKb, 600);
  });

  it("CPU 占用剔除 iowait（等磁盘不算 CPU 忙）", () => {
    // 4 秒内 400 jiffies：idle 100、iowait 100、其余 200
    const prev = base({ at: 0 });
    const cur = base({ at: 4000, cpuTotal: 1400, cpuIdle: 900, cpuIowait: 150 });
    const s = computeSample(prev, cur);
    // busy = (400 - 100 - 100) / 400 = 50%
    assert.equal(Math.round(s.cpu), 50);
    assert.equal(Math.round(s.iowait), 25);
  });

  it("steal 也不计入忙（时间被 hypervisor 拿走，本机没在跑东西）", () => {
    // 400 jiffies：idle 100、iowait 50、steal 150、真正干活 100
    const prev = base({ at: 0, uptime: 100, cpuTotal: 1000, cpuIdle: 800, cpuIowait: 50, cpuSteal: 0 });
    const cur = base({
      at: 4000,
      uptime: 104,
      cpuTotal: 1400,
      cpuIdle: 900,
      cpuIowait: 100,
      cpuSteal: 150,
    });
    const s = computeSample(prev, cur);
    // 旧实现只扣 iowait → 会算成 62.5%
    assert.equal(Math.round(s.cpu), 25);
    assert.equal(Math.round(s.steal * 10) / 10, 37.5);
  });

  it("时间基准用远端 uptime：本地时钟抖动不影响速率", () => {
    // 本地墙钟因为 RTT 抖动只走了 1.2s，远端实际过了 2.0s
    const prev = base({ at: 10_000, uptime: 100 });
    const cur = base({ at: 11_200, uptime: 102, netRx: 2048 });
    const s = computeSample(prev, cur);
    assert.equal(s.timeBasis, "uptime");
    assert.equal(Math.round(s.elapsedMs), 2000);
    assert.equal(Math.round(s.netRxBps), 1024); // 2048 B / 2s，而不是 /1.2s 的 1706
  });

  it("本地时钟被 NTP 往回拨时仍按真实间隔算（不会出负速率或巨大值）", () => {
    // 墙钟倒退 5 秒，但 uptime 正常 +2000ms
    const prev = base({ at: 20_000, uptime: 100 });
    const cur = base({ at: 15_000, uptime: 102, netRx: 4096 });
    const s = computeSample(prev, cur);
    assert.equal(s.timeBasis, "uptime");
    assert.equal(Math.round(s.netRxBps), 2048);
  });

  it("uptime 不可用（0 / 倒退）时退回墙钟", () => {
    const prev = base({ at: 0, uptime: 0 });
    const cur = base({ at: 2000, uptime: 0, netRx: 2048 });
    const s = computeSample(prev, cur);
    assert.equal(s.timeBasis, "wall");
    assert.equal(Math.round(s.netRxBps), 1024);
  });

  it("断档（切后台回来）不出速率，避免把尖峰摊平成平均值", () => {
    const prev = base({ at: 0, uptime: 100 });
    const cur = base({ at: 300_000, uptime: 400, netRx: 1_000_000 });
    const s = computeSample(prev, cur);
    assert.equal(s.deltaReady, false);
    assert.equal(s.netRxBps, 0);
    // 静态部分照常更新
    assert.equal(s.uptime, 400);
  });

  it("网速 / IO 速率按实际间隔换算", () => {
    const prev = base({ at: 0, netRx: 0, netTx: 0, ioSectorsRead: 0, ioTicks: 0, ioOps: 0 });
    const cur = base({
      at: 2000,
      cpuTotal: 1400,
      cpuIdle: 1200,
      netRx: 2048 * 1000,
      netTx: 1024 * 500,
      ioSectorsRead: 4000, // 4000 * 512 = 2MB
      ioTicks: 1000,
      ioOps: 100,
    });
    const s = computeSample(prev, cur);
    assert.equal(Math.round(s.netRxBps), 1024 * 1000);
    assert.equal(Math.round(s.netTxBps), 1024 * 250);
    assert.equal(Math.round(s.ioReadBps), 1_024_000); // 4000 扇区 * 512B / 2s
    assert.equal(Math.round(s.ioUtil), 50); // 1000ms / 2000ms
    assert.equal(Math.round(s.iops), 50);
  });

  it("%util 取最忙的单块盘，而不是把多块盘求和", () => {
    // sda 忙 1800ms、sdb 忙 200ms：求和会算成 100%（1800+200=2000/2000）
    // 取最大才是 iostat 的口径 —— sda 90%
    const prev = base({ at: 0, uptime: 100, ioDevTicks: { sda: 1000, sdb: 500 } });
    const cur = base({ at: 2000, uptime: 102, ioDevTicks: { sda: 2800, sdb: 700 } });
    const s = computeSample(prev, cur);
    assert.equal(Math.round(s.ioUtil), 90);
    assert.equal(s.ioBusiest, "sda");
  });

  it("新接入的盘不把历史累计当成这一次的增量", () => {
    const prev = base({ at: 0, uptime: 100, ioDevTicks: { sda: 1000 } });
    // sdb 是刚插上的，它的 io_ticks=9_000_000 是历史值
    const cur = base({ at: 2000, uptime: 102, ioDevTicks: { sda: 1100, sdb: 9_000_000 } });
    const s = computeSample(prev, cur);
    assert.equal(Math.round(s.ioUtil), 5); // sda 100ms/2000ms
    assert.equal(s.ioBusiest, "sda");
  });

  it("计数器归零/回绕不产生负值或 3000%", () => {
    const prev = base({ at: 0, netRx: 10_000_000, ioTicks: 5000, cpuTotal: 9999, cpuIdle: 100 });
    const cur = base({ at: 2000, netRx: 10, ioTicks: 0, cpuTotal: 100, cpuIdle: 50 });
    const s = computeSample(prev, cur);
    assert.equal(s.netRxBps, 0);
    assert.equal(s.ioUtil, 0);
    assert.ok(s.cpu >= 0 && s.cpu <= 100, `cpu=${s.cpu}`);
  });

  it("间隔过短（<200ms）不产出速率噪声", () => {
    const prev = base({ at: 0 });
    const cur = base({ at: 50, netRx: 999999, cpuTotal: 1100, cpuIdle: 850 });
    const s = computeSample(prev, cur);
    assert.equal(s.deltaReady, false);
    assert.equal(s.netRxBps, 0);
  });
});

describe("展示格式", () => {
  it("速率自适应单位", () => {
    assert.equal(formatRate(0), "0 B/s");
    assert.equal(formatRate(512), "512 B/s");
    assert.equal(formatRate(2048), "2.0 K/s");
    assert.equal(formatRate(5 * 1024 * 1024), "5.0 M/s");
  });

  it("容量走 G/M", () => {
    assert.equal(formatKb(0), "0");
    assert.equal(formatKb(512 * 1024), "512M");
    assert.equal(formatKb(7.6 * 1024 * 1024), "7.6G");
  });

  it("低占用不被取整成 0%（24 核上 0.2% 与 top 的 0.1us+0.1sy 对得上）", () => {
    assert.equal(formatPercent(0), "0%");
    assert.equal(formatPercent(0.2083), "0.2%");
    assert.equal(formatPercent(1.7), "1.7%");
    assert.equal(formatPercent(9.96), "10.0%");
    assert.equal(formatPercent(68.4), "68%");
    assert.equal(formatPercent(100), "100%");
  });

  it("CPU 折线量程自适应：低占用不再贴底画成直线", () => {
    assert.equal(cpuChartMax([]), 1);
    assert.equal(cpuChartMax([0.1, 0.2, 0]), 1);
    assert.equal(cpuChartMax([0.8, 1.5, 0.2]), 2);
    assert.equal(cpuChartMax([2, 3.4]), 5);
    assert.equal(cpuChartMax([5, 8]), 10);
    assert.equal(cpuChartMax([0.2, 12]), 100); // 出现两位数就回满量程，避免误读成满载
  });

  it("端到端：24 核 2s 内忙 10 jiffies 算出 0.2%，展示不再是 0%", () => {
    const mk = (total: number, idle: number, uptime: number): RawStats => ({
      at: uptime * 1000, uptime, cpuTotal: total, cpuIdle: idle, cpuIowait: 0, cpuSteal: 0,
      cores: 24, load: [0.01, 0.04, 0.05], memTotalKb: 0, memFreeKb: 0, memAvailKb: 0,
      memCachedKb: 0, swapTotalKb: 0, swapFreeKb: 0, netRx: 0, netTx: 0, ioTicks: 0,
      ioSectorsRead: 0, ioSectorsWritten: 0, ioOps: 0, ioDevTicks: {}, disks: [],
      diskTotalKb: 0, diskUsedKb: 0, diskMount: "/",
    });
    // 24 核 * 100 jiffy/s * 2s = 4800 jiffies，idle 4790 → 忙 10 → 0.2083%
    const s = computeSample(mk(1_000_000, 998_000, 1000), mk(1_004_800, 1_002_790, 1002));
    assert.ok(Math.abs(s.cpu - 0.2083333) < 0.001, `cpu=${s.cpu}`);
    assert.equal(formatPercent(s.cpu), "0.2%");
  });
});
