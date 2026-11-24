import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { AIProviderConfig } from "@/types";
import type { RiskLevel } from "@/services/safety";
import { reviewCommand, isBinaryDumpCommand, isEchoFragment } from "@/services/safety";
import { chatCompletionRaw, thinkingDisableExtra } from "@/services/ai";
import {
  buildAgentSystemPrompt,
  AGENT_MAX_BATCH_COMMANDS,
  AGENT_MAX_SUB_COMMANDS_PER_LINE,
} from "@/services/prompts";
import {
  shouldCompress,
  buildCompressionMessages,
  assembleCompressedMessages,
  renderTranscript,
  isSummaryMessage,
  extractSummary,
  estimateMessagesTokens,
  estimateContextWindow,
  trimMessages as trimMessagesPure,
} from "@/lib/contextCompression";
import {
  buildObservation,
  createDupTracker,
  createFailTreadmill,
  digestFailure,
  digestOutput,
  execCommand,
  execCommandBatch,
  isExecOk,
  isStateChanging,
  isNoInfoProbeOutput,
  busyMountHint,
  serviceDiagHint,
  parseAgentReply,
  pickLedgerLines,
  probeTargetOf,
  sanitizeCommandLine,
  sanitizeOutput,
  shellIncomplete,
  stepBudgetFor,
  type DupReason,
  type ExecResult,
} from "@/services/agent";
import { useAppConfig } from "./config";
import { findDeferrableCommands } from "@/lib/manualPush";
import { findEnumeration, suggestLoopRewrite } from "@/lib/bulkEnum";
import { useTerminalStore } from "./terminal";
import {
  envProbeCoveredBy,
  envProbeKind,
  extractHostFacts,
  hasAnyFact,
  mergeHostFacts,
  renderHostFacts,
  type HostFacts,
} from "@/lib/hostFacts";

export type AgentPhase = "idle" | "running" | "awaiting-confirm" | "done" | "stopped" | "error";

/**
 * 忙碌细分阶段。原先 UI 只有一个「AI 正在分析并执行…」，计时只按「步骤数变化」清零，
 * 于是执行命令、压缩上下文、等待重连、甚至只回计划不建步骤的轮次全被算成「模型响应慢」，
 * 用户看到的就是莫名其妙飙升的 63s。拆开后每个数字都能对上具体动作。
 */
export type AgentBusyStage = "thinking" | "exec" | "compress" | "confirm" | "reconnect";

export type AgentStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

/** 一个步骤里的一条命令（批量探测时一个步骤会有多条） */
export interface AgentCommandItem {
  command: string;
  risk: RiskLevel;
  status: AgentStepStatus;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

export interface AgentStep {
  id: string;
  index: number;
  thought: string;
  /** 本步执行的命令列表：批量只读探测时为多条，其余情况为一条 */
  items: AgentCommandItem[];
  /** 本步所有命令里的最高风险 */
  risk: RiskLevel;
  /** 是否为批量只读探测（一次往返跑完多条） */
  batched: boolean;
  status: AgentStepStatus;
  startedAt?: number;
  finishedAt?: number;
}

export interface PendingConfirm {
  stepId: string;
  command: string;
  risk: RiskLevel;
  riskDescription: string;
  confirmationItems: string[];
}

export type ConfirmDecision = "run" | "skip" | "abort";

/**
 * 任务级性能度量。
 *
 * 这个循环有两个不显眼的耗时来源，此前完全不可观测：
 *  · 每一轮都要把 system + 计划 + 命令清单 + 全部历史**重新 prefill 一遍**；
 *  · 上下文压缩本身是**一次完整的额外 LLM 调用**，而且卡在主链路上（await 等它返回）。
 * 没有度量就只能凭感觉猜「慢在哪」，所以先把它们记下来 —— 这是后续所有优化的判据。
 */
export interface AgentMetrics {
  /** 主循环里的 LLM 调用次数与累计耗时 */
  llmCalls: number;
  llmMs: number;
  /** 其中属于「上下文压缩」的调用次数与累计耗时（隐藏成本） */
  compressCalls: number;
  compressMs: number;
  /** token 用量（需要网关在响应里返回 usage，拿不到时保持 0） */
  promptTokens: number;
  completionTokens: number;
}

const EMPTY_METRICS: AgentMetrics = {
  llmCalls: 0,
  llmMs: 0,
  compressCalls: 0,
  compressMs: 0,
  promptTokens: 0,
  completionTokens: 0,
};

/** 每个终端会话独立持有一份 Agent 任务状态 */
export interface AgentBucket {
  phase: AgentPhase;
  /** 输入框里待提交的目标 */
  goal: string;
  /** 本次任务实际提交的目标（提交后即使清空输入框也仍可回看） */
  submittedGoal: string;
  steps: AgentStep[];
  summary: string;
  error: string | null;
  pendingConfirm: PendingConfirm | null;
  /** AI 正在生成时的流式文本（模型返回完整结果前实时展示） */
  liveThought: string;
  /** 任务计划蓝图（<<<PLAN>>> 解析得到），展示在 UI 上作为进度参照 */
  plan: string;
  /**
   * 与模型的多轮对话历史（system + goal + 每轮 assistant 回复 + 命令执行观察）。
   * 持久化在本 bucket 里：让同一会话的多次 run（停止后「继续接管」/ 超时后续跑）
   * 能继承已有进展，不会因为每次重建 [system, goal] 而「失忆」。
   * 首次运行 / reset 后清空。
   */
  messages: ChatMessage[];
  /** 本轮任务的性能度量（耗时 / token），用于定位「慢在哪」 */
  metrics: AgentMetrics;
  /**
   * 已确认的主机画像（发行版 / 内核 / 架构 / 包管理器 / 容器运行时）。
   * 跨任务保留：换目标重跑不需要重新探测环境；`reset` 才清空。
   */
  facts?: HostFacts;
  /**
   * 本次任务的运行记录 id（`userData/agent-runs/<runId>/`）。
   *
   * UI 里的步骤输出被 capOutput 截到 4000 字符，完整文本另存到磁盘；
   * 导出时靠它把 `outputs/*.log` 一起带上。落盘通道不可用时为 undefined，
   * 导出退化为「只有截断片段」，功能照常可用。
   */
  runId?: string;
  /** 本次任务的开始时间（导出报告的「开始」时间用它，不用首次 step 的时间） */
  startedAt?: number;
  /**
   * 当前忙碌阶段。UI 的「等待 xx 秒」必须按阶段显示，而不是一律说「模型响应慢」：
   * 执行命令、压缩上下文、等待重连都不属于模型耗时，混在一起会让人误判成模型卡了。
   */
  stage?: AgentBusyStage;
  /** 进入当前阶段的时间戳：计时器按「阶段开始」重置，数字才和标签对得上 */
  stageSince?: number;
  /**
   * 本次任务里被硬闸门拒绝的命令（受保护路径等）。
   *
   * 这些命令**不会建 step**，所以 `steps` 里查不到 —— 换目标时若不显式带过去，
   * 新的一轮会完全不知道「上次有动作因为安全规则被拦了」，于是重新撞一遍同样的墙
   * （或者反过来，把手动清单当成自己没试过）。
   */
  blockedCommands?: string[];
}

// ChatMessage 的唯一定义放在 @/lib/contextCompression，这里引用，避免类型分叉。
import type { ChatMessage } from "@/lib/contextCompression";

export type { ChatMessage };

const EMPTY_BUCKET: AgentBucket = {
  phase: "idle",
  goal: "",
  submittedGoal: "",
  steps: [],
  summary: "",
  error: null,
  pendingConfirm: null,
  liveThought: "",
  plan: "",
  messages: [],
  metrics: EMPTY_METRICS,
};

interface AgentState {
  buckets: Record<string, AgentBucket>;
  /** 中风险命令自动执行（none/low 始终自动；high/critical 始终确认） */
  autoRunMedium: boolean;

  /** 内部：每个会话的中断控制器与确认回调 */
  abortRefs: Record<string, AbortController>;
  confirmResolvers: Record<string, (decision: ConfirmDecision) => void>;

  setGoal: (key: string, goal: string) => void;
  setAutoRunMedium: (v: boolean) => void;
  clearError: (key: string) => void;

  run: (sessionId: string) => Promise<void>;
  stop: (sessionId: string) => void;
  resolveConfirm: (sessionId: string, decision: ConfirmDecision) => void;
  reset: (sessionId: string) => void;
  /** 会话被关闭时调用：中断任务并释放资源 */
  dispose: (sessionId: string) => void;
}

const uid = () => `step_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const RISK_ORDER: RiskLevel[] = ["none", "low", "medium", "high", "critical"];

/** 取一组风险等级里最高的那个 */
function maxRisk(risks: RiskLevel[]): RiskLevel {
  return risks.reduce<RiskLevel>(
    (acc, r) => (RISK_ORDER.indexOf(r) > RISK_ORDER.indexOf(acc) ? r : acc),
    "none"
  );
}

/**
 * 退出码为 0 或没捕获到退出码（但也没抛异常）都算成功。
 *
 * 委托给 isExecOk：还必须检查**分段退出码**。`$?` 只反映最后一条子命令，
 * `rm /nope; du /tmp` 的末条成功会给出 exitCode 0 —— 若据此标绿并记入台账，
 * 模型就被喂了一个假成功，之后的判断全错。
 */
function isOk(res: ExecResult): boolean {
  return isExecOk(res);
}

/**
 * 接管前上下文：把终端里已有的输出（含用户手动输入的命令及其结果）拼成一条
 * 初始观察发给模型，让它对当前状态（cwd / 登录用户 / 已挂载文件系统等）有基本认知，
 * 避免「AI 无法阅读上下文」、重复已完成的操作或跑错地方。
 */
function buildHandoffContext(recentOutput?: string[]): string | null {
  if (!recentOutput || recentOutput.length === 0) return null;
  const budget = 8000;
  const picked: string[] = [];
  let used = 0;
  for (let i = recentOutput.length - 1; i >= 0; i--) {
    const line = recentOutput[i] ?? "";
    if (used + line.length + 1 > budget) break;
    used += line.length + 1;
    picked.push(line);
  }
  if (picked.length === 0) return null;
  picked.reverse();
  return [
    "## 接管开始时终端已存在的输出（含你接管前用户手动输入并执行过的命令及其结果）",
    "以下是你开始工作前终端里已有的内容，帮助你了解当前状态（如当前目录、登录用户、已挂载的文件系统、已存在的文件等）。请基于它开展工作，**不要重复其中已经完成的操作**。",
    "```",
    picked.join("\n"),
    "```",
  ].join("\n");
}

/**
 * 「换目标后重开」时给模型的**上一轮简报**。
 *
 * 为什么需要：`goalChanged` 会把上下文清成 system + 新目标 + 终端滚动内容。
 * 但用户最常见的操作恰恰是「接着上一轮的结论继续做」—— 上一轮总结刚说完
 * 「需要手动执行：创建 Xvnc.service」，用户下一句就是「你帮我建」。清空之后
 * 模型既看不到那句结论、也看不到自己已经做过什么，于是要么从头重做一遍，
 * 要么答非所问（用户感知就是「没有阅读上下文的能力，瞎回答」）。
 *
 * 也不能把旧对话整段塞回去：那正是早期「换目标仍接着干旧活」的根因
 * （见上面 goalChanged 的注释）。折中是给一份**结构化简报**（目标 / 结论 /
 * 已执行命令台账），并明确声明它只是背景、不是当前任务。
 */
export function buildPriorRunBrief(input: {
  submittedGoal: string;
  summary: string;
  steps: AgentStep[];
  /** 被硬闸门拒绝的命令（不建 step，必须单独带过去） */
  blockedCommands?: string[];
}): string | null {
  const goal = (input.submittedGoal ?? "").trim();
  const summary = (input.summary ?? "").trim();
  const hasSteps = input.steps.length > 0;
  const blocked = (input.blockedCommands ?? []).filter((c) => c.trim().length > 0).slice(0, 8);
  if (!goal && !summary && !hasSteps && blocked.length === 0) return null;

  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();

  const lines: string[] = [];
  if (goal) lines.push(`- 上一轮目标：${cut(flat(goal), 200)}`);
  if (summary) lines.push("- 上一轮结论：", "```md", cut(summary, 1600), "```");

  if (hasSteps) {
    // 台账只留「命令 + 一句结果」，最多 24 条：再多会盖过当前目标的注意力。
    const rows: string[] = [];
    for (const step of input.steps) {
      for (const it of step.items) {
        if (rows.length >= 24) break;
        const mark = it.status === "done" ? "✓" : it.status === "skipped" ? "⊘" : "✗";
        // 失败的命令取**错误行**而不是头部：`digestOutput` 恒定取前几行，
        // 而 yum/rpm/gcc 的报错都在末尾 —— 台账里给「Loaded plugins」等于什么都没给。
        const tail = it.error
          ? `错误：${cut(flat(it.error), 120)}`
          : it.status === "done"
            ? flat(digestOutput(it.output || "", 120, 2))
            : flat(digestFailure(it.output || "", 160));
        rows.push(`${mark} ${cut(flat(it.command), 100)}${tail ? ` → ${tail}` : ""}`);
      }
      if (rows.length >= 24) break;
    }
    if (rows.length > 0) lines.push("- 上一轮已执行过的命令：", ...rows);
  }

  if (blocked.length > 0) {
    lines.push(
      "- 上一轮被安全规则**拒绝**的命令（不会自动执行，别再原样重发）：",
      ...blocked.map((c) => `  ✗ ${cut(flat(c), 120)}`)
    );
  }

  return [
    "## 上一轮接管记录（背景资料）",
    "下面是你在**上一次接管**里做过的事。用户这次的话很可能就是在接着说这件事 ——" +
      "他说的「上面那个服务」「那几条命令」「你帮我弄一下」具体指什么，只能从这里判断。",
    "",
    ...lines,
    "",
    "**怎么用这份记录**：",
    "- 本次目标若是在上面的基础上继续（补完没做完的、解决上次那个报错、执行上次留下的命令）" +
      "→ **直接接着做**，不要从头重来，也不要重复已经成功的命令；",
    "- 本次目标若确实是另一件事 → 忽略上面的计划，只借用其中的环境事实（系统版本、已装的包、路径）；",
    "- 判断依据是**用户这次的原话**，不是上一轮的计划。拿不准时，先用一条只读命令确认当前现状再动手。",
  ].join("\n");
}

/**
 * 判断「用户这次说的是继续上一轮，还是换了件事」。
 *
 * 为什么需要：旧实现的判据是「目标字符串有没有变」—— 变了就当全新任务，把
 * messages / steps / summary 全清掉，只给一份简报。但用户最自然的动作恰恰是
 * **接着说**：「你先把冲突包卸了再装」「那几条命令执行掉」。一字之差就全清，
 * 体感就是「它把我刚才干的活忘了」。
 *
 * 又不能退回到「无论如何都继承旧对话」——早期正是那样，换目标后模型接着干旧活。
 * 所以判据取**明确的回指信号**，而不是语义相似度：
 * 新目标里出现「继续 / 接着 / 上面 / 那个 / 它 / 再试」这类词，才算接着上一轮。
 * 拿不准时一律按新任务处理 —— 误判成新任务的代价是「多说一句」，误判成续接的
 * 代价是「答非所问」，后者严重得多。
 */
const STRONG_CONTINUE_RE =
  /(继续|接着|再试|再来|再执行|再跑|再装|卸了再|上面|上述|刚才|之前|这个|那个|这几|那几|它|照做|按你说的|这步|那步)/;

export function judgeGoalRelation(input: {
  prevGoal: string;
  newGoal: string;
}): { relation: "continue" | "fresh"; reason: string } {
  const prev = (input.prevGoal ?? "").trim();
  const next = (input.newGoal ?? "").trim();
  if (!prev) return { relation: "fresh", reason: "没有上一轮目标" };
  if (next === prev) return { relation: "continue", reason: "目标未变" };
  const hit = next.match(STRONG_CONTINUE_RE);
  if (hit) return { relation: "continue", reason: `含承接语「${hit[1]}」` };
  return { relation: "fresh", reason: "没有承接语，按新任务处理" };
}

/**
 * 续跑指令：停止 / 超时后用户再次「开始接管」时，把当前目标作为新指令推进，
 * 并要求「不要重复已执行的命令」，基于已有进展继续。
 */
function buildResumeNote(goal: string, submittedGoal: string): string {
  const same = goal.trim() === submittedGoal.trim();
  const base = same
    ? "## 继续上一轮未完成的接管任务\n[系统] 用户要求继续上一轮未完成的任务。"
    : "## 用户补充 / 修正目标\n[系统] 用户在上一轮任务基础上补充了新的目标。";
  return (
    base +
    "请先回顾最近几轮你已执行的命令与它们的真实输出结果，再决定下一步；" +
    "**严禁重复执行已经跑过的命令**，只推进尚未完成的部分。" +
    `目标：${goal}`
  );
}

/**
 * 超时策略（内部固定，不在 UI 暴露）——刻意让用户「不用调」：
 *
 * 单条命令拆成两个独立阈值：
 * - **静默超时 120 秒**：超过 120s **且最近 3 秒没有新输出** 才判定卡死。
 * - **硬上限 15 分钟**：无论是否还在吐输出，到点就切。
 *
 * 旧实现两者同为 5 分钟，而熔断条件里 `elapsed >= maxTimeoutMs` 是**无条件**命中的，
 * 于是「还在正常下载/编译」的命令也会在第 5 分钟被切成半截 —— 慢镜像源的
 * `yum/apt install`、大 `tar`/`rsync`、`docker pull` 全都中招，模型还拿着半截输出
 * 去判断，结论自然错。两个阈值必须分离才有意义。
 *
 * 单个任务：20 分钟总时限。实测一次「装 Prometheus」光 yum 装包就 107 秒，
 * 12 分钟会被吃干净；20 分钟够跑完常规部署。到点自动停止、进度保留，可续跑。
 */
const COMMAND_IDLE_TIMEOUT_MS = 120 * 1000;
const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const TASK_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * 连接断开后的容忍窗口（毫秒）。
 *
 * 为什么必须有：改网络配置（固定 IP、换网关、`systemctl restart network`、
 * `nmcli con up`、`netplan apply`）**必然**把当前 SSH 连接打断；主进程
 * `ssh.ts` 自带 5 次指数退避重连（1/2/4/8/16s），正常 2~4 秒就回来了。
 * 旧实现在循环顶部一看到 `connected === false` 就 `phase:"error"` 收口 ——
 * 用户让 Agent 固定 IP，命令刚生效任务就被判死，看起来是「它什么都干不了」。
 *
 * 这里给 25 秒（覆盖主进程前 4 次重连，1+2+4+8=15s 加上建连耗时），
 * 期间每 500ms 轮询一次；重连成功就继续跑，超时才终止并给出可操作的提示。
 */
const RECONNECT_GRACE_MS = 25_000;
const RECONNECT_POLL_MS = 500;

/**
 * 在容忍窗口内等待会话恢复连接；恢复返回 true，超时/被中止返回 false。
 *
 * 依赖注入的形式（传 `isConnected` 而不是 sessionId）是为了能单测：
 * 直接读 store 的版本没法在测试里造「断开 600ms 后恢复」的时序。
 */
export async function waitForReconnect(
  isConnected: () => boolean,
  isAborted: () => boolean,
  graceMs: number = RECONNECT_GRACE_MS
): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  // 立刻查一次：断开只是「这一瞬间」的快照时，不必白等一个轮询周期
  while (Date.now() < deadline) {
    if (isAborted()) return false;
    if (isConnected()) return true;
    await new Promise((r) => setTimeout(r, RECONNECT_POLL_MS));
  }
  return isConnected();
}

/**
 * 等待用户确认（高危命令）的超时。
 *
 * 不设超时的后果是**锁死**：用户走开（开会、关屏幕）→ Promise 永不 resolve →
 * `runningSessions` 里的锁永不释放，界面一直停在「等待你确认」，再点「开始接管」
 * 会被入口直接挡掉，只能重启应用。到点按「终止」处理 —— 让一条高危命令在
 * 无人值守时自动跑，比停下更糟。
 */
let CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

/** 仅供探针/测试缩短等待，避免真的等 10 分钟。生产路径不会调用。 */
export function __setConfirmTimeoutMsForTest(ms: number): void {
  CONFIRM_TIMEOUT_MS = Math.max(0, ms);
}

/**
 * 真正「正在跑」的同步判据。
 *
 * 不能用 `phase === "running"` 代替：phase 是写进 store 的快照，上一次 run()
 * 如果在走到 finally 之前被打断（窗口刷新、进程被杀、某个 await 抛出未捕获异常），
 * phase 会永远停在 running —— 之后每次点「开始接管」都在入口 `return`，
 * 按钮彻底失效，界面一直显示「AI 正在分析并执行…」但什么都不发生。
 * 内存里的 Set 跟随进程生命周期，进程活着它就一定准确。
 */
const runningSessions = new Set<string>();

export const useAgentStore = create<AgentState>((set, get) => {
  const patchBucket = (key: string, patch: Partial<AgentBucket>) => {
    set((s) => ({
      buckets: { ...s.buckets, [key]: { ...(s.buckets[key] ?? EMPTY_BUCKET), ...patch } },
    }));
  };

  const updateStep = (key: string, stepId: string, patch: Partial<AgentStep>) => {
    set((s) => {
      const b = s.buckets[key] ?? EMPTY_BUCKET;
      return {
        buckets: {
          ...s.buckets,
          [key]: { ...b, steps: b.steps.map((st) => (st.id === stepId ? { ...st, ...patch } : st)) },
        },
      };
    });
  };

  /** 更新某一步里第 index 条命令 */
  const updateStepItem = (
    key: string,
    stepId: string,
    index: number,
    patch: Partial<AgentCommandItem>
  ) => {
    set((s) => {
      const b = s.buckets[key] ?? EMPTY_BUCKET;
      return {
        buckets: {
          ...s.buckets,
          [key]: {
            ...b,
            steps: b.steps.map((st) =>
              st.id === stepId
                ? {
                    ...st,
                    items: st.items.map((it, i) => (i === index ? { ...it, ...patch } : it)),
                  }
                : st
            ),
          },
        },
      };
    });
  };

  /** 挂起等待用户在 UI 上做决策（超时见模块顶部 CONFIRM_TIMEOUT_MS 的说明） */
  const requestConfirm = (
    key: string,
    stepId: string,
    command: string,
    review: ReturnType<typeof reviewCommand>
  ): Promise<ConfirmDecision> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (decision: ConfirmDecision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(decision);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        // 先把 UI 状态收干净，再解除阻塞：让用户清楚看到「为什么停了」。
        const mins = CONFIRM_TIMEOUT_MS / 60000;
        const human =
          mins >= 1
            ? `${Math.round(mins)} 分钟`
            : `${Math.max(1, Math.round(CONFIRM_TIMEOUT_MS / 1000))} 秒`;
        patchBucket(key, {
          pendingConfirm: null,
          phase: "stopped",
          error: `等待你确认已超过 ${human}，为避免无人值守执行高危命令，已自动终止本次任务。`,
        });
        finish("abort");
      }, CONFIRM_TIMEOUT_MS);
      // 注意不要 unref：这个定时器是「无人应答也要能收尾」的唯一保障，
      // unref 掉之后在只剩它的场景下事件循环会直接退出，Promise 永不 settle。
      // 正常路径（用户确认/跳过/终止）都会 clearTimeout，不会多留任何句柄。

      // resolver 包一层：正常确认路径也要撤掉定时器，否则它 10 分钟后还会来改一次状态。
      set((s) => ({
        confirmResolvers: { ...s.confirmResolvers, [key]: finish },
      }));
      patchBucket(key, {
        phase: "awaiting-confirm",
        error: null,
        pendingConfirm: {
          stepId,
          command,
          risk: review.riskLevel,
          riskDescription: review.riskDescription,
          confirmationItems: review.confirmationItems,
        },
      });
    });

  return {
    buckets: {},
    autoRunMedium: false,
    abortRefs: {},
    confirmResolvers: {},

    setGoal: (key, goal) => patchBucket(key, { goal }),
    setAutoRunMedium: (v) => set({ autoRunMedium: v }),
    clearError: (key) => patchBucket(key, { error: null }),

    run: async (sessionId: string) => {
      const state = get();
      const bucket = state.buckets[sessionId] ?? EMPTY_BUCKET;
      // 并发保护用同步锁，不用 phase：见 runningSessions 的说明。
      if (runningSessions.has(sessionId)) return;
      if (bucket.phase === "running" || bucket.phase === "awaiting-confirm") {
        // 锁里没有它 → 这是一次被中断后残留的 phase。不清理的话按钮永久失效。
        patchBucket(sessionId, { phase: "stopped", pendingConfirm: null, liveThought: "" });
      }

      const goal = bucket.goal.trim();
      if (!goal) {
        patchBucket(sessionId, { error: "请先输入要让 AI 完成的目标，例如「分析系统资源并给出优化建议」" });
        return;
      }

      const aiConfig = useAppConfig.getState().aiConfig;
      if (!aiConfig.apiKey) {
        patchBucket(sessionId, { error: "请先点击右上角 ⚙️ 配置 AI API Key" });
        return;
      }

      // 接管循环用的生成参数：
      // · temperature 压低 → 让「无论什么模型」（含小模型）都更确定性地走协议、少发散。
      // · maxTokens 取「地板」而不是「上限」——这是踩过坑的关键：
      //   max_tokens 是**单次输出上限**而非目标值，模型正常收尾（给出 <<<DONE>>>）
      //   时根本用不到它，所以压小它并不省 token，只会把「先输出一大段思考」的
      //   思考型模型（Qwen3 系等）截断成「正文为空、finish_reason=length」，
      //   Agent 直接报错失败。省 token 要靠压 prompt / 少跑偏，不能靠压上限。
      // · thinking 型模型显式关掉思考：Agent 要的是「立刻按协议吐命令」，
      //   思考块既烧 token 又可能把预算吃光（网关不认该字段时 ai.ts 会自动去掉重试）。
      const thinkingExtra = thinkingDisableExtra(aiConfig.model);
      const agentConfig: AIProviderConfig = {
        ...aiConfig,
        temperature: Math.min(aiConfig.temperature || 0.3, 0.2),
        maxTokens: Math.max(aiConfig.maxTokens || 2048, 4096),
        ...(thinkingExtra ? { extraBody: { ...(aiConfig.extraBody ?? {}), ...thinkingExtra } } : {}),
      };

      const session = useTerminalStore.getState().sessions.find((s) => s.id === sessionId);
      if (!session) {
        patchBucket(sessionId, { error: "对应的终端会话已不存在" });
        return;
      }
      if (!session.connected) {
        patchBucket(sessionId, { error: "当前终端未连接主机。Agent 需要在已连接的终端里真实执行命令。" });
        return;
      }

      const abort = new AbortController();
      set((s) => {
        const nextResolvers = { ...s.confirmResolvers };
        delete nextResolvers[sessionId];
        return {
          abortRefs: { ...s.abortRefs, [sessionId]: abort },
          confirmResolvers: nextResolvers,
        };
      });

      // 是否是「全新任务」：
      // 1. bucket 里没有历史对话（首次运行或已被 reset）；
      // 2. **目标变了**（与上次提交的不同）—— 不管上一轮是 done / stopped / error。
      //    早期只处理了 done：用户点「停止」或上一轮报错后换个目标，旧任务的全部
      //    观察消息还会混在上下文里（探针实测：新目标的请求里仍带着旧目标、旧命令
      //    与「继续上次任务」的提示），模型会接着干旧活或答非所问。
      //    换目标 = 新任务，这是一条更容易预期的规则；同一目标再点仍是续跑。
      const goalChanged =
        !!bucket.submittedGoal.trim() && goal.trim() !== bucket.submittedGoal.trim();
      // 目标变了不代表「换了件事」：用户接着说「你先把冲突包卸了再装」也是目标变了。
      // 命中承接语就继承完整对话（steps / summary / messages 全保留），只追加一条
      // 「用户补充了目标」的说明 —— 否则用户每补充一句，上一轮的成果就被清空一次。
      const relation = goalChanged
        ? judgeGoalRelation({ prevGoal: bucket.submittedGoal, newGoal: goal })
        : { relation: "continue" as const, reason: "目标未变" };
      const continuing = relation.relation === "continue";
      const isFresh = !bucket.messages || bucket.messages.length === 0 || (goalChanged && !continuing);

      const hostConfig = session.hostId ? useAppConfig.getState().getHost(session.hostId) : null;
      const isProduction = hostConfig?.tags?.some((t) => /生产|prod|线上|live/i.test(t));
      const privilege = session.username === "root" ? "root" : "user";

      // ---------- 运行记录：完整输出落盘 ----------
      // store 里每条命令的输出被 capOutput 砍到 4000 字符（渲染性能所迫），
      // 而「导出完整输出」必须拿到原始文本，所以在截断之前先写盘。
      // 落盘是附加价值：任何失败都吞掉，绝不允许它把任务主流程带停。
      const runStartedAt = Date.now();
      const runId = `${runStartedAt}-${Math.random().toString(36).slice(2, 8)}`;
      const runRecorder = typeof window !== "undefined" ? window.agentRun : undefined;
      // begin 是异步的，append 必须排在其后 —— 否则 manifest 还没建，
      // append 会判定「目录未初始化」把输出丢掉。用一条 promise 链串起来。
      let runReady: Promise<unknown> = Promise.resolve(null);
      if (runRecorder) {
        runReady = runRecorder
          .begin({
            runId,
            sessionId,
            goal,
            host: session.host,
            user: session.username,
            startedAt: runStartedAt,
          })
          .catch(() => null);
      }
      /** 把一条命令的未截断输出写进运行记录（失败静默） */
      const persistOutput = (
        stepIndex: number,
        itemIndex: number,
        meta: {
          command: string;
          risk: string;
          status: string;
          exitCode: number | null;
          timedOut: boolean;
        },
        content: string
      ) => {
        if (!runRecorder || !content) return;
        // 落盘前必须清洗：sanitizeOutput 里含 redactSecrets，会把私钥 / 密码 / token
        // 打码。直接把 res.output 原样写盘，等于把凭据明文留在磁盘上。
        // 行数上限给得很大（只做「不截断」），真正的体积控制在主进程（单条 2MB）。
        const clean = sanitizeOutput(content, 200_000);
        void runReady
          .then(() =>
            runRecorder.append({ runId, stepIndex, itemIndex, ...meta, content: clean })
          )
          .catch(() => {});
      };

      // 主机画像：跨任务复用（reset 才清空）。已确认的发行版/包管理器直接写进
      // 系统提示，模型不必每轮重探；也确实降低「凭印象选错包管理器」的概率。
      let facts = bucket.facts;
      const buildSystemMessage = (): ChatMessage => ({
        role: "system",
        content: buildAgentSystemPrompt({
          hostIp: session.host,
          hostname: session.hostName,
          currentUser: session.username,
          privilege,
          hostTags: hostConfig?.tags,
          isProduction,
          facts,
        }),
      });
      /** 学到新事实时刷新 system 消息（它在 messages[0]，不刷新就一直用旧画像） */
      const absorbFacts = (sources: Array<{ command: string; output: string; exitCode?: number | null }>) => {
        const learned = extractHostFacts(sources);
        if (!hasAnyFact(learned)) return;
        const next = mergeHostFacts(facts, learned);
        if (renderHostFacts(next) === renderHostFacts(facts)) return;
        facts = next;
        patchBucket(sessionId, { facts });
        if (messages[0]?.role === "system") messages[0] = buildSystemMessage();
      };

      const messagesInit: ChatMessage[] = [buildSystemMessage(), { role: "user", content: goal }];

      patchBucket(sessionId, {
        phase: "running",
        error: null,
        pendingConfirm: null,
        liveThought: "",
        submittedGoal: goal,
        stage: "thinking",
        stageSince: Date.now(),
        // 度量每次 run() 从零开始统计（本轮的耗时/token），不跨 run 累积
        metrics: { ...EMPTY_METRICS },
        // 运行记录：导出用它关联磁盘上的完整输出
        runId: runRecorder ? runId : undefined,
        startedAt: runStartedAt,
        // 续跑不清 steps/summary，保留任务连续性；仅首次运行才重置。
        ...(isFresh ? { steps: [], summary: "", plan: "" } : {}),
      });

      // 从这里开始真正进入主循环：上锁，并在 finally 里解锁。
      // 必须在上面所有「前置校验 return」之后加，否则校验失败会把锁永久占住。
      runningSessions.add(sessionId);

      // 单条命令超时：静默超时与硬上限**必须分离**（见文件顶部说明）。
      // 同值会让「还在正常吐输出」的长命令在第 5 分钟被硬切，拿到半截输出。
      const timeoutMs = COMMAND_IDLE_TIMEOUT_MS;
      const maxTimeoutMs = COMMAND_TIMEOUT_MS;

      // 整体任务超时兜底：模型若不收敛（一直给命令不出 <<<DONE>>>），
      // 单靠「停止」按钮不够，到点强制终止，避免任务无限空跑。
      // 注意：超时后 messages 会写回 bucket，用户可点「开始接管」在已有进展上续跑。
      const taskStartedAt = Date.now();
      // 上下文上限：多步任务每轮都回传完整观察，messages 会越来越长，
      // 超过阈值后只保留 system + 最近若干轮，避免 token 线性膨胀、越来越慢越来越贵。
      // 单条命令观察的字符预算。
      //
      // 3000 → 8000 的调整依据：预算现在是「每条保底 800 + 剩余按需分配」
      // （见 allocateObservationBudget），不再是按条数均摊。之前批量 4 条时
      // 每条只剩 750 字符 —— `df -h` / `ps aux` / `journalctl` 轻轻超，模型拿到的
      // 是残片，决策错了反被误判成「空转」。8000 下：单条命令拿到近满额，
      // 批量 4 条按需分配，短输出不白占预算。
      // 超长部分仍由 focusOutput 的「头部 20 行 + 错误行 + 尾部 40 行」兜住，
      // 不会把整段大输出灌进上下文。
      const OBSERVATION_MAX_CHARS = 8000;
      // 硬截断兜底阈值。必须明显大于压缩触发阈值（COMPRESS_TRIGGER），
      // 否则压缩还没轮到就先被砍 —— 旧值 14 与触发值 12 只差 2，
      // 实际上每轮都在 hardTrim，压缩形同虚设。
      const MAX_AGENT_MESSAGES = 30;
      // 单任务步数上限（核心节流闸门）：没有它，模型可以无休止打转（实测跑到 64 步仍在
      // 空转），每一步都是一次「system + 计划 + 已执行清单 + 历史摘要」的完整请求，
      // token 消耗线性爆炸且问题不被解决。到点自动收尾，进度保留，用户可续跑或换目标。
      // 步数预算按任务类型给：安装/部署这类长事务 36 步，排查类 20 步。
      // 一刀切 20 步时，「装 docker」正常要 12–18 步，一次 GPG 报错重试就撞上限被强制收尾。
      const MAX_AGENT_STEPS = stepBudgetFor(goal);
      /**
       * 「空总结」的判定下限：去掉 markdown 符号后，正文有效字符数少于这个值，
       * 就认为模型没写结论（只吐了 `<<<DONE>>>` 或一个空标题），打回重写。
       */
      const EMPTY_SUMMARY_MIN_CHARS = 12;
      // 单条命令输出写入 UI / store 的上限。终端里 `cat` 大日志、`find /`、
      // `journalctl` 全量能一次吐出几十万字符：全量进 store 既卡渲染又占内存，
      // 而终端窗口本身已有完整输出，这里只需保留「足够看懂」的头尾片段。
      const MAX_ITEM_OUTPUT_CHARS = 4000;
      const capOutput = (text: string): string => {
        // 先清洗（去 ANSI/空行/超长日志的行数收敛），再限长——UI 里也不该看到满屏控制符
        const clean = sanitizeOutput(text, 400);
        if (clean.length <= MAX_ITEM_OUTPUT_CHARS) return clean;
        const headN = Math.floor(MAX_ITEM_OUTPUT_CHARS * 0.6);
        const tailN = MAX_ITEM_OUTPUT_CHARS - headN;
        return `${clean.slice(0, headN)}\n……（输出过长，已省略 ${
          clean.length - headN - tailN
        } 字符，完整输出请见终端）\n${clean.slice(-tailN)}`;
      };
      /**
       * 实时流式展示用：只限长，不跑正则清洗。
       *
       * execCommand 推上来的 display 已经过 stripEcho → cleanTerminalText 清过 ANSI，
       * 这里若再对「累积全量文本」跑一次 sanitizeOutput（正则 + split + 逐行遍历），
       * 就是每 400ms 一次、最长 12 万字符的重复劳动 —— O(n²) 的主要来源。
       * 完整清洗留给命令结束时的 capOutput。
       */
      const capLive = (text: string): string => {
        if (text.length <= MAX_ITEM_OUTPUT_CHARS) return text;
        const headN = Math.floor(MAX_ITEM_OUTPUT_CHARS * 0.6);
        const tailN = MAX_ITEM_OUTPUT_CHARS - headN;
        return `${text.slice(0, headN)}\n……（输出过长，已省略 ${
          text.length - headN - tailN
        } 字符，完整输出请见终端）\n${text.slice(-tailN)}`;
      };
      // digestOutput 已下沉到 services/agent.ts（纯函数、可单测）：
      // 它的「跳过表头取有信息量行」策略直接决定台账能不能替模型省下一轮重跑。
      /** 展示用短命令：单行命令可能上千字符（输出退化），提示里只回显开头 */
      const brief = (cmd: string, n = 60): string => (cmd.length > n ? `${cmd.slice(0, n)}…` : cmd);
      /** 台账行格式：`✓ 命令 → 输出片段` */
      const logLine = (icon: string, cmd: string, output?: string): string => {
        const c = brief(cmd, 80);
        return output === undefined ? `${icon} ${c}` : `${icon} ${c} → ${digestOutput(output)}`;
      };
      // 批量探测单轮条数上限：一次甩十几条命令既刷屏又难定位，超过的丢弃并告知模型
      const MAX_BATCH_COMMANDS = AGENT_MAX_BATCH_COMMANDS;
      // 零信息量命令：执行了也拿不到任何新信息，纯粹占步数、刷输出、烧 token。
      // 命中即拒绝执行，请模型换真正能推进目标的命令。
      // 只拦「执行了也拿不到任何新信息」的命令——echo 打标记、清屏、查历史等；
      // pwd/whoami/date 这类虽信息量低但确有用途，交给重复命令闸门（≥2 次）兜住，不在此拦。
      // echo/printf 带重定向（写文件）不算噪音，正则里排除 `>`。
      const LOW_VALUE_CMD_RE =
        /^\s*(#.*|:|true|false|clear|reset|history|exit|logout|cat|echo(\s+[^>|]*)?|printf(\s+[^>|]*)?)\s*$/i;
      // 交互式 / 会挂住终端的命令：一旦下发，PTY 就卡在等待输入，哨兵永远不出现，
      // 整条命令被超时强杀、输出彻底错位，模型随后退化成反复发无关探测命令。
      // 这里在解析后硬性拦掉（即便小模型照旧吐出来），并提示非交互替代写法。
      // 注意：仅匹配「命令词位于句首或紧跟 shell 分隔符」的位置，避免误伤参数里
      // 恰好含这些词的命令（如 grep "some more text"）。`top -b` / `watch -n` 这类
      // 非交互写法放行。
      const INTERACTIVE_CMD_RE =
        /(?:^|[;|&])\s*(?:htop|less|more|vi|vim|nano|emacs|man|tail\s+-[fF]|watch(?!\s+-n\s*\d+)|top(?!\s+-b))\b/;
      // 每轮 run() 各自拥有 20 步预算：续跑时从已有步数起算，避免历史步数直接顶满上限
      const startStepCount = isFresh ? 0 : bucket.steps.length;

      let messages: ChatMessage[];
      if (isFresh) {
        messages = messagesInit;
        // 换目标触发的「重开」不继承旧对话（避免接着干旧活），但必须给一份上一轮简报：
        // 否则用户接着上一轮的结论说话（「你帮我建这个服务」）时，模型既不知道
        // 上一轮说过什么、也不知道自己做过什么，只能从头再来或答非所问。
        if (goalChanged) {
          const prior = buildPriorRunBrief({
            submittedGoal: bucket.submittedGoal,
            summary: bucket.summary,
            steps: bucket.steps,
            blockedCommands: bucket.blockedCommands,
          });
          if (prior) messages.push({ role: "user", content: prior });
        }
        // 接管前上下文注入：让模型了解开始工作前终端已有的内容
        // （含用户手动输入的命令及结果），否则它对当前 cwd/状态一无所知、
        // 容易重复已完成的操作或跑错地方。
        const handoff = buildHandoffContext(session.recentOutput);
        if (handoff) messages.push({ role: "user", content: handoff });
      } else {
        // 续跑：继承上次任务的完整对话历史，并补一条「继续」指令。
        messages = bucket.messages.slice();
        messages.push({ role: "user", content: buildResumeNote(goal, bucket.submittedGoal) });
      }

      // 无标记兜底续跑计数：模型连续多次返回「既非命令也非结论」的过渡性文本时，
      // 视为确实说完了，强制结束，避免无限空转。
      let noMarkerStreak = 0;
      // 空总结计数：模型只回 `<<<DONE>>>` 不写正文时打回重写，连续 3 次就用台账兜底收尾。
      let emptySummaryStreak = 0;
      // 连续截断计数：截断轮不建 step、不耗步数预算，只靠任务总超时兜底，必须单独收敛。
      let truncationStreak = 0;
      // 低价值命令连续拒绝计数：被拒轮不建 step、不耗步数预算，需要独立闸门防空转烧钱。
      let lowValueStreak = 0;
      /**
       * 已被「主机画像」拦过一次的环境探测类型。
       *
       * 拦的是一条**重复**探测（`cat /etc/os-release`、`uname -a`、`command -v yum`…），
       * 证据已经在系统提示里。给第二次机会：同一类型再发一次就放行去执行 ——
       * 不设这道放行，遇到模型固执重发就会一直拦到「无进展」闸门收尾，
       * 用户看到的是「任务莫名结束」而不是「命令被合理跳过」。
       */
      const envProbeAsked = new Set<string>();
      // 全轮重复命令连续拒绝计数。重复命令被剔除后**台账计数不会增长**（没真的执行），
      // 所以单靠 dupTracker 无法收敛：模型可以一直重发同一条命令、一直被拒 ——
      // 每轮都是一次完整 API 往返。同样需要独立闸门兜住。
      let dupStreak = 0;
      /**
       * 「逐个硬编码枚举」被打回的次数。
       *
       * 打回本身也是一次完整的 API 往返，所以最多打回 2 次：模型坚持手抄路径
       * 就放行让它跑（顶多慢），不能把它困在「改写法」里直到任务超时。
       */
      let enumNudgeStreak = 0;
      /**
       * 本次运行里被用户「跳过」的变更命令。DONE 时用来判断：
       * 手动清单是「用户自己拒绝过」的合理兜底，还是模型偷懒把活推回去。
       */
      const skippedChanges: string[] = [];
      /** 本次运行被硬闸门拦下的命令（受保护路径等），这些确实只能人工做 */
      const blockedCommands: string[] = [...(bucket.blockedCommands ?? [])];
      /** 「把活推回给用户」被纠正的次数，见 DONE 分支 */
      let deferNudgeStreak = 0;
      /**
       * 「无进展」连击：这一轮没有真的落下一个步骤（模型只给计划 / 只给被拒命令 /
       * 只给无法解析的文本）。见主循环里的总闸门说明。
       */
      let stalledRounds = 0;
      let lastSeenSteps = -1;
      const MAX_STALLED_ROUNDS = 5;

      // 任务计划蓝图：fresh 运行时由模型 <<<PLAN>>> 给出；续跑时继承 bucket.plan。
      // 它必须在整个任务生命周期内一直可见 —— 压缩/硬截断会把早期的 assistant
      // 消息（含计划原文）压掉或扔掉，模型跑到十几轮后忘了整体蓝图就会答非所问、
      // 重复或偏离目标。所以每次喂给模型前都确保有一条「pinned 计划消息」在位。
      // 注意：bucket 是本次 run() 开始时拿的快照，而 isFresh 分支刚刚在 store 里
      // 清空了 plan/steps —— 这里若直接读 bucket.plan，新任务会带着旧任务的蓝图
      // 起步（表现为「换个问题还按旧计划跑」）。全新任务一律从空开始。
      let planText = isFresh ? "" : bucket.plan || "";
      const PLAN_PIN_PREFIX = "## 任务计划（蓝图，持续有效）";
      const ensurePlanPinned = () => {
        if (!planText.trim()) return;
        if (messages.some((m) => m.content.startsWith(PLAN_PIN_PREFIX))) return;
        messages.splice(1, 0, {
          role: "user",
          content: `${PLAN_PIN_PREFIX}\n${planText}\n（对照计划推进：已完成的不重复，未完成的继续，全部完成才 <<<DONE>>>。）`,
        });
      };

      // 已执行命令清单：每条真实执行过的命令都要跨轮「可见」。否则命令记录只活在
      // 当轮观察消息里，超过压缩/截断阈值后只剩摘要一句话——模型不翻旧账，
      // 就会重复探测、重复安装。清单与计划一样做成 pinned 消息，每轮同步在位。
      const executedLog: string[] = [];
      // 续跑种子：从 bucket.steps 重建（含上一轮已执行的全部命令与状态）。
      // 全新任务不重建——否则新任务一开局就被钉上旧任务的命令清单，
      // 既误导模型（以为这些命令已在本任务执行过），又违背「干净开始」的意图。
      const itemIcon = (it: { status: AgentStepStatus; timedOut?: boolean }): string =>
        it.timedOut ? "⏱" : it.status === "done" ? "✓" : it.status === "skipped" ? "⊘" : "✗";
      if (!isFresh) {
        for (const st of bucket.steps) {
          for (const it of st.items) executedLog.push(logLine(itemIcon(it), it.command, it.output));
        }
      }
      // 命令执行统计（去重执行用）：实现下沉到 services/agent.ts 的 createDupTracker
      // （纯函数 + 单测锁定了「把查询包进 `A && B` 里也算重复」这条关键语义）。
      // 「重复执行同一条已成功的命令」是空转烧 token 的典型形态（模型忘了自己跑过什么，
      // 或陷入重试死循环）。已执行清单是软提示，这里是硬闸门。
      const dupTracker = createDupTracker();
      const EXEC_LOG_PREFIX = "## 已执行过的命令清单（勿重复）";
      // 台账展示窗口：条数 + 字符双约束。
      //
      // 为什么不能只给 12 条：去重硬闸门用的是**全量历史**（dupTracker），而模型
      // 只看得见这个窗口里的内容。窗口之外的旧命令一旦被重发，会被判「重复」并
      // 计入连拒 —— 连拒 3 轮直接结束任务，而模型完全无从得知自己错在哪，
      // 用户看到的就是「任务莫名其妙提前结束」。
      const LOG_LINE_BUDGET = 4000;
      let logWindowSize = 24;
      /**
       * 台账里**带输出片段**的那一段（窗口内），用于判断「模型到底看不看得见某条命令」。
       *
       * 必须用窗口内这一段，而不是整条台账消息：窗口外的早期命令现在只留命令名、
       * 没有输出片段 —— 模型知道「做过」，却看不到结果。这种情况仍要给一次公平机会
       * （放大窗口 + 回填输出 + 不计连拒），否则它会为了看结果反复重发、最终被误杀。
       */
      let ledgerWindowText = "";

      /** 按「条数上限 + 字符预算」从尾部取台账，避免一次把上下文撑爆 */
      const buildLedgerLines = (): string[] =>
        pickLedgerLines(executedLog, logWindowSize, LOG_LINE_BUDGET);

      const syncExecLog = (stepsUsed = 0) => {
        if (executedLog.length === 0) {
          ledgerWindowText = "";
          return;
        }
        const capped = buildLedgerLines();
        // 窗口外的早期命令：只保留命令名，去掉输出片段。
        //
        // 为什么必须留：去重硬闸门用**全量**历史，而模型只看得见窗口内的条目。
        // 长任务（>24 条命令）里，早期执行过的东西会整个从它视野里消失 ——
        // 它不知道「这步已经做过了」，于是重发 → 被拒 → 连拒 3 轮任务提前结束，
        // 而它至死不知道错在哪。只留命令名（不留片段）就能把「做过什么」补回来，
        // 代价是每行几十字符，不加一次 LLM 往返。
        const olderCount = executedLog.length - capped.length;
        const olderNote =
          olderCount > 0
            ? (() => {
                // 越靠近窗口的越相关：从后往前取，超过约 800 字符就停
                const names: string[] = [];
                let used = 0;
                for (let i = olderCount - 1; i >= 0; i--) {
                  const name = executedLog[i]
                    .replace(/^[✓✗⊘⏱?]\s*/, "")
                    .split(" → ")[0]
                    .trim();
                  if (!name || used + name.length > 800) break;
                  names.push(name);
                  used += name.length + 2;
                }
                if (names.length === 0) return "";
                return (
                  `\n\n更早执行过的 ${olderCount} 条（片段已省略，仅列命令名 —— 这些**已经做过了**，不要重复）：\n` +
                  names.join("；")
                );
              })()
            : "";
        // 步数预算必须让模型看见：它原本不知道还有多少余量，常见的坏形态是
        // 前 15 步都在反复确认同一个事实，真正要紧的动作没做就撞上上限被强制收尾。
        const remain = Math.max(0, MAX_AGENT_STEPS - stepsUsed);
        const budgetNote =
          stepsUsed > 0
            ? `\n（本任务已用 ${stepsUsed}/${MAX_AGENT_STEPS} 步，剩余 ${remain} 步。` +
              `请把关键的写操作/验证动作排在前面；信息已够就直接 <<<DONE>>>，不要在同一个目标上反复确认。）`
            : "";
        const content =
          `${EXEC_LOG_PREFIX}\n已真实执行过（✓ 成功 / ✗ 失败 / ⊘ 跳过 / ⏱ 超时），→ 后为该命令的输出片段：\n` +
          `${capped.join("\n")}${olderNote}\n` +
          `（信息够就直接引用片段，不要为了「再看一眼」而重跑。）${budgetNote}`;
        const idx = messages.findIndex((m) => m.content.startsWith(EXEC_LOG_PREFIX));
        if (idx !== -1) {
          messages[idx] = { role: "user", content };
        } else {
          // 插在计划 pin 之后（若有），否则 system 之后
          const planIdx = messages.findIndex((m) => m.content.startsWith(PLAN_PIN_PREFIX));
          messages.splice(planIdx !== -1 ? planIdx + 1 : 1, 0, { role: "user", content });
        }
        // 记下这一轮模型真正看到的窗口内条目，供连拒闸门判断「它是不是根本没看见」
        ledgerWindowText = capped.join("\n");
      };

      /**
       * 同源探测统计：识别「对着同一个 host:端口反复换 URL 路径」的空转。
       *
       * 真实故障：模型为了确认 Prometheus 有没有起来，连发了 `/-/health`、`/metrics`、
       * `/-/status`、`/api/v1/status` 等多个**猜出来的**路径，其中大部分是 404。
       * 它换了字符串，但没有换方法 —— 因为它每次拿到的都是「404 page not found」
       * 这种没有区分度的输出，从里面学不到任何东西。
       *
       * 这里只做「告知」，不拦截：拦截会连带挡掉合法的复查，而告知不会 ——
       * 与「信息只增不减」的原则一致。
       */
      const probeTarget = probeTargetOf;
      /** target → { n 总探测次数, streak 连续无有效信息次数 } */
      const probeStats = new Map<string, { n: number; streak: number }>();
      const recordProbe = (cmd: string, res: ExecResult) => {
        const target = probeTarget(cmd);
        if (!target) return;
        const noInfo = isNoInfoProbeOutput(res.output);
        const prev = probeStats.get(target) ?? { n: 0, streak: 0 };
        probeStats.set(target, { n: prev.n + 1, streak: noInfo ? prev.streak + 1 : 0 });
      };
      /** 本轮命令若命中「同源反复探测」，返回一段提醒；否则空串 */
      const probeNoteFor = (cmds: string[]): string => {
        for (const c of cmds) {
          const target = probeTarget(c);
          if (!target) continue;
          const st = probeStats.get(target);
          // streak >= 2：连续两次没拿到有效信息，说明「换路径」这条路已经走不通了
          if (!st || st.streak < 2) continue;
          return (
            `\n\n[系统] 你已经第 ${st.n + 1} 次探测 \`${target}\`，此前连续 ${st.streak} 次都没拿到有效信息（404 / 连接失败 / 空输出）。\n` +
            `**不要再换 URL 路径了** —— 换路径不算换方法。请先确认这个端口有没有服务在监听：\`ss -lntp | grep -w 端口\`（无 ss 用 \`netstat -lntp | grep 端口\`）；\n` +
            `端口没有 Listen 就转去查进程（\`ps aux | grep 服务名\`）、启动日志（\`journalctl -u 服务名 -n 50 --no-pager\`）与配置文件。`
          );
        }
        return "";
      };

      /**
       * 同类错误连击：识别「换了写法、没换方法」的原地打转。
       *
       * 与 probeStats 的区别：probeStats 只认 curl/wget 对同一 host:port 的探测；
       * 这里认的是**任意命令的同类失败** —— 例如对着挂载点反复 `rm -rf`，每轮都拿到
       * `Operation not permitted`，但命令文本每轮都不同（路径越列越细），
       * 文本去重抓不到，只有错误签名能抓到。
       *
       * 同样只告知、不拦截。
       */
      const failTreadmill = createFailTreadmill();

      /**
       * 确定性诊断提示（挂载点 busy / 服务起不来 / 半装包 / 依赖 socket 未就绪）。
       *
       * 只注入一次：同一段提示连续刷进上下文，既占 token 又会让模型以为「又在报新错」。
       * 换了目标（另一条报错）内容不同，会重新提示。
       */
      let lastDiagNote = "";
      const diagNoteFor = (text: string, command = ""): string => {
        const note = busyMountHint(text) + serviceDiagHint(text, command);
        if (!note || note === lastDiagNote) return "";
        lastDiagNote = note;
        return note;
      };

      /**
       * 硬截断兜底：压缩失败或压缩不划算时保底，保证上下文不会无限膨胀。
       * 与旧版不同的是会显式保住「任务目标」，避免模型跑到后面忘了最初要干什么。
       */
      const hardTrim = () => {
        // 判据从「只看条数」改为「条数或 token 任一超标」：
        // 实测 41 条 40205 token 的上下文，按条数截断后仍有 29157 token ——
        // 阈值写着 28k 却照样超，小窗口模型（8k/16k）直接 400。
        // 而且 20 条 × 4000 token 这种「条数不多但每条都很大」的形态，旧判据完全不触发。
        const overCount = messages.length > MAX_AGENT_MESSAGES;
        const overTokens = estimateMessagesTokens(messages) > HARD_TRIM_MAX_TOKENS;
        if (!overCount && !overTokens) return;
        const next = trimMessagesPure(
          messages,
          MAX_AGENT_MESSAGES - 1,
          goal,
          HARD_TRIM_MAX_TOKENS
        );
        messages.length = 0;
        messages.push(...next);
      };

      // 上下文压缩：把「中间段」旧消息压成一条结构化摘要，保留 system + 摘要 + 最近若干轮。
      // 触发从「只看条数」升级为「条数 或 估算 token 任一超标」——
      // 一条几万字符的工具输出和一句"好的"在旧逻辑里权重相同，是最容易漏防的情况。
      //
      // 阈值调整（12/6 → 22/8）的依据：主循环每轮固定产生 2 条消息（assistant 决策 +
      // 观察），12 条 = 第 6 轮就触发。而压缩本身是**一次完整的大输入 LLM 往返**
      // （要吞掉整段历史 transcript），还卡在主链路上 await —— 等于每 6 轮多付一次
      // 「读完全部历史再输出摘要」的钱。更糟的是滚动摘要会逐轮衰减：压得越勤，
      // 早期细节丢得越快，模型表现为「忘了刚才做过什么 → 重复探测同一个目标」。
      // 22 条 ≈ 第 11 轮才压一次，20 步的任务通常只压 1~2 次。
      const COMPRESS_TRIGGER = 22;
      // 压缩阈值不能写死：28k 对 128k 窗口绰绰有余，对 16k（gpt-3.5）甚至 8k（本地
      // llama.cpp / ollama）是**直接 400**，而报错在请求层，界面只表现为「AI 一直没反应」。
      // 按窗口的 45% 估算，留出 system + 最近轮 + 输出的空间；下限 6000 是为了防止
      // 8k 窗口把阈值压到比 system prompt 还小 —— 那样每轮都触发压缩，反而更慢更贵。
      const contextWindow = estimateContextWindow({
        model: agentConfig.model,
        baseUrl: agentConfig.baseUrl,
      });
      const MAX_CONTEXT_TOKENS = Math.max(
        6000,
        Math.min(28000, Math.floor(contextWindow * 0.45))
      );
      // 硬截断上限：必须明显大于压缩触发阈值（旧值 14 与触发 12 只差 2，压缩形同虚设）。
      // 取窗口 60%，同时受 36k 封顶。
      const HARD_TRIM_MAX_TOKENS = Math.max(
        MAX_CONTEXT_TOKENS + 1000,
        Math.min(36000, Math.floor(contextWindow * 0.6))
      );
      const KEEP_RECENT = 8;

      // 性能度量：每个 run() 一份，主循环与压缩调用都往里累加，实时落到 bucket 供 UI 展示。
      const metrics: AgentMetrics = { ...EMPTY_METRICS };
      const patchMetrics = () => patchBucket(sessionId, { metrics: { ...metrics } });
      const addUsage = (u?: { promptTokens: number; completionTokens: number }) => {
        if (!u) return;
        metrics.promptTokens += u.promptTokens;
        metrics.completionTokens += u.completionTokens;
      };

      /**
       * 切换忙碌阶段。UI 的计时器按 stageSince 重置，所以「45s」只会出现在真正等模型的时候。
       * `reset` 用于「同一阶段进入新的一轮」：每一轮模型调用都要重新计时，
       * 否则连续几轮 thinking 会累加成一个看起来像卡死的大数字。
       */
      const setStage = (stage: AgentBusyStage, reset = false) => {
        const cur = get().buckets[sessionId] ?? EMPTY_BUCKET;
        if (!reset && cur.stage === stage && cur.stageSince) return;
        patchBucket(sessionId, { stage, stageSince: Date.now() });
      };

      const maybeCompress = async () => {
        if (
          !shouldCompress(messages, {
            maxMessages: COMPRESS_TRIGGER,
            maxTokens: MAX_CONTEXT_TOKENS,
          })
        ) {
          return;
        }
        const system = messages[0];
        const recent = messages.slice(-KEEP_RECENT);
        const middle = messages.slice(1, messages.length - KEEP_RECENT);

        // 上一轮摘要单独拎出来做「滚动合并」，而不是混在待压消息里再压一遍 ——
        // 后者每压一次就丢一层，多轮任务里信息会逐轮衰减到不可用。
        const prevSummaryMsg = middle.find(isSummaryMessage);
        const previousSummary = prevSummaryMsg ? extractSummary(prevSummaryMsg) : "";
        const toSummarize = prevSummaryMsg
          ? middle.filter((m) => m !== prevSummaryMsg)
          : middle;

        if (toSummarize.length < 4) {
          hardTrim();
          return;
        }

        const compressStartedAt = Date.now();
        // 压缩是主链路上的**一次完整大输入请求**，不属于「模型在思考下一步」。
        // 单独标记阶段：否则它消耗的十几秒会被算成模型慢，让用户误判。
        setStage("compress");
        try {
          const summary = await chatCompletionRaw({
            // 必须用 agentConfig 而不是 aiConfig：压缩是**整条链路里单次输入最大**的
            // 一次调用（要吞掉上万 token 的历史 transcript），而 aiConfig 没带
            // thinkingDisableExtra —— 思考型模型（实测 Qwen/Qwen3.5-9B）会先在这么长的
            // 输入上跑一整段思考链，再给摘要。表现就是「AI 卡住很久、界面上什么都没发生」：
            // 它不建 step、不显进度，只有 this 一次阻塞往返。关掉思考后这一步直接砍掉大半。
            config: agentConfig,
            messages: buildCompressionMessages({
              goal,
              previousSummary,
              transcript: renderTranscript(toSummarize),
            }),
            signal: abort.signal,
            onMeta: (meta) => addUsage(meta.usage),
            // 压缩是**辅助步骤**：它只用来省 token，本身不产出任何用户可见结果。
            // 用默认 120s 超时 + 2 次重试挂在主链路上，最坏能让界面白等 6 分钟，
            // 期间不建 step、没有任何进度 —— 用户看到的就是「AI 一直在分析，什么都不出」。
            // 收短到 30s：拿不到摘要就走下面的 hardTrim 兜底，不阻塞正常工作。
            timeouts: { totalMs: 30_000, idleMs: 15_000 },
          });
          const next = assembleCompressedMessages({ system, goal, summary, recent });

          // 收益校验：若压缩后反而更大（模型返回了啰嗦的摘要），这次压缩白花钱，回退硬截断
          if (estimateMessagesTokens(next) >= estimateMessagesTokens(messages)) {
            hardTrim();
            return;
          }

          // 压缩成功但仍超硬上限：摘要 + 最近 8 条本身就很大（8 条各 8000 字符的观察
          // ≈ 1.6 万 token）。小窗口模型在这里照样 400，所以再按 token 截一刀。
          // 截断保留最近若干轮，摘要与目标由 trimMessages 自动保住。
          const finalMessages =
            estimateMessagesTokens(next) > HARD_TRIM_MAX_TOKENS
              ? trimMessagesPure(next, KEEP_RECENT, goal, HARD_TRIM_MAX_TOKENS)
              : next;

          messages.length = 0;
          messages.push(...finalMessages);
        } catch {
          // 压缩失败（网络/超时）：硬截断兜底，不影响任务继续
          hardTrim();
        } finally {
          // 无论成败，这次额外往返的时间和 token 都已经花掉了 —— 必须计入。
          // 压缩开销是最容易被忽略的一块：它不占「步骤」，UI 上看不出任何痕迹，
          // 但每次都是一次完整的 LLM 往返。
          metrics.compressCalls += 1;
          metrics.compressMs += Date.now() - compressStartedAt;
          patchMetrics();
          // 压完回到「等模型」，让 UI 的计时从头起算这一轮真正思考的时间
          setStage("thinking", true);
        }
      };

      try {
        for (;;) {
          if (abort.signal.aborted) break;
          // 连接中途断开：execCommand 会抛错、execCommandBatch 会把错误塞进 results，
          // 两条路径都会让模型看到「终端已断开」然后继续重试 —— 探针实测白烧满
          // 20 步 / 20 次 LLM 往返才停（每步都是一次完整往返）。这里提前收口。
          //
          // 但要先给重连留窗口：改网络 / 重启网络服务会让连接**必然**抖一下，
          // 主进程 2~4 秒就能自动连回来。旧实现在这里直接判死，于是「固定 IP」
          // 这类任务 100% 失败 —— 命令其实已经生效，只是引擎先放弃了。
          const liveSession = useTerminalStore.getState().sessions.find((s) => s.id === sessionId);
          if (!liveSession?.connected) {
            patchBucket(sessionId, {
              phase: "running",
              liveThought: "连接断开，等待自动重连（最长 25s）…",
            });
            // 重连等待最长 25s，绝不能算进「模型响应时间」
            setStage("reconnect");
            const back = await waitForReconnect(
              () =>
                Boolean(
                  useTerminalStore.getState().sessions.find((s) => s.id === sessionId)?.connected
                ),
              () => abort.signal.aborted
            );
            if (!back) {
              patchBucket(sessionId, {
                phase: "error",
                error:
                  "终端连接已断开且 25 秒内未恢复，任务已终止（避免继续空跑消耗）。\n\n" +
                  "如果刚改过网络配置（固定 IP / 网关 / DNS / 重启网络服务），这是**预期内**的断开：" +
                  "请确认新地址是否与当前连接的地址不同 —— 若不同，需要用**新 IP 新建连接**，" +
                  "再点「开始接管」继续。已完成的步骤、计划与命令记录都会保留。",
              });
              return;
            }
            setStage("thinking", true);
          }
          if (Date.now() - taskStartedAt > TASK_TIMEOUT_MS) {
            patchBucket(sessionId, {
              phase: "error",
              error:
                `任务执行超时（${Math.round(TASK_TIMEOUT_MS / 60000)} 分钟），已自动终止。` +
                `进度已保留，再次点「开始接管」可从断点继续（已完成的步骤、计划与命令记录都会带上）。`,
            });
            return;
          }

          // 步数闸门：单任务跑满 20 步强制收尾。64 步还在空转的情况既烧 token 又不解题，
          // 到点停下来让人判断，比让模型继续转更划算（进度保留，可续跑或换更具体的目标）。
          const stepsTotal = (get().buckets[sessionId] ?? EMPTY_BUCKET).steps.length;
          const stepsUsed = stepsTotal - startStepCount;

          // 「无进展」总闸门（兜底所有分项闸门）。
          //
          // 为什么必须有：分项闸门（截断 / 空转 / 重复 / 无标记 / 空总结）各自只认自己
          // 那一种形态，而且**会互相重置计数** —— 计划分支把 noMarkerStreak 清零，
          // 于是「计划 → 裸文本 → 计划 → 裸文本」的模型可以永远转下去；
          // 只给计划不给命令的模型更是一个计数都碰不到。实测（探针）：
          // 这两种形态各跑到 201 次 LLM 调用仍在运行，只能等 20 分钟总超时，
          // 用户看到的就是「一直在分析，永远不出结果」。
          // 判据只看「这一轮有没有真的落下一个步骤」，与形态无关。
          if (lastSeenSteps === -1) {
            lastSeenSteps = stepsTotal;
          } else if (stepsTotal === lastSeenSteps) {
            stalledRounds += 1;
          } else {
            stalledRounds = 0;
            lastSeenSteps = stepsTotal;
          }
          if (stalledRounds >= MAX_STALLED_ROUNDS) {
            patchBucket(sessionId, {
              phase: "done",
              summary:
                `[任务未完成] 连续 ${stalledRounds} 轮没有任何命令被执行` +
                `（模型只是在重复给计划、给被系统拒绝的命令，或回复无法解析的文本），已自动停止以止损。\n\n` +
                (executedLog.length > 0
                  ? `已经真实执行过的命令：\n${buildLedgerLines().join("\n")}\n\n`
                  : `本次没有执行任何命令。\n\n`) +
                `常见原因：当前模型不擅长按协议输出（换成指令遵循更强的模型），或目标过于笼统。\n` +
                `需要继续时，把目标拆成一条具体动作后再点「开始接管」。`,
              goal: "",
            });
            return;
          }

          if (stepsUsed >= MAX_AGENT_STEPS) {
            patchBucket(sessionId, {
              phase: "done",
              summary:
                `⚠️ 已达单任务步数上限（${MAX_AGENT_STEPS} 步），为防止无意义消耗已自动停止。\n\n` +
                `已完成 ${stepsUsed} 步，进度已保留。**建议**：把目标拆得更具体、或直接指出卡在哪一步，再次点「开始接管」继续推进。`,
              goal: "",
            });
            return;
          }

          // 上下文逼近上限时先压缩旧消息，保留关键信息再进入下一轮
          await maybeCompress();
          // 压缩/硬截断可能丢掉早期消息里的计划原文：每次喂给模型前重新钉住计划蓝图
          ensurePlanPinned();
          // 已执行命令清单同样每轮钉住——模型每轮都看得见自己跑过什么，杜绝重复执行；
          // 同时带上步数预算余量，让它知道该收敛了。
          syncExecLog(stepsUsed);

          // 流式调用：逐 token 累积到 replyText，并节流刷新 liveThought 供 UI 实时展示
          let replyText = "";
          let lastFlush = 0;
          // 输出被 max_tokens 截断的感知：此前模型「话说到一半被切断」没有任何提示，
          // 引擎拿到残缺文本 → 解析不出命令 → 走无标记兜底 → 越跑越偏。
          // 现在明确告诉模型「上一条被截断了，请精简重发」。
          let truncated = false;
          const updateLive = () => {
            const now = Date.now();
            if (now - lastFlush >= 60) {
              lastFlush = now;
              patchBucket(sessionId, { liveThought: replyText });
            }
          };
          /**
           * 调一次模型。耗时与 token 用量统一在这里记账 —— 放在 finally 里，
           * 保证失败/超时的那一轮同样被计入（它同样是真实花掉的时间与费用）。
           */
          const callModel = async (): Promise<string> => {
            const callStartedAt = Date.now();
            // 每一轮都重新计时：UI 上的秒数必须对应「这一次请求等了多久」
            setStage("thinking", true);
            try {
              return await chatCompletionRaw({
                config: agentConfig,
                messages,
                signal: abort.signal,
                onToken: (delta) => {
                  replyText += delta;
                  updateLive();
                },
                onMeta: (meta) => {
                  if (meta.truncated) truncated = true;
                  addUsage(meta.usage);
                },
              });
            } finally {
              metrics.llmCalls += 1;
              metrics.llmMs += Date.now() - callStartedAt;
              patchMetrics();
            }
          };
          try {
            replyText = await callModel();
          } catch (e) {
            // 空响应重试：复杂上下文下弱模型偶发空回复（不是配错模型）。
            const msg = (e as Error)?.message ?? String(e);
            if (msg.startsWith("模型未返回任何内容")) {
              replyText = "";
              truncated = false;
              try {
                replyText = await callModel();
              } catch {
                throw e;
              }
              if (!replyText.trim()) throw e;
            } else if (
              // 截断 / 预算不足：ai.ts 已在本轮内自动放大 max_tokens 重试过；
              // 若仍截断才抛到这里。清空本轮回复，落到下面的守卫分支让模型精简重发，
              // 而不当作「模型不守协议」去累加 noMarkerStreak（否则会误触发强制结束）。
              truncated ||
              msg.includes("输出额度被") ||
              msg.includes("输出预算被")
            ) {
              replyText = "";
            } else {
              throw e;
            }
          } finally {
            // 确保最终完整文本落盘，避免节流导致末尾几字丢失
            patchBucket(sessionId, { liveThought: replyText });
          }
          messages.push({ role: "assistant", content: replyText });
          // 截断 / 不完整回复守卫：绝不解析执行。两类来源：
          // ① truncated（finish_reason=length）：ai.ts 已在本轮内自动放大 max_tokens 重试过，
          //    若仍截断才落到这里；
          // ② 流式网关不报 finish_reason 时的启发式兜底：回复以半截标记结尾（如 `<<<` / `<<<RUN`）、
          //    或 `<<<RUN>>>` 没有配对的 `<<<END>>>` —— 这两种都是半条命令，直接执行会出事故。
          // 这类回复不算「模型不守协议」，因此 noMarkerStreak 清零，避免误触发「连续 3 轮强制结束」。
          const endsWithPartialMarker = /<<<(?:RUN|END|DONE|PLAN)?\s*$/.test(replyText.trim());
          const hasRunButNoEnd = /<<<RUN>>>/.test(replyText) && !/<<<END>>>/.test(replyText);
          if (truncated || endsWithPartialMarker || hasRunButNoEnd) {
            noMarkerStreak = 0;
            // 连续截断闸门：这类回复既不建 step 也不耗步数预算，只靠任务总超时兜底，
            // 最坏能一直转到 20 分钟 —— 用户看到的就是「AI 一直在分析，永远不出结果」。
            // 三次都救不回来基本是模型/参数问题（思考链吃光预算、网关不认关思考字段），
            // 再重试也不会变好，直接停下来并说清该改什么。
            truncationStreak += 1;
            if (truncationStreak >= 3) {
              patchBucket(sessionId, {
                phase: "done",
                summary:
                  `⚠️ 模型连续 ${truncationStreak} 轮输出都被长度上限截断（或命令块反复写不完整），已停止本次任务。\n\n` +
                  `这不是目标写得不对，而是**单次输出预算不够**。建议按顺序试：\n` +
                  `1. 在设置里把 maxTokens 调大（例如 8192）；\n` +
                  `2. 换用非思考型模型（Qwen3.5-Instruct / DeepSeek-V3 等），思考链会先吃掉大半预算；\n` +
                  `3. 若用的是自建网关，确认它支持 \`enable_thinking: false\` 之类的关思考参数。\n\n` +
                  `进度已保留，调整后再次点「开始接管」可从断点继续。`,
                goal: "",
              });
              return;
            }
            messages.push({
              role: "user",
              content:
                "[系统] 你的上一条回复因达到单次输出长度上限被**截断**或命令块**未写完整**，内容不可用（可能是半条命令）。\n" +
                "请立即精简重发：思考说明压缩到 1-2 句，只给**最必要的一条**命令，并用 <<<END>>> 收尾，不要重复已说过的内容。",
            });
            hardTrim();
            continue;
          }
          // 本轮不是截断 → 截断连击清零
          truncationStreak = 0;
          hardTrim();
          // 本轮模型回复已消费（转为步骤/总结），清掉流式预览，避免与步骤重叠
          patchBucket(sessionId, { liveThought: "" });

          const parsed = parseAgentReply(replyText);
          // RUN 与 DONE 写在同一轮时，结论是在命令**执行之前**写的，不能直接采信。
          // 这里准备一段回灌提示，随 observation 一起发给模型，让它对照真实输出收尾。
          let deferredDoneNote = "";
          if (parsed.deferredAnswer) {
            const draft = parsed.deferredAnswer.slice(0, 600);
            deferredDoneNote =
              `\n\n[系统] 你本轮**同时**给了结论，但其中的命令是刚刚才真正执行的（结果见上）。\n` +
              `你写的结论产生于执行之前，可能与真实输出不符，**不能直接采信**：\n` +
              `> ${draft.replace(/\n/g, "\n> ")}\n` +
              `请对照上面的真实输出核对：\n` +
              `· 与预期一致 → 用 <<<DONE>>> 重新输出结论（可沿用原文，但必须已核对）；\n` +
              `· 有报错或结果不同 → 用 <<<RUN>>> 继续处理，不要将错就错。`;
          }
          if (parsed.plan) {
            // 计划声明：存为蓝图展示。计划本身已作为 assistant 消息留在 messages 中，
            // 模型后续轮次能看到自己的计划，下一轮开始用 <<<RUN>>> 逐步执行。
            // 同步更新 planText：压缩/截断把原始计划消息吃掉后，靠它重新钉住。
            planText = parsed.plan;
            patchBucket(sessionId, { plan: parsed.plan });
            noMarkerStreak = 0;
            // 计划与本轮首条命令写在一起时（小模型常见），命令已在 parsed.commands 里，
            // 直接往下走执行，不要 continue —— 否则这一轮只存了个计划，白烧一次往返，
            // 模型还以为命令已经跑过了。
            if (parsed.commands.length === 0) continue;
          }
          if (parsed.done) {
            // 真·结束：模型显式给出 <<<DONE>>> 或明确结论 → 任务完成。
            if (!parsed.noMarkerFallback) {
              const answer = (parsed.finalAnswer ?? "").trim();
              // 「空总结」守卫：只吐一个 <<<DONE>>>、正文一个字都没有，是实测高频形态
              // （输出被截断、或模型单纯偷懒）。直接收下会让「任务总结」卡片里只剩
              // 一行协议串，用户看不到任何结论 —— 等于这一轮白干。
              // 判据用「去掉 markdown 符号后的有效字符数」，避免 `## 结论` 这种空壳标题过关。
              const plainLen = answer.replace(/[#>*`_\-\s|]/g, "").length;
              if (plainLen < EMPTY_SUMMARY_MIN_CHARS) {
                emptySummaryStreak += 1;
                if (emptySummaryStreak <= 2) {
                  messages.push({
                    role: "user",
                    content:
                      "[系统] 你输出了 <<<DONE>>> 但**没有写任何总结正文**，用户看不到任何结论，本轮不予采纳。\n" +
                      "请立刻用 <<<DONE>>> 重新输出完整的中文 Markdown 总结，必须包含：\n" +
                      "## 结论摘要（2~3 句直接回答目标问题）\n## 关键发现（附你真实看到的数值/输出片段）\n## 需要手动执行的操作（没有就写「无」）\n" +
                      "**只输出标记、不写正文会被再次打回**；若其实还没做完，就用 <<<RUN>>> 继续执行。",
                  });
                  hardTrim();
                  continue;
                }
                // 连续三轮空总结：模型已经无法产出结论，别再耗下去。
                // 用真实执行台账兜底，绝不给一个魔改/编造的总结。
                patchBucket(sessionId, {
                  phase: "done",
                  summary:
                    "⚠️ 模型连续多次只返回结束标记、没有给出任何结论正文，已停止本次任务。\n\n" +
                    "以下为本次**真实执行过的命令与输出片段**，可直接参考：\n\n" +
                    (executedLog.length > 0
                      ? buildLedgerLines().join("\n")
                      : "（本次没有执行任何命令）") +
                    "\n\n需要结论时，请把目标写得更具体（例如「列出本机所有 IPv4 地址」）后再次点「开始接管」。",
                  goal: "",
                });
                return;
              }
              emptySummaryStreak = 0;
              // 「把活推回给用户」守卫：
              // 本轮既没有硬拦命令、用户也没跳过任何变更，模型却把 install/remove/systemctl
              // 这类**它自己完全能下发**的命令写进「需要手动执行的操作」—— 这就是偷懒。
              // 只针对「没被拦、也没被跳过」的那些：用户明确拒绝过的命令留在清单里是合理的。
              const deferred = findDeferrableCommands(answer).filter((line) => {
                const excused = [...skippedChanges, ...blockedCommands].some(
                  (x) => line.includes(x) || x.includes(line)
                );
                return !excused;
              });
              if (deferred.length > 0 && deferNudgeStreak < 2) {
                deferNudgeStreak += 1;
                messages.push({
                  role: "user",
                  content:
                    `[系统] 你在「## 需要手动执行的操作」里列出了这些命令：\n` +
                    deferred.map((c) => `- ${c}`).join("\n") +
                    `\n\n本次任务里**没有任何命令被硬闸门拦下，用户也没有跳过任何变更命令** —— ` +
                    `也就是说这些命令你完全有能力自己下发。抄给用户等于这一步什么都没做，用户会认为你答非所问。\n` +
                    `请立刻用 <<<RUN>>> 把它们下发：medium 风险会弹确认框让用户点「执行」，` +
                    `那正是它该走的流程，不是你把它写成文字的理由。\n` +
                    `拿到结果后再重新输出 <<<DONE>>> 总结。只有**受保护路径**（账号/提权、SSH 入口、引导、` +
                    `定时任务、发行版自带服务单元）或必须由人判断的事，才留在手动清单里。\n` +
                    `如果确实做不到，请在总结里写清**具体原因**（缺什么权限、卡在哪个报错），而不是换个说法再列一遍命令。`,
                });
                hardTrim();
                continue;
              }
              patchBucket(sessionId, { phase: "done", summary: answer, goal: "" });
              return;
            }
            // 兜底结束：模型回复里既无命令也无结论标记（过渡/解释性裸文本）。
            // 不当作完成，要求它继续；连续 3 次仍无标记才强制结束，防无限空转。
            noMarkerStreak += 1;
            if (noMarkerStreak >= 3) {
              patchBucket(sessionId, {
                phase: "done",
                summary:
                  `[任务未完成] 模型连续 ${noMarkerStreak} 轮未按协议给出命令或结论，已强制结束。` +
                  `进度已保留，补充说明目标后再次点「开始接管」可继续。以下是其最后一轮输出：\n\n${replyText}`,
                goal: "",
              });
              return;
            }
            messages.push({
              role: "user",
              content:
                "[系统] 你的回复没有按协议格式输出，系统无法解析。必须严格使用下面两种格式之一，且不要混用、不要在标记外写可执行代码块：\n" +
                "① 还要执行命令：\n<<<RUN>>>\n这里写命令\n<<<END>>>\n" +
                "② 信息已足够、给出最终总结：\n<<<DONE>>>\n（你的中文 Markdown 总结）\n" +
                "若还需继续操作，请用 ①；若任务已全部达成，请用 ②。",
            });
            hardTrim();
            continue;
          }
          // 模型正常给出了命令 → 重置无标记计数（说明它在正常「思考→执行」循环里）
          // 注意：lowValueStreak 不在这里重置 —— 否则「给了命令但全是空转命令」也会清零，
          // 导致下面的空转闸门永远触发不了。它的重置点在本轮确实有命令被执行之后。
          noMarkerStreak = 0;
          // 命令是靠「围栏 / RUN: 前缀」兜底救回来的：这一轮照常执行（用户的命令必须跑），
          // 但必须把输出习惯掰回来 —— 否则它每轮都不打标记，引擎每轮都要靠兜底救一次，
          // 一旦模型换了个书写格式（比如改用编号列表）就整段失效，又回到「命令给了但不执行」。
          const protocolNote =
            parsed.normalizedFrom === "fence"
              ? "\n\n[系统] 你的命令写在代码围栏里、没有使用本轮协议标记，系统**这次已代为执行**（仅此一次兜底）。" +
                "下一轮请严格用 <<<RUN>>> … <<<END>>> 包住命令；要结束就用 <<<DONE>>> 并写出完整总结。"
              : parsed.normalizedFrom === "prefix"
                ? "\n\n[系统] 你用了 `RUN:` 单行前缀，系统**这次已代为执行**（兜底）。下一轮请改用 <<<RUN>>> … <<<END>>> 包住命令。"
                : "";
          if (parsed.commands.length === 0) {
            // 畸形回复：既没有命令、也不是结束标记 —— 例如只吐了一个孤立的
            // `<<<PLAN>>>`（计划块为空），parseAgentReply 会返回 done=false + 空命令。
            // 旧实现直接把 replyText 当结论落盘，于是「任务总结」卡片里只剩那行协议串，
            // 用户看到的就是「总结什么都没有」。这里一律打回重写，
            // 由上面的「无进展」总闸门兜底收敛，绝不把协议残片当结论。
            messages.push({
              role: "user",
              content:
                "[系统] 你的回复里既没有可执行命令，也没有结论正文，系统无法处理（疑似只输出了协议标记本身）。\n" +
                "请重新输出：要执行就用 <<<RUN>>>…<<<END>>> 包住命令；已完成就用 <<<DONE>>> 并写出完整的中文 Markdown 结论。",
            });
            hardTrim();
            continue;
          }

          // 逐条做安全审查
          const reviews = parsed.commands.map((c) => reviewCommand(c, { isProduction, privilege }));

          // 批量判定：只有「多条 + 全部是只读且无需确认」才批量执行。
          // 只要掺了写操作或需要确认的命令，就退化成只执行第一条 —— 安全第一。
          const canBatch =
            parsed.commands.length > 1 &&
            reviews.every(
              (r) =>
                (r.riskLevel === "none" || r.riskLevel === "low") && !r.requireConfirmation
            );

          // 命令准入：过滤零信息量命令（清屏/echo 打标记/查历史等），并限制单轮批量条数。
          // 这类命令执行了也拿不到新信息，只会占步数、刷输出、烧 token。
          const allCandidates = parsed.commands.map((cmd, i) => ({ cmd, review: reviews[i] }));
          const sliced = canBatch ? allCandidates.slice(0, MAX_BATCH_COMMANDS) : [allCandidates[0]];
          const droppedOverflow = allCandidates.length - sliced.length;

          // 单行净化：`;` / `&&` 串在引擎眼里永远只是「一条命令」—— 单轮条数上限
          // （4 条）与风险确认粒度都看不见它，跨轮去重台账在首次下发时也全是 0。
          // 实测出现过「一行内把同一条子命令逐字重复约 46 次」：整条原样下发，
          // 把终端刷成一面墙，还大概率因超出 PTY 行缓冲而丢掉尾部哨兵。
          // 逐字重复的子命令直接折叠；剩余子命令超过上限、或整行过长的整条拒绝，
          // 并要求模型拆成多轮（静默截断会让它以为命令跑完了，反而更糟）。
          const cleaned = sliced.map((c) => ({ ...c, clean: sanitizeCommandLine(c.cmd) }));
          const dedupedTotal = cleaned.reduce((n, c) => n + c.clean.dedupedCount, 0);
          const usable = cleaned
            .filter((c) => c.clean.overflow.length === 0)
            .map((c) => ({ ...c, cmd: c.clean.command }));
          const rejectedPacked = cleaned
            .filter((c) => c.clean.overflow.length > 0)
            .map((c) => ({ cmd: c.cmd, cleanup: c.clean }));

          const droppedInteractive = usable
            .filter((c) => INTERACTIVE_CMD_RE.test(c.cmd))
            .map((c) => c.cmd);
          // 结构残缺的命令（`for x in *` 缺 done、`if` 缺 fi、引号不闭合…）：单独下发会让
          // 远端 shell 停在续行提示符上等输入，这一步直接挂到硬超时（实测 300s 不动），
          // 而且残留的半个结构还会吃掉下一条命令。必须拦下并要求补全。
          const droppedIncomplete = usable.filter((c) => shellIncomplete(c.cmd)).map((c) => c.cmd);
          // dump 二进制：`cat 可执行文件` 会把上百 MB 乱码灌进 PTY（实测一步卡 320 秒、
          // 刷满整个终端、把后续所有输出淹掉）。必须在解析后硬拦，见 isBinaryDumpCommand。
          const droppedBinary = usable.filter((c) => isBinaryDumpCommand(c.cmd)).map((c) => c.cmd);
          // 终端回显碎片：模型把屏幕内容按提示符/字符重放过一遍（实测下发
          // `[root@mgt signature]#`、`r`、`m`、`r`、`f` 六个片段，六次 127）。
          // 这类东西永远不可能执行成功，只会在终端刷一屏 command not found。
          const droppedEcho = usable.filter((c) => isEchoFragment(c.cmd)).map((c) => c.cmd);
          // 环境探测去重：发行版 / 内核 / 包管理器已经在系统提示里，重探一次就白费一步。
          // 判据是「事实确实覆盖了这一维度」（envProbeCoveredBy），不是「看起来像探测」——
          // 宁可放过，也不能把真正需要执行的命令拦掉。
          const droppedEnv = usable
            .filter((c) => {
              const kind = envProbeKind(c.cmd);
              if (!kind || !envProbeCoveredBy(facts, c.cmd)) return false;
              if (envProbeAsked.has(kind)) return false;
              envProbeAsked.add(kind);
              return true;
            })
            .map((c) => c.cmd);
          const picked = usable.filter(
            (c) =>
              !LOW_VALUE_CMD_RE.test(c.cmd) &&
              !INTERACTIVE_CMD_RE.test(c.cmd) &&
              !isBinaryDumpCommand(c.cmd) &&
              !isEchoFragment(c.cmd) &&
              !droppedEnv.includes(c.cmd) &&
              !c.review.blocked &&
              !shellIncomplete(c.cmd)
          );
          const droppedLowValue = usable.filter((c) => LOW_VALUE_CMD_RE.test(c.cmd)).map((c) => c.cmd);
          // 受保护路径（账号/提权、SSH、引导、ld.so.preload、定时任务、服务单元）：
          // 用户明确要求「默认不做任何操作」，所以这里直接拒绝，不进确认队列、也不重试。
          const droppedProtected = usable.filter((c) => c.review.blocked).map((c) => c.cmd);
          // 记下来给 DONE 收尾时判断：这些确实只能人工做，写进手动清单是合理的。
          // 同时落进 bucket —— 它们不建 step，换目标后简报全靠这个字段把它们带过去。
          if (droppedProtected.length > 0) {
            blockedCommands.push(...droppedProtected);
            patchBucket(sessionId, { blockedCommands: [...blockedCommands] });
          }

          // 本轮只发了「已经确认过」的环境探测：不执行（省一步），直接把事实回填。
          // 这一支**不能计入 lowValueStreak** —— 它是有效回答，不是空转。
          if (picked.length === 0 && droppedEnv.length > 0) {
            messages.push({
              role: "user",
              content:
                `[系统] 环境已在前面确认过，本轮探测命令没有执行（${droppedEnv.map((c) => `\`${c}\``).join("、")}）—— 重复探测只会白占一步。\n` +
                `已确认环境：${renderHostFacts(facts)}。\n` +
                `请直接用它决定包管理器与路径（例如 CentOS 用 \`yum\`/\`dnf\`，Debian 系用 \`apt\`），给出能推进目标的下一步命令。`,
            });
            hardTrim();
            continue;
          }

          /**
           * 逐个硬编码枚举：命令本身合法，但它是「数量驱动」的活。
           *
           * 实测：32 个按天目录被写成一条 `mkdir -p` 塞 5 个路径，要 6~7 轮才建完，
           * 每轮重发整段上下文 —— 4 步 146s、47.8k token，最后还没建完就宣布完成。
           * 同一件事用一行 `for i in $(seq 0 31)` 一轮就完。提示词已经要求写循环，
           * 这里是**不依赖提示词**的兜底：命中就整批打回，把改写模板直接给它。
           *
           * 打回不建 step、不计入 lowValueStreak（这是写法问题，不是空转），
           * 但只打回 2 次：模型坚持手抄就让它跑，别把任务困在「改写法」上。
           */
          const enumHit = findEnumeration(picked.map((c) => c.cmd));
          // 只对**写操作**打回：只读枚举（`ls -l a/1 a/2 a/3 a/4`）一次就结束，
          // 多花一轮去纠正反而更亏；写操作才会因为「一批只写 5 个」拖成七轮。
          // 判据用 isStateChanging 而不是 riskLevel —— `mkdir -p` 被安全分级归为 low
          // （建目录本身无破坏性），用它当「是否写操作」会漏掉本案的主角。
          const enumIsWrite = picked.some((c) => isStateChanging(c.cmd));
          if (enumHit && enumIsWrite && enumNudgeStreak < 2) {
            enumNudgeStreak += 1;
            messages.push({
              role: "user",
              content:
                `[系统] 本轮命令已拒绝执行 —— ${suggestLoopRewrite(enumHit)}\n` +
                `注意：\`for\`/\`while\` 多行结构会被引擎落盘成脚本执行（不会卡在续行提示符），放心写。`,
            });
            hardTrim();
            continue;
          }

          if (picked.length === 0) {
            // 连续 3 轮全部被拒：说明模型卡死在自己的输出模式里且没听懂纠正，
            // 再喂系统消息也只是白烧 API 调用（这些轮不建 step、不耗步数预算，
            // 只有任务总超时兜底）。到点强制收尾，让人接手。
            lowValueStreak += 1;
            if (lowValueStreak >= 3) {
              patchBucket(sessionId, {
                phase: "done",
                summary:
                  `[任务未完成] 模型连续 ${lowValueStreak} 轮给出的命令都无法执行` +
                  `（空转命令 / 单行过载 / 结构残缺 / 交互式 / dump 二进制 / 受保护路径写入），已强制结束。` +
                  `进度已保留，请把目标描述得更具体后再次点「开始接管」。`,
                goal: "",
              });
              return;
            }
            // 拒绝原因必须分开说 —— 旧文案一律说「空转命令」，但「一行里塞太多子命令」
            // 是完全不同的病：模型会以为自己发的是合法命令，于是反复重发同一条。
            const reasons: string[] = [];
            if (droppedProtected.length > 0) {
              reasons.push(
                `\`${brief(droppedProtected[0])}\` 会写入**受保护路径**（账号/提权、SSH 登录、引导、` +
                  `\`ld.so.preload\`、定时任务、发行版自带的服务单元 \`/usr/lib/systemd/system\`），` +
                  `接管期间一律不执行 —— ` +
                  `这类文件改错会导致永久登不进机器，而且没有可靠的事后校验手段。` +
                  `**换写法也一样被拦**（\`sed -i\` / \`tee\` / 重定向 / 解释器打开文件都不行）。` +
                  `请把这个动作写进最终总结的「需要手动执行的操作」，改去做其它还能推进目标的步骤；` +
                  `如果整个目标都依赖它，现在就用 <<<DONE>>> 收尾并说明原因。` +
                  `（注意：\`/etc/systemd/system/\` 下**自定义**单元文件不属于这里，那是可以写的，只会弹确认。）`
              );
            }
            if (rejectedPacked.length > 0) {
              const first = rejectedPacked[0];
              reasons.push(
                `你给出的命令 \`${brief(first.cmd)}\` 在**一行里塞了过多子命令**` +
                  `（\`;\` / \`&&\` 串联后仍有 ${first.cleanup.subCommandCount} 条，上限 ${AGENT_MAX_SUB_COMMANDS_PER_LINE} 条），已整条拒绝执行。` +
                  `请拆成多轮，每轮只推进一个子目标。`
              );
            }
            if (droppedLowValue.length > 0) {
              reasons.push(
                `你给出的命令 \`${droppedLowValue.join("`、`")}\` 属于拿不到任何新信息的空转命令` +
                  `（清屏 / echo 打标记 / 查历史 / 无参数 cat 等），已拒绝执行。`
              );
            }
            if (droppedInteractive.length > 0) {
              reasons.push(
                `\`${droppedInteractive.join("`、`")}\` 是交互式 / 会挂住终端的命令，已拒绝执行。` +
                  `看进程请用 \`ps aux --sort=-%cpu | head -20\`；看实时负载用 \`uptime\` 或 \`top -b -n 1 | head -20\`；长输出自带 \`| head -N\`。`
              );
            }
            if (droppedIncomplete.length > 0) {
              reasons.push(
                `\`${brief(droppedIncomplete[0])}\` 的命令结构**没写完**已拒绝执行：` +
                  `shell 复合结构必须整段给出（\`for\`/\`while\` 要有配对的 \`done\`、\`if\` 要有 \`fi\`、\`case\` 要有 \`esac\`、引号与括号要闭合）。` +
                  `半截结构下发后，终端会停在续行提示符 \`>\` 上一直等输入，只能等超时。` +
                  `**优先用单条命令**（例如删除目录里除某项外全部内容：\`find . -maxdepth 1 -mindepth 1 ! -name 要保留的名字 -exec rm -rf {} +\`），确实要写循环就把整段写完整。`
              );
            }
            if (droppedBinary.length > 0) {
              reasons.push(
                `\`${droppedBinary.join("`、`")}\` 是在 dump 二进制/库/设备/私钥文件，已拒绝执行 —— ` +
                  `把一个可执行文件的二进制内容倒进终端会灌进上百 MB 乱码，刷满屏幕并让后续所有输出错位。` +
                  `要确认某个可执行文件是否装好、是什么东西，请用：\`file 路径\`、\`ls -la 路径\`、\`路径 --version\`（或 \`command -v 名字\`）。`
              );
            }
            if (droppedEcho.length > 0) {
              reasons.push(
                `\`${droppedEcho.slice(0, 3).join("`、`")}\` 是**终端回显**（提示符 / 单词碎片），不是命令，已拒绝执行 —— ` +
                  `把屏幕内容按原样或按字符重放，只会在终端刷出一排 \`command not found\`。` +
                  `需要看当前状态就直接发查询命令（\`pwd\`、\`ls -la .\`），不要回放已显示过的画面。`
              );
            }
            messages.push({
              role: "user",
              content:
                `[系统] ${reasons.join("\n")}\n` +
                `**请直接给出能推进目标的具体命令**（例如带明确对象与输出限制的查看、检测、安装命令）；` +
                `若信息已足够，请用 <<<DONE>>> 给出最终总结。`,
            });
            hardTrim();
            continue;
          }
          // 本轮确实有命令进入执行 → 清空空转计数（走到这里说明 picked.length > 0）
          lowValueStreak = 0;
          // 告知类：本轮对命令做过什么改动，必须说清 —— 模型看不见引擎的净化，
          // 不告诉它就会以为命令原样执行了，下一轮再发一遍同样的东西。
          const advisories: string[] = [];
          if (dedupedTotal > 0) {
            advisories.push(
              `本轮有 ${dedupedTotal} 个子命令是**逐字重复**的，已自动折叠为一次执行` +
                `（在一条命令里重复同一条子命令属于输出退化，系统会折叠，但你应该重新组织命令）。`
            );
          }
          for (const r of rejectedPacked) {
            advisories.push(
              `命令 \`${brief(r.cmd)}\` 一行里仍有 ${r.cleanup.subCommandCount} 个子命令` +
                `（超过上限 ${AGENT_MAX_SUB_COMMANDS_PER_LINE} 条），已拒绝执行，请拆成多轮。`
            );
          }
          for (const c of droppedProtected) {
            advisories.push(
              `命令 \`${brief(c)}\` 会写入**受保护路径**（账号/提权、SSH 登录、引导、\`ld.so.preload\`、` +
                `定时任务、systemd 单元），接管期间一律不执行 —— 这类文件改错会导致永久登不进机器。` +
                `**换写法同样会被拦**（\`sed -i\` / \`tee\` / 重定向 / 解释器打开文件都不行）。` +
                `请把它写进最终总结的「需要手动执行的操作」，本轮改做其它能推进目标的事。`
            );
          }
          if (droppedIncomplete.length > 0) {
            advisories.push(
              `命令 \`${brief(droppedIncomplete[0])}\` 的结构**没写完**（缺少配对的 \`done\`/\`fi\`/\`esac\`，或引号未闭合），已拒绝执行 —— ` +
                `半截结构下发后终端会停在续行提示符 \`>\` 上一直等输入。请补全后重发，或改用单条命令。`
            );
          }
          if (droppedOverflow > 0) {
            // 必须说清「为什么只跑了一条」。旧文案只报「只执行了前 N 条」，
            // 模型不知道真实原因（混了写命令 → 整批降级为单条），下一轮照旧把
            // 「只读探测 + 安装」混在一起提交，于是永远在探测、永远不安装。
            const blockedByWrite = !canBatch && allCandidates.length > 1;
            advisories.push(
              blockedByWrite
                ? `这批命令里混有写操作或需要确认的命令，出于安全本轮只执行了第 1 条 ` +
                    `\`${sliced[0]?.cmd ?? ""}\`。**写命令（安装 / 改配置 / 启停服务）必须独占一轮单独发**，` +
                    `不要和只读探测混在同一批；被挡下的只读探测可以留到下一轮再批量发。`
                : `本轮你一次提交了 ${allCandidates.length} 条命令，超过单轮上限，` +
                    `只执行了前 ${picked.length} 条。`
            );
          }
          if (advisories.length > 0) {
            messages.push({
              role: "user",
              content:
                `[系统] ${advisories.join("\n")}\n` +
                (droppedInteractive.length > 0
                  ? `已额外拦掉交互式命令 \`${droppedInteractive.join("`、`")}\`（会卡住终端）；` +
                    `改用在前面提示过的非交互写法。\n`
                  : ``) +
                `请聚焦：每轮最多 ${MAX_BATCH_COMMANDS} 条，每条最多 ${AGENT_MAX_SUB_COMMANDS_PER_LINE} 个子命令，` +
                `且只给与当前子目标直接相关的命令。`,
            });
          }

          // 重复命令硬闸门（**两道网，阈值一致**：本命令 / 本命令族已成功跑过 ≥2 次
          // → 第 3 次拒绝。允许 1~2 次是给「写操作后复查状态」留余量）。
          //
          // ① 逐字重复：同一个字面量第 3 次出现。
          // ② **同族变体**：同一目标换 flag / 套 `| head`（`ls -1` → `ls -1t | head -1`
          //    → `ls -la`）。为什么必须有这道网：① 只在「同一字面量第 3 次」时才拦，
          //    而换个参数写法就是一条全新键、从头计数 —— 实测截图里模型在同一个目录上
          //    连跑 5 条变体全部放行（探针复现：第 6 条 `ls -1` 才被拦），于是它可以
          //    永远「换个角度再看一眼」。族计数只覆盖只读白名单命令，且**写命令执行后
          //    清空**（装完/改完再看一眼是合法复查，不是空转）。
          //
          // 另外两个此前漏掉的地方：
          // ① 旧实现只看 `commandsToRun[0]`，批量里的第 2~4 条**从来没被检查过** ——
          //    而批量只读探测恰恰是最主要的执行路径；
          // ② 旧实现命中就整轮 `continue` —— 于是 `[新命令A, 重复命令, 新命令B]` 会拿
          //    A、B 给重复命令陪葬。现在只剔除重复的那条，其余照常执行。
          const blockedReasons = new Map<string, DupReason>();
          const runnable = picked.filter((c) => {
            const r = dupTracker.dupReason(c.cmd);
            if (!r) return true;
            blockedReasons.set(c.cmd, r);
            return false;
          });
          const droppedDup = [...blockedReasons.keys()];
          const normCmd = (c: string) => c.trim().replace(/\s+/g, " ");
          const whyOf = (cmd: string): string => {
            const r = blockedReasons.get(cmd);
            if (!r) return "";
            if (r.kind === "failed") {
              return `\`${cmd}\`：**上一次就以这个写法失败过**，且之后没有任何成功的变更操作 —— 前提没变，原样重跑只会得到同一份报错`;
            }
            if (r.kind === "exact") return `\`${cmd}\`：本次任务中已成功执行过，结果已知`;
            const sib = r.siblings.filter((s) => s !== normCmd(cmd));
            const sibText = sib.length > 0 ? sib.map((s) => `\`${s}\``).join("、") : "同目标的其它写法";
            return `\`${cmd}\`：与已成功执行过的 ${sibText} 是**同一目标的同类查询**（只换了参数写法），结果不会变`;
          };
          if (runnable.length === 0) {
            // 全轮都是重复命令 → 拒绝本轮。**把它此前拿到的输出一并回填**，
            // 这样它不必为了「再看一眼」再多花一轮往返。
            //
            // 回填用 `lastFull`（较长聚焦视图）而不是 `lastDigest`（240 字符摘要）：
            // 模型重发已执行过的只读命令，多半是因为上一轮那段输出被截断了、没看清。
            // 只回 240 字符等于告诉它「就是这个」，它拿不到新信息 → 继续换写法重发 →
            // 连拒 3 轮被强制结束，而真正原因（输出被截断）始终没被说出来。
            // 这里把带「省略第 a~b 行」标注的较长原文直接给它，一次满足「再看一眼」。
            let backfillBudget = 8000;
            // 失败重跑的那类没有「成功输出」可回填，只能回填上次的报错 ——
            // 而报错正是它此刻最需要看到的东西（看了就知道为什么不能重跑）。
            const failedOnly = droppedDup.every((c) => blockedReasons.get(c)?.kind === "failed");
            const backfill = droppedDup
              .map((c) => {
                const r = blockedReasons.get(c);
                const body =
                  r?.kind === "failed"
                    ? r.failDigest || ""
                    : dupTracker.lastFull(c) || dupTracker.lastDigest(c);
                if (!body) return `\n- \`${c}\`:（无输出）`;
                const allow = Math.min(4000, backfillBudget);
                const clip =
                  body.length > allow
                    ? `${body.slice(0, allow)}\n…（输出过长，已再次截断）`
                    : body;
                backfillBudget = Math.max(800, backfillBudget - clip.length);
                return r?.kind === "failed"
                  ? `\n- \`${c}\` 上次的报错：\n\`\`\`\n${clip}\n\`\`\``
                  : `\n- \`${c}\` 此前输出：\n\`\`\`\n${clip}\n\`\`\``;
              })
              .join("");
            const reasons = droppedDup.map((c) => `- ${whyOf(c)}`).join("\n");

            // 「模型看不见的命令」不算它的错：
            // 硬闸门用全量历史，但模型只能看到台账窗口内的内容。长任务里它重发一条
            // 自己从没见过的旧命令 → 被判重复 → 连拒 3 轮任务提前结束，而它完全
            // 不知道错在哪。这里先查一遍：被拒的命令若**一条都没出现在上一轮台账里**，
            // 就把窗口放大到覆盖全量、回填输出，本轮不计入连拒，给一次公平机会。
            const invisible = droppedDup.filter(
              (c) => !ledgerWindowText.includes(brief(normCmd(c), 80))
            );
            if (invisible.length === droppedDup.length && executedLog.length > 0) {
              logWindowSize = Math.max(logWindowSize, executedLog.length);
              dupStreak = 0;
              messages.push({
                role: "user",
                content:
                  `[系统] 这些命令此前确实执行过，但它们**不在你上一轮看到的清单里**` +
                  `（清单只保留最近若干条，现在已补全）。直接采用下面的输出继续推进：${backfill}\n` +
                  `若确实需要新信息，请换**不同目标或不同维度**的命令。`,
              });
              hardTrim();
              continue;
            }

            dupStreak += 1;
            if (dupStreak >= 3) {
              // 连拒 3 轮仍只会重发旧命令：它已经拿不回新信息了，继续喂系统消息只是
              // 白烧 API（这些轮不建 step、不耗步数预算，只有任务总超时能兜）。
              patchBucket(sessionId, {
                phase: "done",
                summary:
                  `[任务未完成] 模型连续 ${dupStreak} 轮只重复已执行过的命令` +
                  `（含换参数写法重看同一目标的同类查询），已强制结束。\n\n` +
                  `当前命令结果都在下面这条已执行清单里：\n` +
                  `${buildLedgerLines().join("\n")}\n\n` +
                  `如需继续，请把下一步说清楚（或直接指出卡在哪），再点「开始接管」。`,
                goal: "",
              });
              return;
            }
            // 失败重跑被拒时的引导，和「重复只读」完全不同：后者只要看回填就能继续，
            // 前者必须**改变前提**才可能成功，否则模型只会换个写法再撞一次。
            const hint = failedOnly
              ? `这些命令**上一次就以同样的写法失败过**，重跑不会改变结果。请先改变前提再重试：\n` +
                `- 包冲突/依赖缺失：先定位冲突来源（例如 \`rpm -qf /usr/bin/zabbix_get\`、\`repoquery --whatprovides /usr/bin/zabbix_get\`），\n` +
                `  再决定卸哪个包、装哪套源 —— 不要继续用同一条 install 硬撞；\n` +
                `- 权限、路径、服务未启动：先补前提（起服务 / 建目录 / 装依赖）再执行原命令；\n` +
                `- **需要用户授权的变更（卸载、改配置、重启）**：用 <<<RUN>>> 正常下发，系统会弹确认让用户点，\n` +
                `  这**不是**让你写进「需要手动执行的操作」的理由 —— 那是最后手段，不是第一步；\n` +
                `- 确实无解才收尾，并在总结里写明卡在哪一步、报错原文是什么。\n` +
                `禁止原样重发，也禁止只改空格/引号/参数顺序再来一次。`
              : `**请直接采用这些结果继续推进**；若你是因为上一轮输出被截断才重发的，看这份回填即可 —— ` +
                `仍缺的那几行：文件输出用 \`sed -n 'a,bp' 文件\`，命令输出换更窄的参数重取；` +
                `若确实需要新信息，请换**不同目标或不同维度**的命令` +
                `（换目标路径、换观察角度），而不是换参数写法重看同一处；` +
                `若信息已足够，请用 <<<DONE>>> 给出总结。`;
            messages.push({
              role: "user",
              content:
                `[系统] 本轮命令已拒绝执行，避免重复消耗。原因：\n${reasons}\n` +
                `以下是它们的输出（比上一轮给你的更完整，带「省略第 a~b 行」标注）：${backfill}\n` +
                hint,
            });
            hardTrim();
            continue;
          }
          dupStreak = 0;
          if (droppedDup.length > 0) {
            // 部分命中：说清「为什么这批少跑了几条」，否则模型看到条数对不上会重发一遍。
            const reasons = droppedDup.map((c) => `- ${whyOf(c)}`).join("\n");
            messages.push({
              role: "user",
              content:
                `[系统] 本轮里的 ${droppedDup.map((c) => `\`${c}\``).join("、")} 已剔除，` +
                `结果已知、无需重看。原因：\n${reasons}\n` +
                `其余命令照常执行；需要它们的结果请直接引用上面的台账片段。`,
            });
          }

          const commandsToRun = runnable.map((c) => c.cmd);
          const reviewsToRun = runnable.map((c) => c.review);

          const stepId = uid();
          const step: AgentStep = {
            id: stepId,
            index: (get().buckets[sessionId] ?? EMPTY_BUCKET).steps.length + 1,
            thought: parsed.thought,
            items: commandsToRun.map((cmd, i) => ({
              command: cmd,
              risk: reviewsToRun[i].riskLevel,
              status: "pending",
              output: "",
              exitCode: null,
              timedOut: false,
            })),
            risk: maxRisk(reviewsToRun.map((r) => r.riskLevel)),
            batched: canBatch,
            status: "pending",
          };
          set((s) => {
            const b = s.buckets[sessionId] ?? EMPTY_BUCKET;
            return { buckets: { ...s.buckets, [sessionId]: { ...b, steps: [...b.steps, step] } } };
          });

          // 风险策略：none/low 自动执行；medium 由开关决定；high/critical 必须确认
          const needConfirm = reviewsToRun.some((r) => {
            if (r.riskLevel === "high" || r.riskLevel === "critical" || r.requireConfirmation) {
              return true;
            }
            if (r.riskLevel === "medium") return !get().autoRunMedium;
            return false;
          });

          if (needConfirm) {
            // 等用户点确认不属于模型耗时，单独标记（文案也会切成「等待你确认」）
            setStage("confirm");
            const decision = await requestConfirm(
              sessionId,
              stepId,
              commandsToRun[0],
              reviewsToRun[0]
            );
            if (decision === "abort") {
              updateStepItem(sessionId, stepId, 0, { status: "skipped", error: "用户终止" });
              updateStep(sessionId, stepId, { status: "skipped", finishedAt: Date.now() });
              // 保留 requestConfirm 已经写好的原因（超时终止有具体文案），
              // 只有用户主动点「终止」时 error 才是空的。
              const reason = get().buckets[sessionId]?.error;
              patchBucket(sessionId, {
                phase: "stopped",
                error: reason || "已终止任务，该命令未执行",
              });
              return;
            }
            if (decision === "skip") {
              updateStepItem(sessionId, stepId, 0, { status: "skipped", error: "用户跳过" });
              updateStep(sessionId, stepId, { status: "skipped", finishedAt: Date.now() });
              executedLog.push(logLine("⊘", commandsToRun[0]));
              skippedChanges.push(commandsToRun[0]);
              // 被跳过的若是**变更类**命令，「换用更安全的只读方式」根本不存在 ——
              // 旧文案把模型逼进死胡同，紧接着又递上一句「或信息足够时用 DONE」，
              // 于是它转头把命令抄进「需要手动执行的操作」丢回给用户。
              // 实测事故：`yum remove -y zabbix-get` 被跳过 → 原样重跑 install → DONE 推卸。
              const skippedRisk = reviewsToRun[0].riskLevel;
              const isChange =
                skippedRisk === "medium" || skippedRisk === "high" || skippedRisk === "critical";
              messages.push({
                role: "user",
                content: isChange
                  ? `[系统] 命令 \`${commandsToRun[0]}\` 被用户**跳过**，未执行（风险 ${skippedRisk}）。\n` +
                    `不要原样重发这条，也不要因此把整批命令降级成「请手动执行」。按下面两种情况之一处理：\n` +
                    `1) 它是完成目标所必需的变更 → 找**等价但更小的一步**自行推进（例：先定位冲突来源 \`rpm -qf <冲突文件>\`、\n` +
                    `   只装不冲突的包、加 \`--setopt=obsoletes=0\` 之类的参数），或再用 <<<RUN>>> 下发一次并说明为什么要做；\n` +
                    `2) 确实没有替代路径 → 在 <<<DONE>>> 里写明「用户跳过了 X」以及跳过它导致的具体后果。\n` +
                    `注意：跳过 ≠ 失败，更不等于任务到此为止。`
                  : `[系统] 命令 \`${commandsToRun[0]}\` 被用户跳过，未执行。请换用更安全的只读方式继续，或信息足够时用 <<<DONE>>> 给出结论。`,
              });
            hardTrim();
            continue;
            }
          }

          updateStep(sessionId, stepId, { status: "running", startedAt: Date.now() });
          // 命令执行阶段：耗时可能到分钟级（安装/下载），但它不是模型在思考
          setStage("exec");

          if (canBatch) {
            // 批量只读探测：串行跑完所有命令，一次性回传，省掉多次 AI 往返
            const results = await execCommandBatch(sessionId, commandsToRun, {
              timeoutMs,
              maxTimeoutMs,
              signal: abort.signal,
              onItemStart: (i) => updateStepItem(sessionId, stepId, i, { status: "running" }),
              onItemOutput: (i, out) => updateStepItem(sessionId, stepId, i, { output: capLive(out) }),
              // 注意：落盘用的是 **res.output 原始文本**，不是 capOutput 之后的片段。
              // 这里刻意放在 capOutput 之前取，顺序颠倒就只剩 4000 字。
              onItemDone: (i, res) => {
                const status = isOk(res) ? "done" : "failed";
                updateStepItem(sessionId, stepId, i, {
                  status,
                  output: capOutput(res.output),
                  exitCode: res.exitCode,
                  timedOut: res.timedOut,
                  error: res.error,
                });
                persistOutput(
                  step.index,
                  i,
                  {
                    command: commandsToRun[i] ?? "",
                    risk: reviewsToRun[i]?.riskLevel ?? "none",
                    status,
                    exitCode: res.exitCode,
                    timedOut: res.timedOut,
                  },
                  res.output
                );
              },
            });
            const entries = commandsToRun
              .slice(0, results.length)
              .map((c, i) => ({ command: c, result: results[i] }));
            commandsToRun.forEach((c, i) => {
              const r = results[i];
              const ok = !!r && isOk(r) && !r.timedOut;
              dupTracker.record(c, ok, r?.output);
              if (r) recordProbe(c, r);
              if (r) failTreadmill.observe(r.output ?? "", isOk(r) && !r.timedOut);
              executedLog.push(
                logLine(r ? (r.timedOut ? "⏱" : isOk(r) ? "✓" : "✗") : "?", c, r?.output)
              );
            });
            updateStep(sessionId, stepId, { status: "done", finishedAt: Date.now() });
            // 采集主机画像：这批只读探测里若含 os-release / uname / command -v，
            // 立刻固化成事实并刷新系统提示，后续轮次与新任务都不必重探。
            absorbFacts(
              entries.map((e) => ({
                command: e.command,
                output: e.result?.output ?? "",
                exitCode: e.result?.exitCode ?? null,
              }))
            );
            // 批量里若有命令触发输出洪水（读了二进制 / 死循环刷屏），必须点名说清，
            // 否则模型看到残缺输出会以为命令没跑完，下一轮再发一遍同类命令。
            const floodedAt = results.findIndex((r) => r?.flooded);
            const floodedNote =
              floodedAt >= 0
                ? `\n\n[系统] 其中 \`${commandsToRun[floodedAt]}\` 的输出**过大，已被强制截断并中断**` +
                  `（典型原因：读取了二进制/可执行文件，或命令死循环刷屏）。请不要再发同类命令；` +
                  `要确认程序/包请用 \`file 路径\`、\`ls -la 路径\`、\`路径 --version\`、\`command -v 名字\`。`
                : "";
            // 两类告知互斥：探测告知更具体（带替代命令），命中时不再叠加通用失败告知，
            // 否则同一轮塞两段「换方法」提示会互相稀释。
            const probeNote = probeNoteFor(commandsToRun);
            // EBUSY 是内核状态、服务启动失败没有根因 —— 这两类失败签名每步都不同，
            // 连击提醒凑不够两次，必须单点说清（diagNoteFor 内部已做「同一段只发一次」）。
            const diagNote = diagNoteFor(
              results.map((r) => r?.output ?? "").join("\n"),
              commandsToRun.join("; ")
            );
            messages.push({
              role: "user",
              content:
                buildObservation(entries, OBSERVATION_MAX_CHARS, goal) +
                floodedNote +
                probeNote +
                diagNote +
                (probeNote || diagNote ? "" : failTreadmill.note()) +
                protocolNote +
                deferredDoneNote,
            });
            deferredDoneNote = "";
            hardTrim();
            continue;
          }

          // 单条执行（写操作 / 需要确认 / AI 只给了一条）
          const command = commandsToRun[0];
          let res: ExecResult;
          try {
            res = await execCommand(sessionId, command, {
              timeoutMs,
              maxTimeoutMs,
              signal: abort.signal,
              onOutput: (out) => updateStepItem(sessionId, stepId, 0, { output: capLive(out) }),
            });
          } catch (e) {
            const msg = (e as Error)?.message ?? String(e);
            dupTracker.record(command, false);
            executedLog.push(logLine("✗", command));
            updateStepItem(sessionId, stepId, 0, { status: "failed", error: msg });
            updateStep(sessionId, stepId, { status: "failed", finishedAt: Date.now() });
            // 终端已断开 / 未就绪：这是环境问题，换命令重试没有意义。
            // 旧实现会 continue，让模型再发 19 条命令、每轮一次完整 LLM 往返。
            if (/断开|未连接|未就绪/.test(msg)) {
              patchBucket(sessionId, {
                phase: "error",
                error:
                  `终端连接已断开（${msg}），任务已终止。重新连接后可点「开始接管」继续，` +
                  `已完成的步骤与命令记录都会保留。`,
              });
              return;
            }
            messages.push({
              role: "user",
              content: `[系统] 命令 \`${command}\` 执行时出错：${msg}。请改用其他方式，或用 <<<DONE>>> 给出结论。`,
            });
            hardTrim();
            continue;
          }

          updateStepItem(sessionId, stepId, 0, {
            status: isOk(res) ? "done" : "failed",
            output: capOutput(res.output),
            exitCode: res.exitCode,
            timedOut: res.timedOut,
            error: res.error,
          });
          persistOutput(
            step.index,
            0,
            {
              command,
              risk: reviewsToRun[0]?.riskLevel ?? "none",
              status: isOk(res) ? "done" : "failed",
              exitCode: res.exitCode,
              timedOut: res.timedOut,
            },
            res.output
          );
          executedLog.push(logLine(res.timedOut ? "⏱" : isOk(res) ? "✓" : "✗", command, res.output));
          dupTracker.record(command, isOk(res) && !res.timedOut, res.output);
          recordProbe(command, res);
          failTreadmill.observe(res.output ?? "", isOk(res) && !res.timedOut);
          updateStep(sessionId, stepId, {
            status: isOk(res) ? "done" : "failed",
            finishedAt: Date.now(),
          });
          absorbFacts([{ command, output: res.output ?? "", exitCode: res.exitCode }]);
          // 若 AI 一次给了多条却含非只读命令，明确告知只执行了第一条，避免它下轮重复提交
          const partialNote =
            parsed.commands.length > 1
              ? `\n\n（注意：你这次共给出 ${parsed.commands.length} 条命令，其中含有非只读或需要确认的命令，系统只执行了第 1 条。其余命令请在确认上一条结果后单独给出。）`
              : "";
          // 输出洪水（读了二进制 / 死循环刷屏）：必须明确告诉模型「被截断且被中断」，
          // 否则它看到残缺输出会以为命令还没跑完，下一轮再发一遍同类命令。
          const floodedNote = res.flooded
            ? `\n\n[系统] 这条命令的输出**过大，已被强制截断并中断执行**（典型原因：读取了二进制/可执行文件，或命令在死循环刷屏）。\n` +
              `请**不要**再发同类命令。要确认某个程序/包是否装好、是什么东西，正确做法是：\`file 路径\`、\`ls -la 路径\`、\`路径 --version\`、\`command -v 名字\`。`
            : "";
          const probeNote = probeNoteFor([command]);
          const diagNote = diagNoteFor(res.output ?? "", command);
          messages.push({
            role: "user",
            content:
              buildObservation([{ command, result: res }], OBSERVATION_MAX_CHARS, goal) +
              partialNote +
              floodedNote +
              probeNote +
              diagNote +
              (probeNote || diagNote ? "" : failTreadmill.note()) +
              protocolNote +
              deferredDoneNote,
          });
          deferredDoneNote = "";
          hardTrim();
        }

        if (abort.signal.aborted) {
          patchBucket(sessionId, { phase: "stopped" });
          return;
        }
      } catch (e) {
        const err = e as Error;
        if (err?.name === "AbortError") {
          patchBucket(sessionId, { phase: "stopped", error: "已停止" });
        } else {
          patchBucket(sessionId, { phase: "error", error: err?.message ?? String(e) });
        }
      } finally {
        runningSessions.delete(sessionId);
        // 结束就清掉阶段标记：否则下次进入面板时，残留的 stageSince 会让计时器接着上一次算
        patchBucket(sessionId, { stage: undefined, stageSince: undefined });
        // 运行记录收尾：把结论写进 manifest（导出时报告头部要用）。
        // 用 get() 而不是闭包里的 messages：这里的 summary 是模型最终结论，
        // 只有 store 里有；同时保证 finish 排在所有 append 之后。
        if (runRecorder) {
          const b = get().buckets[sessionId];
          void runReady
            .then(() =>
              runRecorder.finish({
                runId,
                summary: b?.summary,
                stepCount: b?.steps.length,
              })
            )
            .catch(() => {});
        }
        // 写回对话历史：停止/超时/出错后，用户再次「开始接管」即可在已有进展上续跑，
        // 不会因为重建 [system, goal] 而失忆、重复执行命令或答非所问。
        patchBucket(sessionId, { pendingConfirm: null, messages: messages.slice() });
        set((s) => {
          const nextResolvers = { ...s.confirmResolvers };
          delete nextResolvers[sessionId];
          const nextAborts = { ...s.abortRefs };
          delete nextAborts[sessionId];
          return { confirmResolvers: nextResolvers, abortRefs: nextAborts };
        });
      }
    },

    stop: (sessionId: string) => {
      const { abortRefs, confirmResolvers } = get();
      abortRefs[sessionId]?.abort();
      // 若正卡在用户确认，先用 abort 解除阻塞，再更新状态
      patchBucket(sessionId, { pendingConfirm: null, phase: "stopped" });
      set((s) => {
        const next = { ...s.confirmResolvers };
        delete next[sessionId];
        return { confirmResolvers: next };
      });
      confirmResolvers[sessionId]?.("abort");
    },

    resolveConfirm: (sessionId: string, decision: ConfirmDecision) => {
      const { confirmResolvers } = get();
      patchBucket(sessionId, { pendingConfirm: null, phase: "running" });
      set((s) => {
        const next = { ...s.confirmResolvers };
        delete next[sessionId];
        return { confirmResolvers: next };
      });
      confirmResolvers[sessionId]?.(decision);
    },

    reset: (sessionId: string) => {
      set((s) => {
        const next = { ...s.buckets };
        delete next[sessionId];
        return { buckets: next };
      });
    },

    dispose: (sessionId: string) => {
      const { abortRefs, confirmResolvers } = get();
      abortRefs[sessionId]?.abort();
      confirmResolvers[sessionId]?.("abort");
      set((s) => {
        const nextBuckets = { ...s.buckets };
        delete nextBuckets[sessionId];
        const nextAborts = { ...s.abortRefs };
        delete nextAborts[sessionId];
        const nextResolvers = { ...s.confirmResolvers };
        delete nextResolvers[sessionId];
        return { buckets: nextBuckets, abortRefs: nextAborts, confirmResolvers: nextResolvers };
      });
    },
  };
});

/**
 * 便捷 hook：拿到某个终端会话的 Agent 任务状态与操作方法。
 */
export function useSessionAgent(sessionId?: string | null) {
  const key = sessionId ?? "";
  // 用 useShallow 做字段级比较：`patchBucket` 每次都 `{...prev, ...patch}` 造新对象，
  // 直接订阅 `s.buckets[key]` 会让面板在**任何**一个字段变化时整块重渲染 ——
  // 流式期 liveThought 每 60ms 刷一次，步骤列表几十条时就是肉眼可见的卡顿。
  // 浅比较后只有「本次真的变了的字段」才触发渲染。
  //
  // liveThought 已经拆到 useSessionLiveThought 单独订阅：它变化最频繁，
  // 留在同一个 selector 里等于让流式输出继续拖着整个面板重渲染。
  const bucket = useAgentStore(
    useShallow((s) => {
      const b = key ? s.buckets[key] : undefined;
      // 逐字段取值 + 给默认值：useShallow 对返回对象做浅比较，
      // liveThought 刻意**不在这里**（见下方 useSessionLiveThought）。
      return {
        phase: b?.phase ?? EMPTY_BUCKET.phase,
        goal: b?.goal ?? EMPTY_BUCKET.goal,
        submittedGoal: b?.submittedGoal ?? EMPTY_BUCKET.submittedGoal,
        steps: b?.steps ?? EMPTY_BUCKET.steps,
        summary: b?.summary ?? EMPTY_BUCKET.summary,
        error: b?.error ?? EMPTY_BUCKET.error,
        pendingConfirm: b?.pendingConfirm,
        plan: b?.plan ?? EMPTY_BUCKET.plan,
        metrics: b?.metrics ?? EMPTY_BUCKET.metrics,
        // 导出需要：runId 关联磁盘上的完整输出，startedAt 作为报告的开始时间
        runId: b?.runId,
        startedAt: b?.startedAt,
        // 忙碌细分阶段：UI 据此把「等待 63s」标成到底在等什么
        stage: b?.stage,
        stageSince: b?.stageSince,
      };
    })
  );
  const autoRunMedium = useAgentStore((s) => s.autoRunMedium);
  const setGoalFn = useAgentStore((s) => s.setGoal);
  const setAutoRunMedium = useAgentStore((s) => s.setAutoRunMedium);
  const clearErrorFn = useAgentStore((s) => s.clearError);
  const runFn = useAgentStore((s) => s.run);
  const stopFn = useAgentStore((s) => s.stop);
  const resolveConfirmFn = useAgentStore((s) => s.resolveConfirm);
  const resetFn = useAgentStore((s) => s.reset);

  return {
    key,
    phase: bucket.phase,
    goal: bucket.goal,
    submittedGoal: bucket.submittedGoal,
    steps: bucket.steps,
    summary: bucket.summary,
    error: bucket.error,
    pendingConfirm: bucket.pendingConfirm,
    plan: bucket.plan,
    metrics: bucket.metrics,
    runId: bucket.runId,
    startedAt: bucket.startedAt,
    stage: bucket.stage,
    stageSince: bucket.stageSince,
    autoRunMedium,
    setGoal: (g: string) => key && setGoalFn(key, g),
    setAutoRunMedium,
    clearError: () => key && clearErrorFn(key),
    run: () => (key ? runFn(key) : Promise.resolve()),
    stop: () => key && stopFn(key),
    resolveConfirm: (d: ConfirmDecision) => key && resolveConfirmFn(key, d),
    reset: () => key && resetFn(key),
  };
}

/**
 * 流式思考文本单独订阅。
 *
 * 它每 60ms 变一次（store 端节流后的刷新节奏），是整条链路上频率最高的状态。
 * 把它和面板其它字段放同一个 selector，等于让每个流式片段都拖着整个步骤列表
 * 重渲染 —— 步骤一多就能明显看到「AI 说话时界面发涩」。
 */
export function useSessionLiveThought(sessionId?: string | null) {
  const key = sessionId ?? "";
  return useAgentStore((s) => (key ? s.buckets[key]?.liveThought : "")) ?? "";
}
