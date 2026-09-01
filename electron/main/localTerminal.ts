import { spawn, ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import type { BrowserWindow } from "electron";

// 统一抽象：无论底层是 PTY 还是回退的 spawn，对外暴露一致的 write/resize/kill。
interface TerminalBackend {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
}

export interface LocalTerminalSession {
  id: string;
  shell: string;
  backend: TerminalBackend;
  kind: "pty" | "pipe";
}

export interface LocalTerminalManager {
  create: (sessionId: string, shell?: string, cols?: number, rows?: number) => boolean;
  write: (sessionId: string, data: string) => boolean;
  resize: (sessionId: string, cols: number, rows: number) => boolean;
  dispose: (sessionId: string) => boolean;
  disposeAll: () => void;
}

// Electron ABI 与预编译二进制可能不匹配，运行时动态加载 node-pty，
// 失败则回退到 child_process.spawn，保证本地终端始终可用。
function loadPty(): Record<string, unknown> | null {
  try {
    const req = createRequire(import.meta.url);
    const mod = req("node-pty") as { spawn: (...args: unknown[]) => unknown };
    return mod && typeof mod.spawn === "function" ? mod : null;
  } catch {
    return null;
  }
}

const ptyModule = loadPty();

// 前端传来的尺寸做合法性收敛，避免 NaN / 0 / 超大值把 PTY 搞崩
function sanitizeSize(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function createLocalTerminalManager(win: BrowserWindow): LocalTerminalManager {
  const sessions = new Map<string, LocalTerminalSession>();

  const emit = (channel: string, ...args: unknown[]) => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  };

  const getDefaultShell = (): string => {
    if (process.platform === "win32") {
      return process.env.PWShell || process.env.COMSPEC || "powershell.exe";
    }
    return process.env.SHELL || "/bin/bash";
  };

  const getShellArgs = (shellPath: string, useLogin: boolean): string[] => {
    const lower = shellPath.toLowerCase();
    if (process.platform === "win32") {
      if (lower.includes("powershell") || lower.includes("pwsh")) {
        return ["-NoLogo", "-NoProfile"];
      }
      if (lower.includes("cmd")) return [];
      return [];
    }
    // POSIX：登录 shell 便于加载 profile（zsh/bash 等）
    return useLogin ? ["-l"] : [];
  };

  const getCwd = (): string =>
    process.env.HOME || process.env.USERPROFILE || process.cwd();

  const buildEnv = (): Record<string, string> => ({
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  }) as Record<string, string>;

  const create = (
    sessionId: string,
    shell?: string,
    colsParam?: number,
    rowsParam?: number
  ): boolean => {
    if (sessions.has(sessionId)) return false;

    const shellPath = shell || getDefaultShell();
    const cwd = getCwd();

    try {
      let backend: TerminalBackend;
      let kind: "pty" | "pipe";

      if (ptyModule) {
        kind = "pty";
        try {
          // 用前端 xterm 的真实尺寸启动，避免 PTY 停留在默认 80x24
          // （会导致长命令换行错位、历史命令重绘混乱）
          const cols = sanitizeSize(colsParam, 80, 1, 1000);
          const rows = sanitizeSize(rowsParam, 24, 1, 500);
          const pty = (
            ptyModule.spawn as (
              cmd: string,
              args: string[],
              opts: Record<string, unknown>
            ) => {
              on: (ev: string, cb: (...a: unknown[]) => void) => unknown;
              write: (d: string) => void;
              resize: (c: number, r: number) => void;
              kill: (sig?: string) => void;
            }
          )(shellPath, getShellArgs(shellPath, true), {
            name: "xterm-256color",
            cols,
            rows,
            cwd,
            env: buildEnv(),
          });

          backend = {
            write: (data) => pty.write(data),
            resize: (cols, rows) => {
              try {
                pty.resize(cols, rows);
              } catch {
                /* 尺寸调整失败时静默忽略 */
              }
            },
            kill: () => {
              try {
                pty.kill();
              } catch {
                /* ignore */
              }
            },
          };

          pty.on("data", (data: Buffer | string) => {
            emit("local-terminal:data", sessionId, data.toString("utf-8"));
          });
          pty.on("exit", (code?: number) => {
            emit("local-terminal:exit", sessionId, code ?? 0);
            sessions.delete(sessionId);
          });
        } catch (ptyErr) {
          // PTY 启动失败（权限/环境问题），降级为管道模式
          console.warn("[localTerminal] PTY 启动失败，回退到 pipe 模式:", ptyErr);
          kind = "pipe";
          backend = createPipeBackend(shellPath, sessionId, cwd);
        }
      } else {
        kind = "pipe";
        backend = createPipeBackend(shellPath, sessionId, cwd);
      }

      sessions.set(sessionId, { id: sessionId, shell: shellPath, backend, kind });
      emit("local-terminal:ready", sessionId);
      return true;
    } catch (err) {
      const msg = describeSpawnError(err);
      console.error("[localTerminal] 创建失败:", msg);
      emit("local-terminal:error", sessionId, msg);
      return false;
    }
  };

  const createPipeBackend = (
    shellPath: string,
    sessionId: string,
    cwd: string
  ): TerminalBackend => {
    const child: ChildProcess = spawn(shellPath, getShellArgs(shellPath, false), {
      cwd,
      env: buildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    if (child.stdout) {
      child.stdout.on("data", (data: Buffer) => {
        emit("local-terminal:data", sessionId, data.toString("utf-8"));
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        emit("local-terminal:data", sessionId, data.toString("utf-8"));
      });
    }
    child.on("exit", (code) => {
      emit("local-terminal:exit", sessionId, code ?? 0);
      sessions.delete(sessionId);
    });
    child.on("error", (err) => {
      emit("local-terminal:error", sessionId, describeSpawnError(err));
      sessions.delete(sessionId);
    });

    return {
      write: (data) => {
        try {
          child.stdin?.write(data);
        } catch {
          /* ignore */
        }
      },
      resize: () => {
        /* pipe 模式不支持动态 resize */
      },
      kill: () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      },
    };
  };

  const write = (sessionId: string, data: string): boolean => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    try {
      session.backend.write(data);
      return true;
    } catch {
      return false;
    }
  };

  const resize = (sessionId: string, cols: number, rows: number): boolean => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    try {
      session.backend.resize(cols, rows);
      return true;
    } catch {
      return false;
    }
  };

  const dispose = (sessionId: string): boolean => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    session.backend.kill();
    sessions.delete(sessionId);
    return true;
  };

  const disposeAll = () => {
    for (const session of sessions.values()) {
      try {
        session.backend.kill();
      } catch {
        /* ignore */
      }
    }
    sessions.clear();
  };

  return { create, write, resize, dispose, disposeAll };
}

// 把常见的 spawn / PTY 错误转换为中文可读信息
function describeSpawnError(err: unknown): string {
  const e = err as { code?: string; message?: string; path?: string };
  if (e?.code === "ENOENT") {
    return `无法启动 shell：${e.path ?? "未知路径"} 不存在，请检查 shell 路径是否正确。`;
  }
  if (e?.code === "EACCES") {
    return `启动 shell 被拒绝（权限不足）：${e.path ?? ""}`;
  }
  return e?.message || String(err);
}
