import { create } from "zustand";
import type { RiskLevel } from "@/services/safety";
import { reviewCommand } from "@/services/safety";
import { chatCompletionRaw } from "@/services/ai";
import { buildAgentSystemPrompt } from "@/services/prompts";
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
};

interface AgentState {
  buckets: Record<string, AgentBucket>;
  /** 中风险命令自动执行（none/low 始终自动；high/critical 始终确认） */
  autoRunMedium: boolean;
  /** 单条命令的基础超时（超时后若仍在持续输出会自动延长） */
  commandTimeoutMs: number;
  /** 单条命令的硬超时上限 */
  commandMaxTimeoutMs: number;

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
    commandTimeoutMs: 20000,
    commandMaxTimeoutMs: 60000,
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
      patchBucket(sessionId, {
        phase: "running",
        steps: [],
        summary: "",
        error: null,
        pendingConfirm: null,
        liveThought: "",
        submittedGoal: goal,
      });

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

      const timeoutMs = get().commandTimeoutMs;
      const maxTimeoutMs = get().commandMaxTimeoutMs;

      // 整体任务超时兜底：模型若不收敛（一直给命令不出 <<<DONE>>>），
      // 单靠「停止」按钮不够，这里 5 分钟强制终止，避免任务无限空跑。
      const TASK_TIMEOUT_MS = 5 * 60 * 1000;
      const taskStartedAt = Date.now();
      // 上下文上限：多步任务每轮都回传完整观察，messages 会越来越长，
      // 超过阈值后只保留 system + 最近若干轮，避免 token 线性膨胀、越来越慢越来越贵。
      const MAX_AGENT_MESSAGES = 22;
      const messages: ChatMessage[] = messagesInit;

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
      const COMPRESS_TRIGGER = 18;
      const MAX_CONTEXT_TOKENS = 40000;
      const KEEP_RECENT = 8;

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
            patchBucket(sessionId, { phase: "error", error: "任务执行超时（5 分钟），已自动终止" });
            return;
          }

          // 上下文逼近上限时先压缩旧消息，保留关键信息再进入下一轮
          await maybeCompress();

          // 流式调用：逐 token 累积到 replyText，并节流刷新 liveThought 供 UI 实时展示
          let replyText = "";
          let lastFlush = 0;
          const updateLive = () => {
            const now = Date.now();
            if (now - lastFlush >= 60) {
              lastFlush = now;
              patchBucket(sessionId, { liveThought: replyText });
            }
          };
          try {
            replyText = await chatCompletionRaw({
              config: aiConfig,
              messages,
              signal: abort.signal,
              onToken: (delta) => {
                replyText += delta;
                updateLive();
              },
            });
          } finally {
            // 确保最终完整文本落盘，避免节流导致末尾几字丢失
            patchBucket(sessionId, { liveThought: replyText });
          }
          messages.push({ role: "assistant", content: replyText });
          hardTrim();
          // 本轮模型回复已消费（转为步骤/总结），清掉流式预览，避免与步骤重叠
          patchBucket(sessionId, { liveThought: "" });

          const parsed = parseAgentReply(replyText);
          if (parsed.done) {
            // 任务正常完成：清空输入框，方便直接提下一个目标
            patchBucket(sessionId, { phase: "done", summary: parsed.finalAnswer ?? replyText, goal: "" });
            return;
          }
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

          const commandsToRun = canBatch ? parsed.commands : [parsed.commands[0]];
          const reviewsToRun = canBatch ? reviews : [reviews[0]];

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
              onItemOutput: (i, out) => updateStepItem(sessionId, stepId, i, { output: out }),
              onItemDone: (i, res) =>
                updateStepItem(sessionId, stepId, i, {
                  status: isOk(res) ? "done" : "failed",
                  output: res.output,
                  exitCode: res.exitCode,
                  timedOut: res.timedOut,
                  error: res.error,
                }),
            });
            const entries = commandsToRun
              .slice(0, results.length)
              .map((c, i) => ({ command: c, result: results[i] }));
            updateStep(sessionId, stepId, { status: "done", finishedAt: Date.now() });
            messages.push({ role: "user", content: buildObservation(entries) });
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
              onOutput: (out) => updateStepItem(sessionId, stepId, 0, { output: out }),
            });
          } catch (e) {
            const msg = (e as Error)?.message ?? String(e);
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
            output: res.output,
            exitCode: res.exitCode,
            timedOut: res.timedOut,
            error: res.error,
          });
          updateStep(sessionId, stepId, {
            status: isOk(res) ? "done" : "failed",
            finishedAt: Date.now(),
          });
          // 若 AI 一次给了多条却含非只读命令，明确告知只执行了第一条，避免它下轮重复提交
          const partialNote =
            parsed.commands.length > 1
              ? `\n\n（注意：你这次共给出 ${parsed.commands.length} 条命令，其中含有非只读或需要确认的命令，系统只执行了第 1 条。其余命令请在确认上一条结果后单独给出。）`
              : "";
          messages.push({
            role: "user",
            content: buildObservation([{ command, result: res }]) + partialNote,
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
        patchBucket(sessionId, { pendingConfirm: null });
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
