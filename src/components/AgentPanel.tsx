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
} from "lucide-react";
import type { RiskLevel } from "@/services/safety";
import { useSessionAgent, type AgentStep } from "@/store/agent";
import { useTerminalStore } from "@/store/terminal";
import { useAppConfig } from "@/store/config";
import { renderMarkdownToHtml } from "@/lib/markdown";

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

export function AgentPanel({
  session,
  hostConfig: _hostConfig,
  isProduction,
}: {
  session: ReturnType<typeof useTerminalStore.getState>["sessions"][number] | null;
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
    liveThought,
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
  const phaseMeta = PHASE_META[phase] ?? PHASE_META.idle;

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

        {steps.map((step) => (
          <StepCard key={step.id} step={step} />
        ))}

        {/* AI 正在生成时实时展示流式文本（模型返回完整结果前） */}
        {liveThought && <LiveThoughtCard text={liveThought} />}

        {busy && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-tertiary border border-border-primary text-xs text-text-secondary">
            <Loader2 size={13} className="animate-spin text-text-link" />
            {phase === "awaiting-confirm" ? "等待你确认下一条命令..." : "AI 正在分析并执行..."}
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

        {summary && <SummaryCard summary={summary} />}
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
        </span>
      </div>

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
                  ? "完成（部分命令返回非 0）"
                  : "执行完成"
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
        <pre className="font-mono text-[11px] text-text-primary whitespace-pre-wrap break-all bg-bg-secondary border border-border-primary rounded p-2">
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
      <div className="flex justify-end gap-2 px-3 py-2 border-t border-danger/30">
        <button
          onClick={onAbort}
          className="px-2.5 py-1 text-[11px] rounded border border-border-primary hover:bg-bg-hover text-text-secondary"
        >
          终止任务
        </button>
        <button
          onClick={onSkip}
          className="px-2.5 py-1 text-[11px] rounded border border-border-primary hover:bg-bg-hover text-text-secondary"
        >
          跳过这步
        </button>
        <button
          onClick={onRun}
          className="px-2.5 py-1 text-[11px] rounded bg-danger hover:bg-danger-hover text-white font-medium"
        >
          确认执行
        </button>
      </div>
    </div>
  );
}

function SummaryCard({ summary }: { summary: string }) {
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
        </span>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-border-primary hover:bg-bg-hover text-text-secondary"
        >
          <Copy size={11} />
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <div
        className="p-3 text-xs text-text-primary"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function LiveThoughtCard({ text }: { text: string }) {
  // 流式文本实时渲染（节流由 store 端控制，这里只负责展示）
  const html = useMemo(() => renderMarkdownToHtml(text), [text]);
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
