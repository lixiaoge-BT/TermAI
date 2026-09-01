import { useTerminalStore } from "@/store/terminal";
import type { SshConnectParams } from "@/types";

// 全局终端实例表：sessionId -> 取当前 xterm 实例的函数。
// 让「AI 命令执行 / SSH 连接回调」写入正确的终端（多标签场景下不会串台）。
const termRefsBySession = new Map<string, () => import("xterm").Terminal | null>();

export function registerTerminalInstance(
  sessionId: string,
  getTerm: () => import("xterm").Terminal | null
) {
  termRefsBySession.set(sessionId, getTerm);
}

export function unregisterTerminalInstance(sessionId: string) {
  termRefsBySession.delete(sessionId);
}

/** 取某个会话当前的 xterm 实例（录制时需要读真实 cols/rows 写入尺寸信息） */
export function getTerminalInstance(sessionId: string): import("xterm").Terminal | null {
  return termRefsBySession.get(sessionId)?.() ?? null;
}

// 全局单例桥：供 AI 命令下发 / 快捷连接使用。
// 原先散落在 XTerminal 组件的 effect 里、且每个实例各自注册会相互覆盖
// （多标签时后者覆盖前者，本地命令被错误送到 ssh 通道）。这里集中注册一次，
// 按 store 中的 session 判断本地/SSH，保证命令路由正确。
export function initTerminalBridge() {
  const w = window as unknown as {
    __termai_writeTerminal?: (sid: string, data: string) => Promise<boolean>;
    __termai_connect?: (sid: string, params: SshConnectParams) => Promise<void>;
  };

  if (!w.__termai_writeTerminal) {
    w.__termai_writeTerminal = async (sid: string, data: string) => {
      const st = useTerminalStore.getState().sessions.find((x) => x.id === sid);
      if (!st) return false;
      // 本地终端（hostId 为空）走 localTerminal；其余视为 SSH 会话走 ssh 通道
      const isLocal = !st.hostId;
      try {
        if (isLocal) {
          return (await window.localTerminal?.write(sid, data)) ?? false;
        }
        return (await window.ssh?.write(sid, data)) ?? false;
      } catch (e) {
        console.error("[__termai_writeTerminal] 写入失败:", e);
        return false;
      }
    };
  }

  if (!w.__termai_connect) {
    w.__termai_connect = async (sid: string, params: SshConnectParams) => {
      const term = termRefsBySession.get(sid)?.() ?? null;
      const { updateSession } = useTerminalStore.getState();
      if (!window.ssh) {
        term?.writeln("\x1b[1;31m❌ SSH 桥接未加载！window.ssh 未定义。\x1b[0m");
        return;
      }
      updateSession(sid, { status: "connecting" });
      term?.writeln(`\x1b[1;34m正在连接 ${params.username}@${params.host}:${params.port} ...\x1b[0m`);
      term?.focus();
      try {
        // 建 shell 时就带上 xterm 的真实尺寸，远端 PTY 就不会先跑在 80x24 再纠正
        await window.ssh.connect(sid, {
          ...params,
          cols: term?.cols,
          rows: term?.rows,
        });
      } catch (e) {
        term?.writeln(`\x1b[1;31m连接失败：${(e as Error).message}\x1b[0m`);
        updateSession(sid, {
          status: "error",
          connected: false,
          errorMsg: (e as Error).message,
        });
      }
    };
  }
}
