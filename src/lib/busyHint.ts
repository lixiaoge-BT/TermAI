import type { AgentBusyStage, AgentPhase } from "@/store/agent";

/**
 * 忙碌条的文案（纯函数，便于单测）。
 *
 * 背景：旧实现只有一句「AI 正在分析并执行...」，计时器又只在「步骤数变化」时清零，
 * 于是执行命令、压缩上下文、等待重连、只回计划不建步骤的轮次全被算进同一个数字，
 * 超过 60s 就统一提示「模型响应较慢」。用户看到的 63s 里，可能一秒都没花在模型上。
 *
 * 现在每个阶段有自己的文案与阈值，数字和标签必须能互相解释。
 */

/** 「等模型」多久算慢。45s 是常用推理模型在 15k prompt 下的合理上界，超过才值得提示。 */
export const THINK_SLOW_SEC = 45;
/** 「执行命令」多久算可疑（可能停在交互提问上）。 */
export const EXEC_SLOW_SEC = 120;
/** 「压缩上下文」的辅助请求超时是 30s，超过 20s 就该说明会自动跳过。 */
export const COMPRESS_SLOW_SEC = 20;

export interface BusyHint {
  /** spinner 旁边的主文案 */
  label: string;
  /** 秒数 / 补充说明；空串表示不显示 */
  hint: string;
  /** 是否用警示色（真有可能卡住，值得提示「可停止」） */
  warn: boolean;
}

const CONFIRM_HINT: BusyHint = { label: "等待你确认下一条命令…", hint: "", warn: false };

export function busyHint(
  stage: AgentBusyStage | undefined,
  phase: AgentPhase,
  sec: number
): BusyHint {
  // 确认态以 phase 为准：pendingConfirm 卡片已经出现，stage 可能还停在上一轮
  if (phase === "awaiting-confirm" || stage === "confirm") return CONFIRM_HINT;

  switch (stage) {
    case "exec":
      return {
        label: "正在执行命令…",
        hint: sec >= EXEC_SLOW_SEC ? "（可能在等待交互输入，可点停止）" : "",
        warn: sec >= EXEC_SLOW_SEC,
      };
    case "compress":
      return {
        label: "正在压缩上下文…",
        hint: sec >= COMPRESS_SLOW_SEC ? "（超时会自动跳过，不影响任务）" : "",
        warn: false,
      };
    case "reconnect":
      return {
        label: "连接断开，正在等待重连…",
        hint: "（最长等 25s）",
        warn: false,
      };
    case "thinking":
    case undefined:
    default:
      return {
        label: "AI 正在思考下一步…",
        hint: sec >= THINK_SLOW_SEC ? "（模型响应较慢，可点停止）" : "",
        warn: sec >= THINK_SLOW_SEC,
      };
  }
}
