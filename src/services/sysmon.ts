/**
 * 远端主机资源采样（CPU / 内存 / 磁盘 / 网络 / IO）。
 *
 * 设计取舍：
 * 1) **一次 exec 拿全部指标**。分开调用（free / df / iostat / sar）要 5 次往返、
 *    还依赖 sysstat，很多最小化安装的系统根本没装。这里全部读 /proc，
 *    一条命令、零依赖、几毫秒返回。
 * 2) **远端只回原始计数器，差值在本地算**。CPU 占用率、网速、IO util 本质都是
 *    「两次采样的差值 / 间隔」，远端算需要保留状态（脚本里存文件很脏），
 *    不如把累计计数器原样带回，渲染层保存上一帧即可。
 * 3) **不碰用户 PTY**。走 ssh:exec 独立通道，采样命令不出现在终端里。
 */

/** 一个挂载点的用量（来自 df -kP） */
export interface DiskUsage {
  /** 设备名，如 /dev/mapper/centos-root */
  fs: string;
  mount: string;
  totalKb: number;
  usedKb: number;
  availKb: number;
  /** df 的 Capacity 字段。比 used/total 更权威：ext4 的 reserved blocks 不算 available */
  usePct: number;
}

/** 远端原始累计计数器（一次采样的快照） */
export interface RawStats {
  at: number;
  /** /proc/uptime 秒。用作**时间基准**：它是远端单调时钟，不受本地时钟跳变与链路抖动影响 */
  uptime: number;
  /** CPU 累计 jiffies */
  cpuTotal: number;
  cpuIdle: number;
  cpuIowait: number;
  cpuSteal: number;
  cores: number;
  load: [number, number, number];
  memTotalKb: number;
  memFreeKb: number;
  memAvailKb: number;
  memCachedKb: number;
  swapTotalKb: number;
  swapFreeKb: number;
  /** 累计收发字节（所有非 lo 网卡求和） */
  netRx: number;
  netTx: number;
  /** 累计 IO 计数器（整盘求和，排除分区与 dm/loop 等虚拟设备） */
  ioTicks: number;
  ioSectorsRead: number;
  ioSectorsWritten: number;
  ioOps: number;
  /**
   * 每个整盘各自的 io_ticks。%util 是**单设备**语义：
   * 多块盘同时忙时把 io_ticks 求和会算出 180% 这种值，再被 clamp 成 100%，
   * 结果既看不出单盘饱和也丢了信息。按设备取最大值才和 iostat 一致。
   */
  ioDevTicks: Record<string, number>;
  /** 所有本地分区，按使用率降序 */
  disks: DiskUsage[];
  diskTotalKb: number;
  diskUsedKb: number;
  diskMount: string;
}

/** 渲染层用的「已算好差值」的一帧 */
export interface SysSample {
  at: number;
  /** 首次采样（没有上一帧）时为 false，百分比类字段无意义 */
  deltaReady: boolean;
  /** 本次计算用的实际间隔（毫秒）。用远端 uptime 差分得到，可直接展示 */
  elapsedMs: number;
  /** 时间基准来源：uptime 优先（单调时钟），异常时退回本地墙钟 */
  timeBasis: "uptime" | "wall" | "none";
  cpu: number;
  iowait: number;
  steal: number;
  cores: number;
  load: [number, number, number];
  memTotalKb: number;
  memUsedKb: number;
  memCachedKb: number;
  swapTotalKb: number;
  swapUsedKb: number;
  /** 最满分区的使用率（df 口径） */
  diskPct: number;
  diskTotalKb: number;
  diskUsedKb: number;
  diskMount: string;
  /** 所有本地分区（按使用率降序），供弹层展示 */
  disks: DiskUsage[];
  netRxBps: number;
  netTxBps: number;
  ioUtil: number;
  /** %util 对应的最忙设备（多盘时说明这个数字代表谁） */
  ioBusiest: string;
  ioReadBps: number;
  ioWriteBps: number;
  iops: number;
  uptime: number;
}

/**
 * 采样命令。分段标记 `@@X@@` 让解析器不依赖行的顺序，
 * 任何一段缺失（例如没有 /proc/diskstats 的容器）都只是该指标缺，不整体失败。
 */
export const SAMPLE_COMMAND = `{
echo '@@UP@@'; cat /proc/uptime 2>/dev/null
echo '@@CPU@@'; head -n 1 /proc/stat 2>/dev/null
echo '@@LOAD@@'; cat /proc/loadavg 2>/dev/null
echo '@@CORES@@'; nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null
echo '@@MEM@@'; grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SReclaimable|Shmem|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null
echo '@@NET@@'; cat /proc/net/dev 2>/dev/null
echo '@@PHY@@'; ls -d /sys/class/net/*/device 2>/dev/null | sed 's#.*/net/##; s#/device##'
echo '@@IO@@'; cat /proc/diskstats 2>/dev/null
echo '@@DF@@'; D=$(timeout 3 df -kP -l 2>/dev/null); [ -n "$D" ] || D=$(df -kP / 2>/dev/null); printf '%s\\n' "$D"
echo '@@END@@'
} 2>/dev/null`;

/** 整盘设备名：sda / vda / hda / xvda / nvme0n1 / mmcblk0。分区（sda1、nvme0n1p1）不算。 */
const WHOLE_DISK_RE = /^(?:sd[a-z]+|vd[a-z]+|hd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

/** 虚拟/回环设备：算进去会让 IO 翻倍甚至几十倍 */
const VIRTUAL_DISK_RE = /^(?:loop|ram|dm-|md|sr|zram|fd)/;

/**
 * 不该计入网速的接口。
 *
 * 虚拟网卡会把同一份流量**重复计一遍**：容器流量先过 veth 再落到 docker0/网桥，
 * 物理网卡上还有一次；KVM 的 virbr0 与 vnet 同理。只排除 lo 时，
 * 一台跑着容器的机器上报的「网速」可以是真实值的 2~3 倍。
 */
const VIRTUAL_NIC_RE =
  /^(?:lo|docker\d*|veth.+|br-[0-9a-f]+|virbr\d*|virbr\d*-nic|vnet\d+|cni\d*|flannel.+|cali.+|kube.+|tunl\d+|vxlan.+|dummy\d*|ifb\d*)$/;

/** df 里不代表真实磁盘容量的文件系统类型（设备名位置出现这些就跳过） */
const PSEUDO_FS_RE =
  /^(?:tmpfs|devtmpfs|udev|none|overlay|shm|rootfs|ramfs|proc|sysfs|cgroup2?|devpts|mqueue|debugfs|hugetlbfs|squashfs|iso9660|nsfs)$/i;

const num = (s: string | undefined): number => {
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
};

/**
 * 解析采样输出。返回 null 表示「这台机器采不了」（非 Linux / 没有 /proc），
 * 调用方据此隐藏面板，而不是反复重试。
 */
export function parseSample(raw: string, at = Date.now()): RawStats | null {
  const text = raw ?? "";
  if (!text.includes("@@CPU@@")) return null;
  // 采样被超时截断时，缺失的段会被解析成 0 —— 网速/IO 就会「掉到 0」而不是「保持上一次」。
  // 用结束标记判断这一帧是否完整：不完整就当没采到（调用方保留上一帧），
  // 比显示一个假的 0 更接近真实。
  if (!text.includes("@@END@@")) return null;

  const sections = new Map<string, string[]>();
  let cur = "";
  for (const line of text.split("\n")) {
    const m = line.match(/^@@(\w+)@@\s*$/);
    if (m) {
      cur = m[1];
      sections.set(cur, []);
      continue;
    }
    if (cur) sections.get(cur)!.push(line);
  }
  const sec = (name: string) => (sections.get(name) ?? []).filter((l) => l.trim() !== "");

  // ---- CPU：cpu user nice system idle iowait irq softirq steal ----
  const cpuLine = sec("CPU")[0] ?? "";
  const cpuFields = cpuLine.trim().split(/\s+/).slice(1);
  if (cpuFields.length < 4) return null;
  const [
    user = 0,
    nice = 0,
    system = 0,
    idle = 0,
    iowait = 0,
    irq = 0,
    softirq = 0,
    steal = 0,
  ] = cpuFields.map(num);
  const cpuTotal = user + nice + system + idle + iowait + irq + softirq + steal;

  // ---- 负载 ----
  const loadParts = (sec("LOAD")[0] ?? "").trim().split(/\s+/).map(num);
  const load: [number, number, number] = [loadParts[0] ?? 0, loadParts[1] ?? 0, loadParts[2] ?? 0];

  // ---- 内存 ----
  const mem: Record<string, number> = {};
  for (const l of sec("MEM")) {
    const m = l.match(/^(\w+):\s+(\d+)/);
    if (m) mem[m[1]] = num(m[2]);
  }
  const memTotalKb = mem.MemTotal ?? 0;
  const memFreeKb = mem.MemFree ?? 0;
  // MemAvailable 是 3.14+ 才有；老内核（CentOS 6/7 早期）按内核文档的公式估：
  // Free + Buffers + Cached + SReclaimable − Shmem。少减 Shmem 会把共享内存
  // 也当成可回收，可用内存虚高、占用率虚低。
  const memAvailKb =
    mem.MemAvailable ??
    Math.max(0, memFreeKb + (mem.Buffers ?? 0) + (mem.Cached ?? 0) + (mem.SReclaimable ?? 0) - (mem.Shmem ?? 0));

  // ---- 网络：只算真实网卡 ----
  // /sys/class/net/<if>/device 存在 ⇔ 该接口绑定在真实设备上（PCI/USB）。
  // veth / docker0 / br0 / bond0 / virbr0 / tun 都没有这个链接，而它们承载的
  // 流量和物理网卡是同一份 —— 一起加就会重复计数。
  const physSet = new Set(
    sec("PHY")
      .map((l) => l.trim())
      .filter(Boolean)
  );
  // vlan 子接口（eth0.100）也有 device 链接，但它的流量是父接口的子集
  const isVlan = (n: string) => /\.\d+$/.test(n);
  const useWhitelist = physSet.size > 0;
  let netRx = 0;
  let netTx = 0;
  for (const l of sec("NET")) {
    const idx = l.indexOf(":");
    if (idx < 0) continue;
    const name = l.slice(0, idx).trim();
    if (!name || name === "lo" || isVlan(name)) continue;
    if (useWhitelist ? !physSet.has(name) : VIRTUAL_NIC_RE.test(name)) continue;
    const f = l.slice(idx + 1).trim().split(/\s+/);
    netRx += num(f[0]);
    netTx += num(f[8]); // rx 有 8 个字段（bytes packets errs drop fifo frame compressed multicast）
  }

  // ---- 块设备 IO ----
  let ioTicks = 0;
  let ioSectorsRead = 0;
  let ioSectorsWritten = 0;
  let ioOps = 0;
  const ioDevTicks: Record<string, number> = {};
  for (const l of sec("IO")) {
    const f = l.trim().split(/\s+/);
    if (f.length < 13) continue;
    const name = f[2];
    if (!WHOLE_DISK_RE.test(name) || VIRTUAL_DISK_RE.test(name)) continue;
    ioSectorsRead += num(f[5]);
    ioSectorsWritten += num(f[9]);
    ioOps += num(f[3]) + num(f[7]);
    ioTicks += num(f[12]); // io_ticks：设备「有 IO 在进行」的毫秒数，%util 的分子
    ioDevTicks[name] = num(f[12]);
  }

  // ---- 本地分区（df -kP -l 全量） ----
  const disks: DiskUsage[] = [];
  const seenMount = new Set<string>();
  for (const l of sec("DF")) {
    const f = l.trim().split(/\s+/);
    if (f.length < 6) continue;
    const fs = f[0];
    if (/^Filesystem$/i.test(fs)) continue;
    if (PSEUDO_FS_RE.test(fs) || /^\/dev\/loop\d+$/.test(fs)) continue;
    const totalKb = num(f[1]);
    const usedKb = num(f[2]);
    const availKb = num(f[3]);
    // 挂载点可能含空格，从第 6 个字段起都算挂载点
    const mount = f.slice(5).join(" ");
    if (totalKb <= 0 || !mount) continue;
    if (mount.startsWith("/snap/") || mount.startsWith("/var/lib/docker/")) continue;
    if (seenMount.has(mount)) continue;
    seenMount.add(mount);
    // Capacity 字段是 df 自己算的权威值（含 reserved blocks 口径）；
    // 缺失时用 used/(used+avail) 复算 —— 这个式子与 df 的定义等价，
    // 而 used/total 会把 ext4 保留块算成已用，长期偏高 1~5%。
    const capField = f[4].replace("%", "");
    const usePct = Number.isFinite(Number(capField))
      ? num(capField)
      : usedKb + availKb > 0
        ? (100 * usedKb) / (usedKb + availKb)
        : 0;
    disks.push({ fs, mount, totalKb, usedKb, availKb, usePct });
  }
  // 使用率降序；同率时容量大的优先（更可能是运维关心的那块）
  disks.sort((a, b) => b.usePct - a.usePct || b.totalKb - a.totalKb);
  const top = disks[0];

  return {
    at,
    uptime: num((sec("UP")[0] ?? "").trim().split(/\s+/)[0]),
    cpuTotal,
    cpuIdle: idle,
    cpuIowait: iowait,
    cpuSteal: steal,
    cores: Math.max(1, Math.round(num(sec("CORES")[0]))),
    load,
    memTotalKb,
    memFreeKb,
    memAvailKb,
    memCachedKb: (mem.Cached ?? 0) + (mem.Buffers ?? 0),
    swapTotalKb: mem.SwapTotal ?? 0,
    swapFreeKb: mem.SwapFree ?? 0,
    netRx,
    netTx,
    ioTicks,
    ioSectorsRead,
    ioSectorsWritten,
    ioOps,
    ioDevTicks,
    disks,
    diskTotalKb: top?.totalKb ?? 0,
    diskUsedKb: top?.usedKb ?? 0,
    diskMount: top?.mount ?? "/",
  };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 相邻两帧超过这个间隔就认为中间断过（切后台、连接抖动），不产出速率 */
export const MAX_GAP_MS = 10_000;
/** 小于这个间隔的差值是量化噪声（CPU 一个 jiffy 才 10ms） */
const MIN_GAP_MS = 200;

/**
 * 由相邻两帧算出百分比/速率。
 *
 * 时间基准优先用**远端 uptime 差分**：
 * - 本地 `Date.now()` 差里混着两次 SSH 往返的抖动，链路一慢速率就忽高忽低；
 * - 更要紧的是本地时钟可能被 NTP 校正或用户手动改，往回调会把间隔算成负数。
 * uptime 是远端单调时钟，只反映真实经过时间。它只有 10ms 精度，2s 采样下
 * 量化误差 0.5%，比链路抖动小一个量级。
 *
 * 计数器回绕、重连后计数器归零都会出现负差值 —— 一律按 0 处理，
 * 否则界面上会蹦出 -3000% 这种数字。
 */
export function computeSample(prev: RawStats | null, cur: RawStats): SysSample {
  const base: SysSample = {
    at: cur.at,
    deltaReady: false,
    elapsedMs: 0,
    timeBasis: "none",
    cpu: 0,
    iowait: 0,
    steal: 0,
    cores: cur.cores,
    load: cur.load,
    memTotalKb: cur.memTotalKb,
    memUsedKb: Math.max(0, cur.memTotalKb - cur.memAvailKb),
    memCachedKb: cur.memCachedKb,
    swapTotalKb: cur.swapTotalKb,
    swapUsedKb: Math.max(0, cur.swapTotalKb - cur.swapFreeKb),
    diskPct: cur.disks[0]?.usePct ?? 0,
    diskTotalKb: cur.diskTotalKb,
    diskUsedKb: cur.diskUsedKb,
    diskMount: cur.diskMount,
    disks: cur.disks,
    netRxBps: 0,
    netTxBps: 0,
    ioUtil: 0,
    ioBusiest: "",
    ioReadBps: 0,
    ioWriteBps: 0,
    iops: 0,
    uptime: cur.uptime,
  };
  if (!prev) return base;

  // ---- 时间基准 ----
  const upDelta = cur.uptime - prev.uptime;
  const wallDelta = cur.at - prev.at;
  let elapsedMs: number;
  let basis: SysSample["timeBasis"];
  if (Number.isFinite(upDelta) && upDelta > 0) {
    // uptime 单调整增长就是权威值，不需要和墙钟投票：链路一慢墙钟差就偏小，
    // 此时若退回墙钟，速率会被放大（除数小了）。
    // 解析异常导致的荒谬值由下面的 MIN_GAP / MAX_GAP 兜住。
    elapsedMs = upDelta * 1000;
    basis = "uptime";
  } else if (wallDelta > 0) {
    // uptime 缺失/倒退（机器重启过、/proc 不可读）才退回墙钟
    elapsedMs = wallDelta;
    basis = "wall";
  } else {
    // 连墙钟都没前进（本地时钟被往回拨且 uptime 不可用）：这一帧不要了
    return base;
  }
  base.elapsedMs = elapsedMs;
  base.timeBasis = basis;

  if (elapsedMs < MIN_GAP_MS) return base;
  // 断档：中间有一段时间没采到。用这么大的间隔算速率会把尖峰摊平成平均值，
  // 看起来像「网速很低」。直接标记未就绪，调用方保留上一帧，下一拍自然恢复。
  if (elapsedMs > MAX_GAP_MS) return base;

  const dTotal = cur.cpuTotal - prev.cpuTotal;
  const dIdle = cur.cpuIdle - prev.cpuIdle;
  const dIowait = cur.cpuIowait - prev.cpuIowait;
  const dSteal = cur.cpuSteal - prev.cpuSteal;
  if (dTotal > 0 && dIdle >= 0) {
    // idle 里不含 iowait：等待磁盘的时间 CPU 其实没干活，算「忙」会误导，
    // 这里按 iostat/top 的惯例把 iowait 单列。
    // steal 也一样：时间被 hypervisor 拿走了，本机没在跑东西，同样不该算忙。
    base.cpu = clamp(
      (100 * (dTotal - dIdle - Math.max(0, dIowait) - Math.max(0, dSteal))) / dTotal,
      0,
      100
    );
    base.iowait = clamp((100 * Math.max(0, dIowait)) / dTotal, 0, 100);
    base.steal = clamp((100 * Math.max(0, dSteal)) / dTotal, 0, 100);
  }

  const perSec = (delta: number) => (delta > 0 ? (delta * 1000) / elapsedMs : 0);
  base.netRxBps = perSec(cur.netRx - prev.netRx);
  base.netTxBps = perSec(cur.netTx - prev.netTx);
  base.ioReadBps = perSec((cur.ioSectorsRead - prev.ioSectorsRead) * 512);
  base.ioWriteBps = perSec((cur.ioSectorsWritten - prev.ioSectorsWritten) * 512);
  base.iops = perSec(cur.ioOps - prev.ioOps);

  // %util 与 iostat 同口径：设备忙碌毫秒 / 墙钟毫秒。
  // 多块盘时取「最忙的那块」而不是求和 —— 求和能算出 180%，clamp 成 100% 后
  // 既丢失单盘饱和度信息，也不符合 %util 的单设备语义。
  const devs = Object.keys(cur.ioDevTicks);
  if (devs.length > 0) {
    let busiest = -1;
    let busiestDev = "";
    for (const dev of devs) {
      const p = prev.ioDevTicks[dev];
      // 上一帧没有这块盘（刚接上）→ 累计值是历史量，不能当本次增量
      if (p === undefined) continue;
      const d = cur.ioDevTicks[dev] - p;
      if (d > busiest) {
        busiest = d;
        busiestDev = dev;
      }
    }
    if (busiest >= 0) {
      base.ioUtil = clamp((100 * busiest) / elapsedMs, 0, 100);
      base.ioBusiest = busiestDev;
    }
  } else {
    // 老数据/无 per-device 明细时退回总量口径
    base.ioUtil = clamp((100 * Math.max(0, cur.ioTicks - prev.ioTicks)) / elapsedMs, 0, 100);
  }

  base.deltaReady = true;
  return base;
}

/**
 * 采一次原始快照。
 *
 * 三种结果要分开，否则会把「链路抖了一下」当成「这台机器不支持」永久隐藏面板：
 * - `ok`         正常
 * - `retry`      瞬时问题（超时、未连接、输出被截断）→ 下一拍再试，UI 保留旧数据
 * - `unsupported` 远端确实没有 /proc（非 Linux）→ 直接隐藏，不再浪费往返
 */
export type SampleOutcome =
  | { status: "ok"; raw: RawStats }
  | { status: "unsupported" }
  | { status: "retry" };

export async function sampleRaw(sessionId: string, timeoutMs = 4000): Promise<SampleOutcome> {
  const api = typeof window === "undefined" ? undefined : window.ssh;
  if (!api?.exec) return { status: "unsupported" };
  const r = await api.exec(sessionId, SAMPLE_COMMAND, timeoutMs);
  // 连接正在重连时主进程直接回空结果，这不是「机器不支持」
  if (r?.timeout || (r?.stderr ?? "").includes("not connected")) return { status: "retry" };
  const stdout = r?.stdout ?? "";
  const raw = parseSample(stdout, Date.now());
  if (raw) return { status: "ok", raw };
  // 脚本跑起来了但没跑到 @@END@@（某条命令卡住被 timeout 掐断）→ 可重试
  if (stdout.includes("@@CPU@@")) return { status: "retry" };
  return { status: "unsupported" };
}

// ---------------- 展示格式化（UI 与提示词共用） ----------------

export function formatRate(bytesPerSec: number): string {
  if (bytesPerSec < 1) return "0 B/s";
  const units = ["B/s", "K/s", "M/s", "G/s"];
  let v = bytesPerSec;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * 百分比展示：低占用不能一律取整。
 *
 * 24 核机器上一个 1.7% 的 java 进程，整机占用只有 0.1% 量级；
 * Math.round(0.2) = 0 会显示成「CPU 0%」，与 top 的 0.1us+0.1sy 明显对不上，
 * 用户会以为监控坏了。≥10 取整够用，<10 保留一位小数，
 * 0 仍是 0%（不要把噪声显示成 0.0%）。
 */
export function formatPercent(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "0%";
  if (v < 10) return `${v.toFixed(1)}%`;
  return `${Math.round(v)}%`;
}

/**
 * Spark 折线的量程上限。
 *
 * CPU 固定 max=100 时，0.x% 的曲线永远贴底画成一条直线（看起来像没数据）；
 * 内存/磁盘这种常年在 40~70% 的指标固定 100 反而更好读。
 * 这里给「低占用整机 CPU」用：峰值 <10 时按峰值向上取整到 1/2/5/10，
 * 让波动可见；峰值一旦到两位数就回到 100 满量程，避免把 15% 画成「满格」。
 */
export function cpuChartMax(values: number[]): number {
  const peak = values.length ? Math.max(...values) : 0;
  if (peak >= 10) return 100;
  if (peak >= 5) return 10;
  if (peak >= 2) return 5;
  if (peak >= 0.5) return 2;
  return 1;
}

export function formatKb(kb: number): string {
  if (kb <= 0) return "0";
  const gb = kb / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)}G`;
  return `${Math.round(kb / 1024)}M`;
}
