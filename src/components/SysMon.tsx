import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  computeSample,
  cpuChartMax,
  formatKb,
  formatPercent,
  formatRate,
  sampleRaw,
  type RawStats,
  type SysSample,
} from "@/services/sysmon";

const POLL_MS = 2000;
const HISTORY_MAX = 60;

/** 严重度配色：<70 正常、70~90 警告、≥90 危险 */
function tone(p: number): string {
  if (p >= 90) return "text-danger-text";
  if (p >= 70) return "text-warning-text";
  return "text-text-primary";
}
function barTone(p: number): string {
  if (p >= 90) return "bg-danger";
  if (p >= 70) return "bg-warning";
  return "bg-success";
}
const pct = formatPercent;

/**
 * 资源采样 hook。
 *
 * 精度相关的三个处理：
 * - **首帧没有差值**，百分比无意义 → 起手连采两次（0ms / 600ms），第二帧才上图，
 *   宁愿先显示「采样中」也不闪一个假的 0%。
 * - **断档不出速率**：computeSample 在间隔过大时返回 deltaReady=false，
 *   这里保留上一帧而不是显示被平均后的低值。
 * - **区分瞬时失败与不支持**：链路抖动不该让面板永久消失。
 */
function useSysMon(sessionId: string | undefined, enabled: boolean) {
  const [sample, setSample] = useState<SysSample | null>(null);
  const [history, setHistory] = useState<SysSample[]>([]);
  const [supported, setSupported] = useState(true);
  const prevRef = useRef<RawStats | null>(null);
  const busyRef = useRef(false);
  const failRef = useRef(0);

  useEffect(() => {
    setSample(null);
    setHistory([]);
    setSupported(true);
    prevRef.current = null;
    failRef.current = 0;
  }, [sessionId]);

  const tick = useCallback(async () => {
    if (!sessionId || !enabled || busyRef.current) return;
    if (typeof document !== "undefined" && document.hidden) return;
    busyRef.current = true;
    try {
      const r = await sampleRaw(sessionId);
      if (r.status === "unsupported") {
        setSupported(false);
        return;
      }
      if (r.status === "retry") {
        // 连续几拍都拿不到完整数据才认为不可用，单次抖动不隐藏面板
        if (++failRef.current >= 3) setSupported(false);
        return;
      }
      failRef.current = 0;
      const s = computeSample(prevRef.current, r.raw);
      prevRef.current = r.raw;
      if (!s.deltaReady) return; // 首帧 / 断档：保留已有显示
      setSample(s);
      // 只有真正算出差值的帧才进折线，否则图开头会挂一个假的 0
      setHistory((h) => (h.length >= HISTORY_MAX ? [...h.slice(1), s] : [...h, s]));
    } catch {
      /* 连接抖动时静默：下一拍再试，UI 保留上一帧数据 */
    } finally {
      busyRef.current = false;
    }
  }, [sessionId, enabled]);

  useEffect(() => {
    if (!sessionId || !enabled) return;
    if (!window.ssh?.exec) {
      setSupported(false);
      return;
    }
    void tick();
    // 第二次很快补上，让 CPU/网速在第一秒内就有值
    const warm = window.setTimeout(() => void tick(), 600);
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      window.clearTimeout(warm);
      window.clearInterval(timer);
    };
  }, [sessionId, enabled, tick]);

  return { sample, history, supported };
}

function MiniBar({ value, width = 20 }: { value: number; width?: number }) {
  // 1~2% 整机 CPU 在 20px 条上不足 0.4px，取整后完全看不见，
  // 和「0%」混为一谈。有值就至少给 2px，让低占用可见但仍明显是Low档。
  const p = Math.min(100, Math.max(0, value));
  return (
    <span
      className="inline-block h-[3px] rounded-full bg-bg-hover overflow-hidden align-middle"
      style={{ width }}
      title={formatPercent(value)}
    >
      <span
        className={`block h-full rounded-full transition-[width] duration-500 ${barTone(value)}`}
        style={{ width: p > 0 ? `max(2px, ${p}%)` : "0%" }}
      />
    </span>
  );
}

/** 极简折线：不引图表库，60 个点够看清楚趋势 */
function Spark({
  values,
  max,
  color,
  width = 96,
  height = 22,
}: {
  values: number[];
  max?: number;
  color: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) {
    return <div style={{ width, height }} className="rounded bg-bg-hover/50" />;
  }
  const cap = Math.max(max ?? Math.max(...values), 1);
  const step = width / (values.length - 1);
  const pts = values
    .map((v, i) => `${(i * step).toFixed(1)},${(height - (Math.min(v, cap) / cap) * (height - 2) - 1).toFixed(1)}`)
    .join(" ");
  const area = `0,${height} ${pts} ${width},${height}`;
  return (
    <svg width={width} height={height} className="block">
      <polygon points={area} fill={color} opacity={0.14} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.2} strokeLinejoin="round" />
    </svg>
  );
}

function Row({
  label,
  value,
  extra,
}: {
  label: string;
  value: string;
  extra?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-text-tertiary">{label}</span>
      <span className="tabular-nums text-text-primary">
        {value}
        {extra && <span className="ml-1 text-text-tertiary">{extra}</span>}
      </span>
    </div>
  );
}

/**
 * 状态栏资源监控：CPU / 内存 / 磁盘 / 网速 / IO。
 *
 * 数据来自远端 /proc 的**只读**采样，走独立 exec 通道，不写用户终端。
 */
export default function SysMon({ sessionId }: { sessionId: string }) {
  const { sample, history, supported } = useSysMon(sessionId, true);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // 状态栏本身 overflow-hidden，弹层放 body 上才不会被裁掉
  const toggle = () => {
    if (pos) {
      setPos(null);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = 300;
    setPos({
      left: Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - width - 8)),
      bottom: window.innerHeight - r.top + 6,
    });
  };

  useEffect(() => {
    if (!pos) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setPos(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPos(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pos]);

  if (!supported) return null;

  const s = sample;
  const memPct = s && s.memTotalKb > 0 ? (s.memUsedKb / s.memTotalKb) * 100 : 0;
  // 磁盘用 df 的 Capacity 口径（含 reserved blocks），与 `df -h` 看到的一致；
  // 自己拿 used/total 算会把 ext4 保留块算成已用，长期偏高几个百分点
  const diskPct = s?.diskPct ?? 0;
  const loading = !s;

  return (
    <div className="flex items-center shrink-0">
      <button
        ref={btnRef}
        onClick={toggle}
        className={`flex items-center gap-3 rounded px-1.5 py-0.5 -mx-1 transition-colors hover:bg-bg-hover whitespace-nowrap ${
          pos ? "bg-bg-active" : ""
        }`}
        title="主机资源使用率（点击查看详情）"
      >
        {loading ? (
          <span className="text-text-tertiary">资源采样中…</span>
        ) : (
          <>
            <span className="flex items-center gap-1 shrink-0">
              <span className="text-text-tertiary">CPU</span>
              <span className={`tabular-nums ${tone(s.cpu)}`}>{pct(s.cpu)}</span>
              <MiniBar value={s.cpu} />
            </span>
            <span className="flex items-center gap-1 shrink-0">
              <span className="text-text-tertiary">内存</span>
              <span className={`tabular-nums ${tone(memPct)}`}>{pct(memPct)}</span>
              <MiniBar value={memPct} />
            </span>
            <span className="flex items-center gap-1 shrink-0">
              <span className="text-text-tertiary">磁盘</span>
              <span className={`tabular-nums ${tone(diskPct)}`}>{pct(diskPct)}</span>
              <MiniBar value={diskPct} />
            </span>
            <span className="flex items-center gap-1 tabular-nums shrink-0">
              <span className="text-text-tertiary">↓</span>
              <span>{formatRate(s.netRxBps)}</span>
              <span className="text-text-tertiary">↑</span>
              <span>{formatRate(s.netTxBps)}</span>
            </span>
            <span className="flex items-center gap-1 shrink-0">
              <span className="text-text-tertiary">IO</span>
              <span className={`tabular-nums ${tone(s.ioUtil)}`}>{pct(s.ioUtil)}</span>
            </span>
          </>
        )}
      </button>

      {pos &&
        s &&
        createPortal(
          <div
            ref={popRef}
            style={{
              left: pos.left,
              bottom: pos.bottom,
              width: 300,
              // 窗口矮的时候（比如高度 500 的紧凑布局）要能滚动，否则顶部 CPU 段被切在屏幕外
              maxHeight: "calc(100vh - 56px)",
              overflowY: "auto",
            }}
            className="fixed z-[900] rounded-lg border border-border-primary bg-dropdown-bg shadow-xl p-3 text-[11px] space-y-2.5"
          >
            <div className="flex items-center justify-between">
              <span className="text-text-primary text-xs font-medium">资源使用率</span>
              <span className="text-text-tertiary">
                {s.deltaReady ? `间隔 ${(s.elapsedMs / 1000).toFixed(1)}s` : "差值未就绪"} · 只读
              </span>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-text-secondary">
                  CPU <span className={tone(s.cpu)}>{pct(s.cpu)}</span>
                  {cpuChartMax(history.map((h) => h.cpu)) < 100 && (
                    <span className="ml-1 text-text-tertiary">
                      刻度 {cpuChartMax(history.map((h) => h.cpu))}%
                    </span>
                  )}
                </span>
                <Spark
                  values={history.map((h) => h.cpu)}
                  max={cpuChartMax(history.map((h) => h.cpu))}
                  color="var(--accent)"
                />
              </div>
              <Row
                label="核心 / 负载"
                value={`${s.cores} 核`}
                extra={`${s.load[0].toFixed(2)} ${s.load[1].toFixed(2)} ${s.load[2].toFixed(2)}`}
              />
              <Row
                label="iowait / steal"
                value={`${s.iowait.toFixed(1)}% / ${s.steal.toFixed(1)}%`}
              />
            </div>

            <div className="space-y-1 border-t border-border-primary pt-2">
              <div className="flex items-center justify-between">
                <span className="text-text-secondary">
                  内存 <span className={tone(memPct)}>{pct(memPct)}</span>
                </span>
                <Spark
                  values={history.map((h) =>
                    h.memTotalKb > 0 ? (h.memUsedKb / h.memTotalKb) * 100 : 0
                  )}
                  max={100}
                  color="var(--success)"
                />
              </div>
              <Row
                label="已用 / 总量"
                value={`${formatKb(s.memUsedKb)} / ${formatKb(s.memTotalKb)}`}
              />
              <Row label="缓存" value={formatKb(s.memCachedKb)} />
              {s.swapTotalKb > 0 && (
                <Row
                  label="交换分区"
                  value={`${formatKb(s.swapUsedKb)} / ${formatKb(s.swapTotalKb)}`}
                />
              )}
            </div>

            <div className="space-y-1 border-t border-border-primary pt-2">
              <div className="flex items-center justify-between">
                <span className="text-text-secondary">
                  磁盘 <span className={tone(diskPct)}>{pct(diskPct)}</span>
                  <span className="ml-1 text-text-tertiary">{s.diskMount}</span>
                </span>
                <Spark values={history.map((h) => h.diskPct)} max={100} color="var(--warning)" />
              </div>
              {s.disks.length > 0 ? (
                s.disks.slice(0, 4).map((d) => (
                  <div key={d.mount} className="flex items-baseline justify-between gap-2">
                    <span className="text-text-tertiary truncate min-w-0" title={`${d.fs} → ${d.mount}`}>
                      {d.mount}
                    </span>
                    <span className="tabular-nums text-text-primary shrink-0">
                      {formatKb(d.usedKb)} / {formatKb(d.totalKb)}
                      <span className={`ml-1.5 ${tone(d.usePct)}`}>{pct(d.usePct)}</span>
                    </span>
                  </div>
                ))
              ) : (
                <Row label="分区" value="无本地分区数据" />
              )}
            </div>

            <div className="space-y-1 border-t border-border-primary pt-2">
              <div className="flex items-center justify-between">
                <span className="text-text-secondary">网络</span>
                <Spark
                  values={history.map((h) => h.netRxBps + h.netTxBps)}
                  color="var(--accent-text)"
                />
              </div>
              <Row label="下行" value={formatRate(s.netRxBps)} />
              <Row label="上行" value={formatRate(s.netTxBps)} />
            </div>

            <div className="space-y-1 border-t border-border-primary pt-2">
              <div className="flex items-center justify-between">
                <span className="text-text-secondary">
                  IO <span className={tone(s.ioUtil)}>{pct(s.ioUtil)}</span>
                </span>
                <Spark values={history.map((h) => h.ioUtil)} max={100} color="var(--danger)" />
              </div>
              <Row label="读 / 写" value={`${formatRate(s.ioReadBps)} / ${formatRate(s.ioWriteBps)}`} />
              <Row label="IOPS" value={s.iops.toFixed(0)} />
              {s.ioBusiest && <Row label="最忙设备" value={s.ioBusiest} />}
            </div>

            <div className="border-t border-border-primary pt-2 text-text-tertiary">
              运行 {formatUptime(s.uptime)} · 数据源 /proc
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

function formatUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分`;
}
