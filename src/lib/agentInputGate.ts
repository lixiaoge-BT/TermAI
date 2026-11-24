// =====================================================
// AI 接管期间的终端键盘闸门（纯函数）
// -----------------------------------------------------
// 为什么需要：Agent 与用户共用**同一个 PTY**，两边写进去的字节走同一条 stdin 流。
// 接管期间用户敲的半行、AI 下发的 `cmd\r` 会被 shell 当成一条命令行，
// 拼成 `半行cmd` 一起执行 —— 半条命令、参数被改、误执行，界面上都看不出来。
//
// 判据必须覆盖**整段接管**（含 LLM 思考、等待确认），不能只看「正在执行命令」：
// 思考期间终端看似空闲，用户敲的字会留在 shell 的行缓冲里，等下一条命令写进来
// 就粘在一起了。这也是最容易漏的一段。
// =====================================================

export type AgentPhaseLike =
  | "idle"
  | "running"
  | "awaiting-confirm"
  | "done"
  | "stopped"
  | "error"
  | undefined;

/**
 * 该阶段是否由引擎独占终端输入。
 *
 * 只有 `running` / `awaiting-confirm` 算独占；`done` / `stopped` / `error` / `idle`
 * 必须立刻放行 —— 否则一次异常退出会让键盘永久失效，那比拼坏命令更糟。
 */
export function isAgentHoldingInput(phase: AgentPhaseLike): boolean {
  return phase === "running" || phase === "awaiting-confirm";
}

/**
 * 被闸门吞掉的按键里，哪些仍要放行：Ctrl+C（\x03）。
 * 用户遇到「AI 卡住」的第一反应就是按 Ctrl+C，这里直接把它转成「停止任务」，
 * 而不是让它去杀当前命令（杀了命令、任务还在跑，反而更让人困惑）。
 */
export function isStopShortcut(data: string): boolean {
  return data === "\x03";
}
