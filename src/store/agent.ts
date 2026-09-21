import { create } from "zustand";
import type { AIProviderConfig } from "@/types";
import type { RiskLevel } from "@/services/safety";
import { reviewCommand, isBinaryDumpCommand } from "@/services/safety";
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
  trimMessages as trimMessagesPure,
} from "@/lib/contextCompression";
import {
  buildObservation,
  createDupTracker,
  createFailTreadmill,
  digestOutput,
  execCommand,
  execCommandBatch,
  isExecOk,
  isNoInfoProbeOutput,
  parseAgentReply,
  probeTargetOf,
  sanitizeCommandLine,
  sanitizeOutput,
  shellIncomplete,
  type DupReason,
  type ExecResult,
} from "@/services/agent";
import { useAppConfig } from "./config";
import { useTerminalStore } from "./terminal";

export type AgentPhase = "idle" | "running" | "awaiting-confirm" | "done" | "stopped" | "error";

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
 * 单条命令：基础超时 = 硬上限 = 5 分钟。execCommand 的熔断条件是
 * 「已过基础超时 且 最近 3 秒无新输出」，所以只要命令还在吐输出就会一直续命。
 * 卡死的命令（读了二进制、进了交互态）3 秒静默即返回；真在下载/编译的
 * 长命令能一直跑，最多 5 分钟。两者必须同值，否则基础超时会先触发熔断，
 * 把硬上限架空（曾经 20s 基础超时导致 23s 就误判超时）。
 *
 * 单个任务：20 分钟总时限。实测一次「装 Prometheus」光 yum 装包就 107 秒，
 * 12 分钟会被吃干净；20 分钟够跑完常规部署。到点自动停止、进度保留，可续跑。
 */
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const TASK_TIMEOUT_MS = 20 * 60 * 1000;

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

  /** 挂起等待用户在 UI 上做决策 */
  const requestConfirm = (
    key: string,
    stepId: string,
    command: string,
    review: ReturnType<typeof reviewCommand>
  ): Promise<ConfirmDecision> =>
    new Promise((resolve) => {
      set((s) => ({
        confirmResolvers: { ...s.confirmResolvers, [key]: resolve },
      }));
      patchBucket(key, {
        phase: "awaiting-confirm",
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
      if (bucket.phase === "running" || bucket.phase === "awaiting-confirm") return;

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
      // 2. 上一任务已正常完成（done）且用户提交了**不同的新目标**。
      //    —— 此前这种情况被当成「续跑」：旧任务的全部观察消息还混在上下文里，
      //    模型把新问题当旧任务的延续，表现为「换个问题还重复执行之前那批命令」。
      //    done + 新目标 = 干净开始；done + 相同目标（用户想复查/扩展）仍走续跑。
      const isFresh =
        !bucket.messages ||
        bucket.messages.length === 0 ||
        (bucket.phase === "done" && goal.trim() !== bucket.submittedGoal.trim());

      const hostConfig = session.hostId ? useAppConfig.getState().getHost(session.hostId) : null;
      const isProduction = hostConfig?.tags?.some((t) => /生产|prod|线上|live/i.test(t));
      const privilege = session.username === "root" ? "root" : "user";

      const messagesInit: ChatMessage[] = [
        {
          role: "system",
          content: buildAgentSystemPrompt({
            hostIp: session.host,
            hostname: session.hostName,
            currentUser: session.username,
            privilege,
            hostTags: hostConfig?.tags,
            isProduction,
          }),
        },
        { role: "user", content: goal },
      ];

      patchBucket(sessionId, {
        phase: "running",
        error: null,
        pendingConfirm: null,
        liveThought: "",
        submittedGoal: goal,
        // 度量每次 run() 从零开始统计（本轮的耗时/token），不跨 run 累积
        metrics: { ...EMPTY_METRICS },
        // 续跑不清 steps/summary，保留任务连续性；仅首次运行才重置。
        ...(isFresh ? { steps: [], summary: "", plan: "" } : {}),
      });

      // 单条命令超时：基础超时与硬上限同值（见文件顶部 COMMAND_TIMEOUT_MS 说明）。
      const timeoutMs = COMMAND_TIMEOUT_MS;
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
      const MAX_AGENT_MESSAGES = 14;
      // 单任务步数上限（核心节流闸门）：没有它，模型可以无休止打转（实测跑到 64 步仍在
      // 空转），每一步都是一次「system + 计划 + 已执行清单 + 历史摘要」的完整请求，
      // token 消耗线性爆炸且问题不被解决。到点自动收尾，进度保留，用户可续跑或换目标。
      const MAX_AGENT_STEPS = 20;
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
      // 低价值命令连续拒绝计数：被拒轮不建 step、不耗步数预算，需要独立闸门防空转烧钱。
      let lowValueStreak = 0;
      // 全轮重复命令连续拒绝计数。重复命令被剔除后**台账计数不会增长**（没真的执行），
      // 所以单靠 dupTracker 无法收敛：模型可以一直重发同一条命令、一直被拒 ——
      // 每轮都是一次完整 API 往返。同样需要独立闸门兜住。
      let dupStreak = 0;

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
      const syncExecLog = () => {
        if (executedLog.length === 0) return;
        // 展示窗口 12 条：条目现在自带输出片段，比纯命令行更长。
        // 注意：重复命令的硬闸门用的是 dupTracker（完整历史），不受此窗口影响——
        // 所以缩小展示窗口不会放过重复执行。
        const capped = executedLog.slice(-12);
        const content =
          `${EXEC_LOG_PREFIX}\n已真实执行过（✓ 成功 / ✗ 失败 / ⊘ 跳过 / ⏱ 超时），→ 后为该命令的输出片段：\n` +
          `${capped.join("\n")}\n` +
          `（信息够就直接引用片段，不要为了「再看一眼」而重跑。）`;
        const idx = messages.findIndex((m) => m.content.startsWith(EXEC_LOG_PREFIX));
        if (idx !== -1) {
          messages[idx] = { role: "user", content };
        } else {
          // 插在计划 pin 之后（若有），否则 system 之后
          const planIdx = messages.findIndex((m) => m.content.startsWith(PLAN_PIN_PREFIX));
          messages.splice(planIdx !== -1 ? planIdx + 1 : 1, 0, { role: "user", content });
        }
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
       * 硬截断兜底：压缩失败或压缩不划算时保底，保证上下文不会无限膨胀。
       * 与旧版不同的是会显式保住「任务目标」，避免模型跑到后面忘了最初要干什么。
       */
      const hardTrim = () => {
        if (messages.length <= MAX_AGENT_MESSAGES) return;
        const next = trimMessagesPure(messages, MAX_AGENT_MESSAGES - 1, goal);
        messages.length = 0;
        messages.push(...next);
      };

      // 上下文压缩：把「中间段」旧消息压成一条结构化摘要，保留 system + 摘要 + 最近若干轮。
      // 触发从「只看条数」升级为「条数 或 估算 token 任一超标」——
      // 一条几万字符的工具输出和一句"好的"在旧逻辑里权重相同，是最容易漏防的情况。
      const COMPRESS_TRIGGER = 12;
      const MAX_CONTEXT_TOKENS = 24000;
      const KEEP_RECENT = 6;

      // 性能度量：每个 run() 一份，主循环与压缩调用都往里累加，实时落到 bucket 供 UI 展示。
      const metrics: AgentMetrics = { ...EMPTY_METRICS };
      const patchMetrics = () => patchBucket(sessionId, { metrics: { ...metrics } });
      const addUsage = (u?: { promptTokens: number; completionTokens: number }) => {
        if (!u) return;
        metrics.promptTokens += u.promptTokens;
        metrics.completionTokens += u.completionTokens;
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
          });
          const next = assembleCompressedMessages({ system, goal, summary, recent });

          // 收益校验：若压缩后反而更大（模型返回了啰嗦的摘要），这次压缩白花钱，回退硬截断
          if (estimateMessagesTokens(next) >= estimateMessagesTokens(messages)) {
            hardTrim();
            return;
          }

          messages.length = 0;
          messages.push(...next);
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
        }
      };

      try {
        for (;;) {
          if (abort.signal.aborted) break;
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
          const stepsUsed = (get().buckets[sessionId] ?? EMPTY_BUCKET).steps.length - startStepCount;
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
          // 已执行命令清单同样每轮钉住——模型每轮都看得见自己跑过什么，杜绝重复执行
          syncExecLog();

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
            // 瞬时空响应：复杂上下文下弱模型偶发空回复（不是配错模型）。
            // 配错模型（如 OCR/嵌入）两次都是空 → 重试仍空，抛上去给外层走原
            // 「请检查模型名」的报错。瞬时 provider 抖动 / 模型偶发空 → 重试命中。
            const msg = (e as Error)?.message ?? String(e);
            if (!msg.startsWith("模型未返回任何内容")) throw e;
            replyText = "";
            truncated = false;
            try {
              replyText = await callModel();
            } catch {
              throw e;
            }
            if (!replyText.trim()) throw e;
          } finally {
            // 确保最终完整文本落盘，避免节流导致末尾几字丢失
            patchBucket(sessionId, { liveThought: replyText });
          }
          messages.push({ role: "assistant", content: replyText });
          if (truncated) {
            messages.push({
              role: "user",
              content:
                "[系统] 你的上一条回复因达到单次输出长度上限被**截断**，内容不完整（命令块可能没写完整）。\n" +
                "请立即精简重发：思考说明压缩到 1-2 句，只给**最必要的一条**命令，不要重复已说过的内容。",
            });
          }
          hardTrim();
          // 本轮模型回复已消费（转为步骤/总结），清掉流式预览，避免与步骤重叠
          patchBucket(sessionId, { liveThought: "" });

          const parsed = parseAgentReply(replyText);
          if (parsed.plan) {
            // 计划声明：存为蓝图展示。计划本身已作为 assistant 消息留在 messages 中，
            // 模型后续轮次能看到自己的计划，下一轮开始用 <<<RUN>>> 逐步执行。
            // 同步更新 planText：压缩/截断把原始计划消息吃掉后，靠它重新钉住。
            planText = parsed.plan;
            patchBucket(sessionId, { plan: parsed.plan });
            noMarkerStreak = 0;
            continue;
          }
          if (parsed.done) {
            // 真·结束：模型显式给出 <<<DONE>>> 或明确结论 → 任务完成。
            if (!parsed.noMarkerFallback) {
              patchBucket(sessionId, { phase: "done", summary: parsed.finalAnswer ?? replyText, goal: "" });
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
          if (parsed.commands.length === 0) {
            patchBucket(sessionId, { phase: "done", summary: replyText, goal: "" });
            return;
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
          const picked = usable.filter(
            (c) =>
              !LOW_VALUE_CMD_RE.test(c.cmd) &&
              !INTERACTIVE_CMD_RE.test(c.cmd) &&
              !isBinaryDumpCommand(c.cmd) &&
              !shellIncomplete(c.cmd)
          );
          const droppedLowValue = usable.filter((c) => LOW_VALUE_CMD_RE.test(c.cmd)).map((c) => c.cmd);

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
                  `（空转命令 / 单行过载 / 结构残缺 / 交互式 / dump 二进制），已强制结束。` +
                  `进度已保留，请把目标描述得更具体后再次点「开始接管」。`,
                goal: "",
              });
              return;
            }
            // 拒绝原因必须分开说 —— 旧文案一律说「空转命令」，但「一行里塞太多子命令」
            // 是完全不同的病：模型会以为自己发的是合法命令，于是反复重发同一条。
            const reasons: string[] = [];
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
            if (r.kind === "exact") return `\`${cmd}\`：本次任务中已成功执行过，结果已知`;
            const sib = r.siblings.filter((s) => s !== normCmd(cmd));
            const sibText = sib.length > 0 ? sib.map((s) => `\`${s}\``).join("、") : "同目标的其它写法";
            return `\`${cmd}\`：与已成功执行过的 ${sibText} 是**同一目标的同类查询**（只换了参数写法），结果不会变`;
          };
          if (runnable.length === 0) {
            // 全轮都是重复命令 → 拒绝本轮。**把它此前拿到的输出片段一并回填**，
            // 这样它不必为了「再看一眼」再多花一轮往返。
            const backfill = droppedDup
              .map((c) => {
                const d = dupTracker.lastDigest(c);
                return d ? `\n- \`${c}\` 此前输出：${d}` : `\n- \`${c}\``;
              })
              .join("");
            const reasons = droppedDup.map((c) => `- ${whyOf(c)}`).join("\n");
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
                  `${executedLog.slice(-12).join("\n")}\n\n` +
                  `如需继续，请把下一步说清楚（或直接指出卡在哪），再点「开始接管」。`,
                goal: "",
              });
              return;
            }
            messages.push({
              role: "user",
              content:
                `[系统] 本轮命令已拒绝执行，避免重复消耗。原因：\n${reasons}\n` +
                `以下是它们此前的输出片段：${backfill}\n` +
                `**请直接采用这些结果继续推进**；若确实需要新信息，请换**不同目标或不同维度**的命令` +
                `（换目标路径、换观察角度），而不是换参数写法重看同一处；` +
                `若信息已足够，请用 <<<DONE>>> 给出总结。`,
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
            const decision = await requestConfirm(
              sessionId,
              stepId,
              commandsToRun[0],
              reviewsToRun[0]
            );
            if (decision === "abort") {
              updateStepItem(sessionId, stepId, 0, { status: "skipped", error: "用户终止" });
              updateStep(sessionId, stepId, { status: "skipped", finishedAt: Date.now() });
              patchBucket(sessionId, { phase: "stopped", error: "已终止任务，该命令未执行" });
              return;
            }
            if (decision === "skip") {
              updateStepItem(sessionId, stepId, 0, { status: "skipped", error: "用户跳过" });
              updateStep(sessionId, stepId, { status: "skipped", finishedAt: Date.now() });
              executedLog.push(logLine("⊘", commandsToRun[0]));
            messages.push({
              role: "user",
              content: `[系统] 命令 \`${commandsToRun[0]}\` 被用户跳过，未执行。请换用更安全的只读方式继续，或信息足够时用 <<<DONE>>> 给出结论。`,
            });
            hardTrim();
            continue;
            }
          }

          updateStep(sessionId, stepId, { status: "running", startedAt: Date.now() });

          if (canBatch) {
            // 批量只读探测：串行跑完所有命令，一次性回传，省掉多次 AI 往返
            const results = await execCommandBatch(sessionId, commandsToRun, {
              timeoutMs,
              maxTimeoutMs,
              signal: abort.signal,
              onItemStart: (i) => updateStepItem(sessionId, stepId, i, { status: "running" }),
              onItemOutput: (i, out) => updateStepItem(sessionId, stepId, i, { output: capLive(out) }),
              onItemDone: (i, res) =>
                updateStepItem(sessionId, stepId, i, {
                  status: isOk(res) ? "done" : "failed",
                  output: capOutput(res.output),
                  exitCode: res.exitCode,
                  timedOut: res.timedOut,
                  error: res.error,
                }),
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
            messages.push({
              role: "user",
              content:
                buildObservation(entries, OBSERVATION_MAX_CHARS, goal) +
                floodedNote +
                probeNote +
                (probeNote ? "" : failTreadmill.note()),
            });
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
          executedLog.push(logLine(res.timedOut ? "⏱" : isOk(res) ? "✓" : "✗", command, res.output));
          dupTracker.record(command, isOk(res) && !res.timedOut, res.output);
          recordProbe(command, res);
          failTreadmill.observe(res.output ?? "", isOk(res) && !res.timedOut);
          updateStep(sessionId, stepId, {
            status: isOk(res) ? "done" : "failed",
            finishedAt: Date.now(),
          });
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
          messages.push({
            role: "user",
            content:
              buildObservation([{ command, result: res }], OBSERVATION_MAX_CHARS, goal) +
              partialNote +
              floodedNote +
              probeNote +
              (probeNote ? "" : failTreadmill.note()),
          });
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
  const bucket = useAgentStore((s) => (key ? s.buckets[key] : undefined)) ?? EMPTY_BUCKET;
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
    liveThought: bucket.liveThought,
    plan: bucket.plan,
    metrics: bucket.metrics,
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
