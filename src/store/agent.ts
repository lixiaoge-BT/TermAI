import { create } from "zustand";
import type { AIProviderConfig } from "@/types";
import type { RiskLevel } from "@/services/safety";
import { reviewCommand, isBinaryDumpCommand } from "@/services/safety";
import { chatCompletionRaw, thinkingDisableExtra } from "@/services/ai";
import { buildAgentSystemPrompt, AGENT_MAX_BATCH_COMMANDS } from "@/services/prompts";
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
  execCommand,
  execCommandBatch,
  parseAgentReply,
  sanitizeOutput,
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

/** 退出码为 0 或没捕获到退出码（但也没抛异常）都算成功 */
function isOk(res: ExecResult): boolean {
  return !res.error && (res.exitCode === 0 || res.exitCode === null);
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
      // 单条命令观察的字符预算：默认 6000 太烧 token；长输出本来也只取关键错误行+尾部，
      // 3000 足够模型判断，超长部分靠 focusOutput 的「错误行聚焦」兜住。
      const OBSERVATION_MAX_CHARS = 3000;
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
          content: `${PLAN_PIN_PREFIX}\n${planText}\n（请对照此计划推进：已完成的子目标不要重复做，未完成的继续推进，全部完成后才用 <<<DONE>>> 结束。）`,
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
          for (const it of st.items) executedLog.push(`${itemIcon(it)} ${it.command}`);
        }
      }
      // 命令执行统计（去重执行用）：key 为归一化后的命令，value 为执行次数与最后一次是否成功。
      // 「重复执行同一条已成功的命令」是空转烧 token 的典型形态（模型忘了自己跑过什么，
      // 或陷入重试死循环）。已执行清单是软提示，这里是硬闸门。
      const execStats = new Map<string, { n: number; lastOk: boolean }>();
      const normalizeCmd = (cmd: string) => cmd.trim().replace(/\s+/g, " ");
      const recordExec = (cmd: string, ok: boolean) => {
        const key = normalizeCmd(cmd);
        const prev = execStats.get(key);
        execStats.set(key, { n: (prev?.n ?? 0) + 1, lastOk: ok });
      };
      const EXEC_LOG_PREFIX = "## 已执行过的命令清单（勿重复）";
      const syncExecLog = () => {
        if (executedLog.length === 0) return;
        // 只保留最近 30 条展示（防止清单本身养肥成新负担、每轮都吃 token）。
        // 注意：重复命令的硬闸门用的是 execStats（完整历史），不受此窗口影响——
        // 所以缩小展示窗口不会放过重复执行。
        const capped = executedLog.slice(-30);
        const content =
          `${EXEC_LOG_PREFIX}\n以下命令已在本次任务中真实执行过（✓ 成功 / ✗ 失败 / ⊘ 用户跳过 / ⏱ 超时被杀）：\n` +
          `${capped.join("\n")}\n` +
          `（除非明确需要复查同一项（须在思考里说明理由），严禁再次执行相同或等效命令；需要新信息请用新的命令获取。）`;
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

        try {
          const summary = await chatCompletionRaw({
            config: aiConfig,
            messages: buildCompressionMessages({
              goal,
              previousSummary,
              transcript: renderTranscript(toSummarize),
            }),
            signal: abort.signal,
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
          try {
            replyText = await chatCompletionRaw({
              config: agentConfig,
              messages,
              signal: abort.signal,
              onToken: (delta) => {
                replyText += delta;
                updateLive();
              },
              onMeta: (meta) => {
                if (meta.truncated) truncated = true;
              },
            });
          } catch (e) {
            // 瞬时空响应：复杂上下文下弱模型偶发空回复（不是配错模型）。
            // 配错模型（如 OCR/嵌入）两次都是空 → 重试仍空，抛上去给外层走原
            // 「请检查模型名」的报错。瞬时 provider 抖动 / 模型偶发空 → 重试命中。
            const msg = (e as Error)?.message ?? String(e);
            if (!msg.startsWith("模型未返回任何内容")) throw e;
            replyText = "";
            truncated = false;
            try {
              replyText = await chatCompletionRaw({
                config: agentConfig,
                messages,
                signal: abort.signal,
                onToken: (delta) => {
                  replyText += delta;
                  updateLive();
                },
                onMeta: (meta) => {
                  if (meta.truncated) truncated = true;
                },
              });
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
          const droppedInteractive = sliced
            .filter((c) => INTERACTIVE_CMD_RE.test(c.cmd))
            .map((c) => c.cmd);
          // dump 二进制：`cat 可执行文件` 会把上百 MB 乱码灌进 PTY（实测一步卡 320 秒、
          // 刷满整个终端、把后续所有输出淹掉）。必须在解析后硬拦，见 isBinaryDumpCommand。
          const droppedBinary = sliced.filter((c) => isBinaryDumpCommand(c.cmd)).map((c) => c.cmd);
          const picked = sliced.filter(
            (c) =>
              !LOW_VALUE_CMD_RE.test(c.cmd) &&
              !INTERACTIVE_CMD_RE.test(c.cmd) &&
              !isBinaryDumpCommand(c.cmd)
          );
          const droppedLowValue = sliced.filter((c) => LOW_VALUE_CMD_RE.test(c.cmd)).map((c) => c.cmd);

          if (picked.length === 0) {
            // 连续 3 轮全部是低价值命令：说明模型卡死在空转里且没听懂纠正，
            // 再喂系统消息也只是白烧 API 调用（这些轮不建 step、不耗步数预算，
            // 只有任务总超时兜底）。到点强制收尾，让人接手。
            lowValueStreak += 1;
            if (lowValueStreak >= 3) {
              patchBucket(sessionId, {
                phase: "done",
                summary:
                  `[任务未完成] 模型连续 ${lowValueStreak} 轮只给出无信息量的空转命令（清屏/echo 等），已强制结束。` +
                  `进度已保留，请把目标描述得更具体后再次点「开始接管」。`,
                goal: "",
              });
              return;
            }
            messages.push({
              role: "user",
              content:
                `[系统] 你给出的命令 \`${droppedLowValue.join("`、`")}\` 属于拿不到任何新信息的空转命令` +
                `（清屏 / echo 打标记 / 查历史 / 无参数 cat 等），已拒绝执行。\n` +
                (droppedInteractive.length > 0
                  ? `另外 \`${droppedInteractive.join("`、`")}\` 是交互式 / 会挂住终端的命令，已拒绝执行。` +
                    `看进程请用 \`ps aux --sort=-%cpu | head -20\`；看实时负载用 \`uptime\` 或 \`top -b -n 1 | head -20\`；长输出自带 \`| head -N\`。\n`
                  : ``) +
                (droppedBinary.length > 0
                  ? `另外 \`${droppedBinary.join("`、`")}\` 是在 dump 二进制/库/设备/私钥文件，已拒绝执行 —— ` +
                    `把一个可执行文件的二进制内容倒进终端会灌进上百 MB 乱码，刷满屏幕并让后续所有输出错位。\n` +
                    `要确认某个可执行文件是否装好、是什么东西，请用：\`file 路径\`、\`ls -la 路径\`、\`路径 --version\`（或 \`command -v 名字\`）。\n`
                  : ``) +
                `**请直接给出能推进目标的具体命令**（例如带明确对象与输出限制的查看、检测、安装命令）；` +
                `若信息已足够，请用 <<<DONE>>> 给出最终总结。`,
            });
            hardTrim();
            continue;
          }
          // 本轮确实有命令进入执行 → 清空空转计数（走到这里说明 picked.length > 0）
          lowValueStreak = 0;
          if (droppedOverflow > 0) {
            // 必须说清「为什么只跑了一条」。旧文案只报「只执行了前 N 条」，
            // 模型不知道真实原因（混了写命令 → 整批降级为单条），下一轮照旧把
            // 「只读探测 + 安装」混在一起提交，于是永远在探测、永远不安装。
            const blockedByWrite = !canBatch && allCandidates.length > 1;
            const reason = blockedByWrite
              ? `这批命令里混有写操作或需要确认的命令，出于安全本轮只执行了第 1 条 ` +
                `\`${sliced[0]?.cmd ?? ""}\`。**写命令（安装 / 改配置 / 启停服务）必须独占一轮单独发**，` +
                `不要和只读探测混在同一批；被挡下的只读探测可以留到下一轮再批量发。`
              : `本轮你一次提交了 ${allCandidates.length} 条命令，超过单轮上限，` +
                `只执行了前 ${picked.length} 条。`;
            messages.push({
              role: "user",
              content:
                `[系统] ${reason}\n` +
                (droppedInteractive.length > 0
                  ? `已额外拦掉交互式命令 \`${droppedInteractive.join("`、`")}\`（会卡住终端）；` +
                    `改用在前面提示过的非交互写法。\n`
                  : ``) +
                `请聚焦：每轮最多 ${MAX_BATCH_COMMANDS} 条，且只给与当前子目标直接相关的命令。`,
            });
          }

          const commandsToRun = picked.map((c) => c.cmd);
          const reviewsToRun = picked.map((c) => c.review);

          // 重复命令硬闸门：同一条命令已成功执行过 ≥2 次 → 拒绝再跑（不消耗执行与终端时间，
          // 也不再为它产生新的观察消息）。允许执行 1~2 次是给「启动后复查状态」留余量。
          const dupStat = execStats.get(normalizeCmd(commandsToRun[0]));
          if (dupStat && dupStat.n >= 2 && dupStat.lastOk) {
            messages.push({
              role: "user",
              content:
                `[系统] 命令 \`${commandsToRun[0]}\` 在本次任务中已成功执行过 ${dupStat.n} 次，` +
                `为避免重复消耗已拒绝再次执行。**请直接采用它此前的输出继续推进**；` +
                `若确实需要新信息，请换一条不同的命令；若信息已足够，请用 <<<DONE>>> 给出总结。`,
            });
            hardTrim();
            continue;
          }

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
              executedLog.push(`⊘ ${commandsToRun[0]}`);
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
              onItemOutput: (i, out) => updateStepItem(sessionId, stepId, i, { output: capOutput(out) }),
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
              recordExec(c, ok);
              executedLog.push(`${r ? (r.timedOut ? "⏱" : isOk(r) ? "✓" : "✗") : "?"} ${c}`);
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
            messages.push({
              role: "user",
              content: buildObservation(entries, OBSERVATION_MAX_CHARS, goal) + floodedNote,
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
              onOutput: (out) => updateStepItem(sessionId, stepId, 0, { output: capOutput(out) }),
            });
          } catch (e) {
            const msg = (e as Error)?.message ?? String(e);
            recordExec(command, false);
            executedLog.push(`✗ ${command}`);
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
          executedLog.push(`${res.timedOut ? "⏱" : isOk(res) ? "✓" : "✗"} ${command}`);
          recordExec(command, isOk(res) && !res.timedOut);
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
          messages.push({
            role: "user",
            content:
              buildObservation([{ command, result: res }], OBSERVATION_MAX_CHARS, goal) +
              partialNote +
              floodedNote,
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
