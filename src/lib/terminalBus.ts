// =====================================================
// 终端输出广播总线
// -----------------------------------------------------
// XTerminal 收到 PTY/SSH 数据时，除了写入 store 的 recentOutput
// （该数组会被裁剪到最近 200 行，不适合做长任务的输出采集），
// 还会往这里广播一份「已清理 ANSI 的原始增量」。
//
// Agent 模式依赖它来可靠捕获每一步命令的输出：先订阅，再执行命令，
// 收到哨兵结束标记后停止收集。这样即使输出超过 200 行也不会丢。
// =====================================================

export type TerminalOutputListener = (sessionId: string, data: string) => void;

const listeners = new Set<TerminalOutputListener>();

/** XTerminal 内部调用：广播某个会话的增量输出（已清理 ANSI 控制符） */
export function emitTerminalOutput(sessionId: string, data: string): void {
  if (!data) return;
  listeners.forEach((listener) => {
    try {
      listener(sessionId, data);
    } catch (e) {
      // 单个订阅者异常不能影响终端主流程
      console.error("[terminalBus] 订阅者处理输出时出错:", e);
    }
  });
}

/** 订阅终端输出，返回取消订阅函数 */
export function subscribeTerminalOutput(listener: TerminalOutputListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
