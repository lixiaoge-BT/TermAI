import { useEffect, useRef, useState, useMemo } from "react";
import {
  Bot,
  Play,
  Square,
  Loader2,
  CheckCircle2,
  XCircle,
  SkipForward,
  ShieldAlert,
  Shield,
  AlertTriangle,
  AlertOctagon,
  ChevronDown,
  ChevronRight,
  Copy,
  Trash2,
  Cpu,
  HardDrive,
  Gauge,
  ShieldCheck,
  Activity,
  TerminalSquare,
  ClipboardList,
  Layers,
  Download,
} from "lucide-react";
import type { RiskLevel } from "@/services/safety";
import { useSessionAgent, useSessionLiveThought, type AgentStep } from "@/store/agent";
import { useAppConfig } from "@/store/config";
import { renderMarkdownToHtml } from "@/lib/markdown";
import { busyHint } from "@/lib/busyHint";
import { exportAgentRun, type ExportRunInput } from "@/lib/exportRun";

const RISK_META: Record<
  RiskLevel,
  { label: string; text: string; bg: string; border: string; icon: React.ComponentType<{ size?: number | string; className?: string }> }
> = {
  none: { label: "只读", text: "text-success-text", bg: "bg-success-10", border: "border-success/40", icon: Shield },
  low: { label: "低风险", text: "text-text-link", bg: "bg-accent-20", border: "border-accent/40", icon: CheckCircle2 },
  medium: { label: "中风险", text: "text-warning-text", bg: "bg-warning-10", border: "border-warning/40", icon: AlertTriangle },
  high: { label: "高风险", text: "text-danger-text", bg: "bg-danger/10", border: "border-danger/40", icon: ShieldAlert },
  critical: { label: "致命", text: "text-danger-text", bg: "bg-danger/20", border: "border-danger", icon: AlertOctagon },
};

const PHASE_META: Record<string, { label: string; className: string }> = {
  idle: { label: "待命中", className: "text-text-secondary bg-bg-hover" },
  running: { label: "接管执行中", className: "text-text-link bg-accent-20" },
  "awaiting-confirm": { label: "等待你确认", className: "text-warning-text bg-warning-10" },
  done: { label: "已完成", className: "text-success-text bg-success-10" },
  stopped: { label: "已停止", className: "text-text-secondary bg-bg-hover" },
  error: { label: "执行出错", className: "text-danger-text bg-danger/10" },
};

const QUICK_TASKS = [
  { icon: Cpu, label: "分析系统资源", goal: "全面分析这台主机的 CPU、内存、负载情况，找出资源瓶颈并给出优化建议" },
  { icon: HardDrive, label: "磁盘空间诊断", goal: "检查磁盘使用率，找出占用空间最大的目录和文件，给出清理建议" },
  { icon: Gauge, label: "性能瓶颈排查", goal: "排查系统性能瓶颈：负载、CPU、内存、磁盘 IO、网络连接的整体健康状况" },
  { icon: Activity, label: "服务与端口巡检", goal: "列出正在监听的端口和对应服务，检查是否有异常或不必要的服务在运行" },
  { icon: ShieldCheck, label: "安全基线巡检", goal: "做一次只读的安全基线巡检：SSH 配置、登录失败记录、可疑账号与提权风险" },
  { icon: ClipboardList, label: "系统信息总览", goal: "收集并汇总这台主机的系统信息：发行版、内核、CPU、内存、磁盘、运行时长" },
];

/**
 * Agent 面板需要的会话信息（只含标量字段）。
 * 刻意不传整个 session 对象：终端每来一块输出都会生成新的 session 对象，
 * 传整棵会让面板（含全部步骤卡片）跟着每一块输出重渲染。
 */
export interface AgentSessionLite {
  id: string | null;
  hostId?: string | null;
  username?: string;
  host?: string;
  hostName?: string;
  connected?: boolean;
}

/** token 数量的人类可读格式：1234 → 1.2k */
function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * 忙碌计时：spinner 只说明「在转」，说明不了「卡住了没有」。
 * `resetKey` 变化即清零 —— 现在传的是 `stageSince`（阶段开始时间），
 * 所以数字永远对得上「当前这一阶段等了多久」，不会把执行/压缩/重连算成模型慢。
 * 传入 `since` 时按其绝对时间算起：面板切回来（重新挂载）也能看到真实已等时长。
 */
function useBusySeconds(active: boolean, resetKey: unknown, since?: number): number {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!active) {
      setSec(0);
      return;
    }
    const t0 = since ?? Date.now();
    setSec(Math.max(0, Math.floor((Date.now() - t0) / 1000)));
    const id = setInterval(() => setSec(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [active, resetKey, since]);
  return sec;
}

export function AgentPanel({
  session,
  hostConfig: _hostConfig,
  isProduction,
}: {
  session: AgentSessionLite | null;
  hostConfig: ReturnType<typeof useAppConfig.getState>["hosts"][number] | null;
  isProduction?: boolean;
}) {
  const {
    phase,
    goal,
    submittedGoal,
    steps,
    summary,
    error,
    autoRunMedium,
    pendingConfirm,
    plan,
    metrics,
    runId,
    startedAt,
    stage,
    stageSince,
    setGoal,
    setAutoRunMedium,
    run,
    stop,
    resolveConfirm,
    reset,
    clearError,
  } = useSessionAgent(session?.id ?? null);

  const stepsEndRef = useRef<HTMLDivElement>(null);
  const busy = phase === "running" || phase === "awaiting-confirm";
  // 计时锚点用「阶段开始时间」：每轮模型调用、每次执行/压缩/重连都会刷新它，
  // 没有时（刚启动）退回步骤数。数字与标签必须能互相解释，否则就是误报。
  const waitedSec = useBusySeconds(busy, stageSince ?? steps.length, stageSince);
  const busyInfo = busyHint(stage, phase, waitedSec);
  const phaseMeta = PHASE_META[phase] ?? PHASE_META.idle;

  // 导出：默认落到用户选的目录，成功后把路径显示出来（否则用户不知道文件去哪了）
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<{ ok: boolean; text: string } | null>(null);
  const canExport = steps.length > 0 || !!summary;

  const doExport = async () => {
    if (!canExport || exporting) return;
    setExporting(true);
    setExportNote(null);
    try {
      const input: ExportRunInput = {
        goal: submittedGoal || goal,
        plan,
        summary,
        // AgentStep 与 ExportableStep 字段一致，这里只做类型收窄
        steps,
        host: session?.host,
        hostName: session?.hostName,
        user: session?.username,
        startedAt,
        finishedAt: Date.now(),
        metricsLine:
          metrics.llmCalls > 0
            ? `LLM ${metrics.llmCalls} 次 / ${(metrics.llmMs / 1000).toFixed(1)}s`
            : "",
        runId,
      };
      const res = await exportAgentRun(input);
      if (res.canceled) return;
      if (!res.ok) {
        setExportNote({ ok: false, text: `导出失败：${res.error ?? "未知错误"}` });
        return;
      }
      setExportNote({
        ok: true,
        text: `已导出到 ${res.dir}（report.html / report.md / report.docx）`,
      });
    } finally {
      setExporting(false);
    }
  };

  // 新步骤产生时自动滚动到底部
  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [steps.length, summary, submittedGoal]);

  const start = (text?: string) => {
    if (text) setGoal(text);
    void run();
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 快捷任务 */}
      <div className="px-3 py-2 border-b border-border-primary flex items-center gap-2 overflow-x-auto flex-shrink-0">
        {QUICK_TASKS.map((t) => (
          <button
            key={t.label}
            disabled={busy}
            onClick={() => {
              setGoal(t.goal);
              if (!session?.connected) return;
              void run();
            }}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-full bg-bg-tertiary border border-border-primary hover:border-accent hover:text-accent-text text-text-secondary flex-shrink-0 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
            title={t.goal}
          >
            <t.icon size={12} />
            {t.label}
          </button>
        ))}
      </div>

      {/* 步骤时间线 / 总结 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {steps.length === 0 && !summary && phase === "idle" && (
          <EmptyGuide connected={!!session?.connected} />
        )}

        {/* 任务目标：提交后输入框会清空，这里保留本次任务的上下文 */}
        {submittedGoal && (
          <div className="rounded-lg border border-border-primary bg-bg-tertiary px-3 py-2">
            <div className="text-[10px] text-text-tertiary mb-0.5">任务目标</div>
            <div className="text-xs text-text-primary leading-relaxed whitespace-pre-wrap">
              {submittedGoal}
            </div>
          </div>
        )}

        {/* 执行计划蓝图：AI 接管初期输出的 <<<PLAN>>>，作为进度参照展示 */}
        {plan && <PlanCard plan={plan} />}

        {steps.map((step) => (
          <StepCard key={step.id} step={step} />
        ))}

        {/* AI 正在生成时实时展示流式文本（模型返回完整结果前）。
            单独订阅 liveThought：它 60ms 刷一次，留在面板主 selector 里
            会让整个步骤列表跟着流式输出重渲染。 */}
        <LiveThoughtCard sessionId={session?.id ?? null} />

        {busy && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-tertiary border border-border-primary text-xs text-text-secondary">
            <Loader2 size={13} className="animate-spin text-text-link shrink-0" />
            <span className="truncate min-w-0">{busyInfo.label}</span>
            {waitedSec >= 3 && (
              <span
                className={`ml-auto whitespace-nowrap tabular-nums ${
                  busyInfo.warn ? "text-warning-text" : "text-text-tertiary"
                }`}
                title="当前阶段已等待时长（切换阶段或进入新一轮时重新计时）"
              >
                {waitedSec}s{busyInfo.hint}
              </span>
            )}
          </div>
        )}

        {pendingConfirm && (
          <ConfirmCard
            command={pendingConfirm.command}
            risk={pendingConfirm.risk}
            riskDescription={pendingConfirm.riskDescription}
            confirmationItems={pendingConfirm.confirmationItems}
            onRun={() => resolveConfirm("run")}
            onSkip={() => resolveConfirm("skip")}
            onAbort={() => resolveConfirm("abort")}
          />
        )}

        {summary && <SummaryCard summary={summary} stale={busy} onExport={doExport} exporting={exporting} />}
        <div ref={stepsEndRef} />
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="px-3 py-2 mx-3 mb-2 text-xs rounded bg-danger/10 border border-danger/30 text-danger-text flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          <div className="flex-1 whitespace-pre-wrap">{error}</div>
          <button onClick={clearError} className="text-danger-text/70 hover:text-danger">
            ×
          </button>
        </div>
      )}

      {/* 选项条 */}
      <div className="px-3 pb-1 flex items-center gap-3 text-[11px] text-text-secondary flex-shrink-0">
        <label className="inline-flex items-center gap-1 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoRunMedium}
            disabled={busy}
            onChange={(e) => setAutoRunMedium(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          中风险自动执行
        </label>
        <span className="ml-auto inline-flex items-center gap-1">
          <span className={`px-1.5 py-0.5 rounded ${phaseMeta.className}`}>{phaseMeta.label}</span>
          {steps.length > 0 && <span>{steps.length} 步</span>}
          {metrics.llmCalls > 0 && (
            <span
              className="text-text-tertiary cursor-help"
              title={
                `LLM 调用 ${metrics.llmCalls} 次，累计 ${(metrics.llmMs / 1000).toFixed(1)}s\n` +
                `其中上下文压缩 ${metrics.compressCalls} 次、${(metrics.compressMs / 1000).toFixed(1)}s\n` +
                `token：输入 ${metrics.promptTokens} / 输出 ${metrics.completionTokens}` +
                (metrics.promptTokens === 0 ? "\n（网关未返回 usage，token 数据不可用）" : "")
              }
            >
              · AI {(metrics.llmMs / 1000).toFixed(1)}s
              {metrics.compressMs > 0 && `（压缩 ${(metrics.compressMs / 1000).toFixed(1)}s）`}
              {(metrics.promptTokens > 0 || metrics.completionTokens > 0) &&
                ` · ${formatTokens(metrics.promptTokens + metrics.completionTokens)} tok`}
            </span>
          )}
        </span>
      </div>

      {/* 导出结果提示：成功时带完整路径，用户才知道文件去哪了 */}
      {exportNote && (
        <div
          className={`px-3 pb-1 text-[10px] truncate flex-shrink-0 ${
            exportNote.ok ? "text-text-tertiary" : "text-danger-text"
          }`}
          title={exportNote.text}
        >
          {exportNote.text}
        </div>
      )}

      {/* 目标输入 */}
      <div className="border-t border-border-primary p-2 flex-shrink-0">
        <div className="bg-bg-tertiary border border-border-primary focus-within:border-accent rounded-lg overflow-hidden">
          <textarea
            rows={2}
            value={goal}
            disabled={busy}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                start();
              }
            }}
            placeholder="描述要让 AI 完成的目标，例如：分析系统资源情况并给出优化建议"
            className="w-full bg-transparent p-2.5 text-sm outline-none resize-none placeholder:text-text-tertiary text-text-primary disabled:opacity-60"
          />
          <div className="flex items-center justify-between px-2 py-1.5 border-t border-border-primary/50">
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  stop();
                  reset();
                }}
                disabled={busy}
                className="p-1 text-text-secondary hover:text-danger-text rounded hover:bg-bg-hover disabled:opacity-40"
                title="清空任务记录"
              >
                <Trash2 size={14} />
              </button>
              <button
                onClick={() => void doExport()}
                disabled={!canExport || exporting}
                className="p-1 text-text-secondary hover:text-accent-text rounded hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed"
                title="导出报告（HTML / Markdown / Word 三种格式，含完整输出）"
              >
                {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              </button>
              <span className="text-[10px] text-text-secondary inline-flex items-center gap-1">
                <TerminalSquare size={11} />
                {session?.connected
                  ? `将在 ${session.username}@${session.hostName || session.host} 上真实执行`
                  : "未连接终端"}
              </span>
              {isProduction && (
                <span className="text-[10px] px-1 rounded bg-danger/15 text-danger-text">PROD</span>
              )}
            </div>
            {busy ? (
              <button
                onClick={stop}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-danger hover:bg-danger-hover text-white"
              >
                <Square size={12} />
                停止
              </button>
            ) : (
              <button
                onClick={() => start()}
                disabled={!goal.trim()}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-accent hover:bg-accent-hover disabled:bg-bg-hover disabled:text-text-tertiary disabled:cursor-not-allowed text-white"
              >
                <Play size={12} />
                开始接管
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyGuide({ connected }: { connected: boolean }) {
  return (
    <div className="text-center text-xs text-text-secondary py-6 px-2">
      <div
        className="w-12 h-12 mx-auto mb-3 rounded-xl flex items-center justify-center"
        style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-hover))" }}
      >
        <Bot size={22} className="text-white" />
      </div>
      <div className="text-sm text-text-primary font-semibold mb-1.5">终端接管 Agent</div>
      <div className="leading-relaxed">
        {connected
          ? "给我一个目标，我会自己决定要在终端里执行哪些命令，逐条真实执行并读取输出，最后输出结论与优化建议。"
          : "请先在左侧连接一台 SSH 主机 —— Agent 需要在真实终端里执行命令。"}
      </div>
      <div className="mt-3 text-left inline-block text-[11px] leading-relaxed text-text-tertiary">
        · 只读命令自动执行，中风险可配置，高风险会先问你
        <br />· 每一步的执行过程都会实时显示在当前终端窗口中
        <br />· 生产环境主机自动降级为只读诊断模式
      </div>
    </div>
  );
}

function StepCard({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(true);
  const meta = RISK_META[step.risk] ?? RISK_META.low;
  const running = step.status === "running";

  // 步骤完成后自动折叠输出，避免刷屏
  useEffect(() => {
    if (step.status === "done" || step.status === "failed" || step.status === "skipped") {
      setOpen(false);
    }
  }, [step.status]);

  const duration =
    step.startedAt && step.finishedAt ? `${((step.finishedAt - step.startedAt) / 1000).toFixed(1)}s` : null;

  const StatusIcon =
    step.status === "done"
      ? CheckCircle2
      : step.status === "failed"
      ? XCircle
      : step.status === "skipped"
      ? SkipForward
      : step.status === "running"
      ? Loader2
      : meta.icon;

  const statusText =
    step.status === "done"
      ? "text-success-text"
      : step.status === "failed"
      ? "text-danger-text"
      : step.status === "skipped"
      ? "text-text-tertiary"
      : step.status === "running"
      ? "text-text-link"
      : "text-text-secondary";

  const hasTimeout = step.items.some((it) => it.timedOut);

  return (
    <div className="rounded-lg border border-border-primary bg-bg-tertiary overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 px-2.5 py-2 text-left hover:bg-bg-hover transition-colors"
      >
        <span className="mt-0.5 w-4 h-4 flex-shrink-0 rounded-full bg-bg-hover border border-border-primary text-[10px] flex items-center justify-center text-text-secondary">
          {step.index}
        </span>
        <div className="flex-1 min-w-0">
          {step.thought && (
            <div className="text-[11px] text-text-secondary mb-1 line-clamp-2">{step.thought}</div>
          )}
          <div className="font-mono text-[11px] text-text-primary break-all whitespace-pre-wrap">
            {step.items.slice(0, 3).map((it, i) => (
              <div key={i}>$ {it.command}</div>
            ))}
            {step.items.length > 3 && (
              <div className="text-text-tertiary">…还有 {step.items.length - 3} 条</div>
            )}
          </div>
          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
            <span
              className={`inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded border ${meta.bg} ${meta.border} ${meta.text}`}
            >
              <meta.icon size={9} />
              {meta.label}
            </span>
            {step.batched && (
              <span className="inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded border border-accent/40 bg-accent-20 text-text-link">
                <Layers size={9} />
                批量 {step.items.length} 条
              </span>
            )}
            <span className={`inline-flex items-center gap-0.5 text-[10px] ${statusText}`}>
              <StatusIcon size={10} className={running ? "animate-spin" : ""} />
              {step.status === "done"
                ? step.items.some((it) => it.exitCode !== null && it.exitCode !== 0)
                  ? "已执行（部分返回非 0）"
                  : "已执行"
                : step.status === "failed"
                ? step.items.find((it) => it.error)?.error ?? "执行失败"
                : step.status === "skipped"
                ? step.items.find((it) => it.error)?.error ?? "已跳过"
                : step.status === "running"
                ? "执行中"
                : "等待中"}
            </span>
            {hasTimeout && <span className="text-[10px] text-warning-text">输出超时</span>}
            {duration && <span className="text-[10px] text-text-tertiary">{duration}</span>}
          </div>
        </div>
        {open ? (
          <ChevronDown size={13} className="text-text-secondary flex-shrink-0 mt-0.5" />
        ) : (
          <ChevronRight size={13} className="text-text-secondary flex-shrink-0 mt-0.5" />
        )}
      </button>

      {open && (
        <div className="border-t border-border-primary bg-bg-secondary divide-y divide-border-primary">
          {step.items.map((it, i) => (
            <div key={i} className="p-2.5">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="font-mono text-[11px] text-text-primary break-all">
                  $ {it.command}
                </span>
                {it.exitCode !== null && it.exitCode !== 0 && (
                  <span className="text-[10px] text-danger-text flex-shrink-0">
                    退出码 {it.exitCode}
                  </span>
                )}
                {it.status === "running" && (
                  <Loader2 size={10} className="animate-spin text-text-link flex-shrink-0" />
                )}
                {it.timedOut && (
                  <span className="text-[10px] text-warning-text flex-shrink-0">超时</span>
                )}
              </div>
              <pre className="max-h-56 overflow-auto font-mono text-[11px] text-text-secondary whitespace-pre-wrap break-all">
                {it.output ||
                  (it.status === "running"
                    ? "等待输出..."
                    : it.status === "skipped"
                    ? it.error ?? "已跳过"
                    : "(无输出)")}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConfirmCard({
  command,
  risk,
  riskDescription,
  confirmationItems,
  onRun,
  onSkip,
  onAbort,
}: {
  command: string;
  risk: RiskLevel;
  riskDescription: string;
  confirmationItems: string[];
  onRun: () => void;
  onSkip: () => void;
  onAbort: () => void;
}) {
  const meta = RISK_META[risk] ?? RISK_META.medium;
  return (
    <div className="rounded-lg border border-danger/50 bg-danger/10 overflow-hidden">
      <div className="px-3 py-2 border-b border-danger/30 flex items-center gap-2">
        <meta.icon size={14} className={meta.text} />
        <span className={`text-xs font-semibold ${meta.text}`}>
          {meta.label}命令需要你确认
        </span>
      </div>
      <div className="px-3 py-2">
        {/* heredoc 写服务单元这类命令会很长：必须限高 + 可滚动，
            否则确认卡把整个面板撑满，用户反而看不到「确认」按钮。 */}
        <pre className="font-mono text-[11px] text-text-primary whitespace-pre-wrap break-all bg-bg-secondary border border-border-primary rounded p-2 max-h-52 overflow-auto">
          {command}
        </pre>
        <div className="mt-2 text-[11px] text-text-secondary">{riskDescription}</div>
        {confirmationItems.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 text-[11px] text-text-secondary">
            {confirmationItems.map((it, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span className="text-danger-text">▪</span>
                {it}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex justify-end items-center gap-2 px-3 py-2 border-t border-danger/30">
        {/* 明确告知会自动超时：否则用户以为可以无限挂着，回来发现任务已被终止。 */}
        <span className="mr-auto min-w-0 text-[10px] text-text-tertiary leading-snug">
          10 分钟内未确认将自动终止（避免无人值守时执行高危命令）
        </span>
        {/* 按钮必须 shrink-0 + nowrap：窄面板下否则「确认执行」会被压成两行 */}
        <button
          onClick={onAbort}
          className="shrink-0 whitespace-nowrap px-2.5 py-1 text-[11px] rounded border border-border-primary hover:bg-bg-hover text-text-secondary"
        >
          终止任务
        </button>
        <button
          onClick={onSkip}
          className="shrink-0 whitespace-nowrap px-2.5 py-1 text-[11px] rounded border border-border-primary hover:bg-bg-hover text-text-secondary"
        >
          跳过这步
        </button>
        <button
          onClick={onRun}
          className="shrink-0 whitespace-nowrap px-2.5 py-1 text-[11px] rounded bg-danger hover:bg-danger-hover text-white font-medium"
        >
          确认执行
        </button>
      </div>
    </div>
  );
}

function PlanCard({ plan }: { plan: string }) {
  const html = useMemo(() => renderMarkdownToHtml(plan), [plan]);
  return (
    <div className="rounded-lg border border-accent/40 bg-bg-tertiary overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border-primary">
        <ClipboardList size={13} className="text-text-link" />
        <span className="text-xs font-semibold text-text-primary">执行计划</span>
        <span className="ml-auto text-[10px] text-text-tertiary">AI 将按计划逐步执行</span>
      </div>
      <div
        className="p-3 text-xs text-text-primary"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function SummaryCard({
  summary,
  stale,
  onExport,
  exporting,
}: {
  summary: string;
  stale?: boolean;
  onExport?: () => void;
  exporting?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  // 总结内容不随渲染变化，缓存 markdown 解析结果，避免每次父组件重渲染都重算
  const html = useMemo(() => renderMarkdownToHtml(summary), [summary]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  };

  return (
    <div className="rounded-lg border border-accent/40 bg-bg-tertiary overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-primary">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-text-primary">
          <CheckCircle2 size={13} className="text-success-text" />
          任务总结
          {stale && (
            <span className="text-[10px] font-normal text-text-tertiary">
              （上一轮的结论，新一轮仍在执行）
            </span>
          )}
        </span>
        <span className="inline-flex items-center gap-1">
          {onExport && (
            <button
              onClick={onExport}
              disabled={exporting}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-border-primary hover:bg-bg-hover text-text-secondary disabled:opacity-50"
              title="导出为文件（HTML / Markdown / Word，含完整输出）"
            >
              {exporting ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
              导出
            </button>
          )}
          <button
            onClick={copy}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-border-primary hover:bg-bg-hover text-text-secondary"
          >
            <Copy size={11} />
            {copied ? "已复制" : "复制"}
          </button>
        </span>
      </div>
      <div
        className="p-3 text-xs text-text-primary"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function LiveThoughtCard({ sessionId }: { sessionId: string | null }) {
  const text = useSessionLiveThought(sessionId);
  // 流式文本实时渲染（节流由 store 端控制，这里只负责展示）
  const html = useMemo(() => (text ? renderMarkdownToHtml(text) : ""), [text]);
  if (!text) return null;
  return (
    <div className="rounded-lg border border-accent/30 bg-bg-tertiary overflow-hidden opacity-90">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border-primary text-[11px] text-text-secondary">
        <Loader2 size={11} className="animate-spin text-text-link" />
        AI 思考中…
      </div>
      <div
        className="p-3 text-xs text-text-primary"
        dangerouslySetInnerHTML={{ __html: html + '<span class="inline-block w-1.5 h-3 ml-0.5 align-middle bg-text-link animate-pulse" />' }}
      />
    </div>
  );
}
