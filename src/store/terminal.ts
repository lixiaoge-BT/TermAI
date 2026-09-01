import { create } from "zustand";
import type { TerminalSessionState } from "@/types";

interface TerminalState {
  sessions: TerminalSessionState[];
  activeSessionId: string | null;

  createSession: (
    session: Omit<TerminalSessionState, "id" | "history" | "recentOutput" | "connected" | "status">
  ) => TerminalSessionState;
  removeSession: (id: string) => void;
  setActiveSession: (id: string) => void;
  updateSession: (id: string, patch: Partial<TerminalSessionState>) => void;

  appendOutput: (id: string, line: string, maxLines?: number) => void;
  appendCommand: (id: string, command: string) => void;

  getActiveSession: () => TerminalSessionState | null;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: [],
  activeSessionId: null,

  createSession: (session) => {
    const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const newSession: TerminalSessionState = {
      ...session,
      id,
      connected: false,
      status: "idle",
      history: [],
      recentOutput: [],
    };
    set({ sessions: [...get().sessions, newSession], activeSessionId: id });
    return newSession;
  },

  removeSession: (id) => {
    const sessions = get().sessions.filter((s) => s.id !== id);
    const activeId = get().activeSessionId === id
      ? sessions[sessions.length - 1]?.id ?? null
      : get().activeSessionId;
    set({ sessions, activeSessionId: activeId });
  },

  setActiveSession: (id) => set({ activeSessionId: id }),

  updateSession: (id, patch) => {
    set({
      sessions: get().sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  },

  appendOutput: (id, line, maxLines = 100) => {
    set({
      sessions: get().sessions.map((s) => {
        if (s.id !== id) return s;
        const lines = line.split(/\r?\n/);
        const newOutput = [...s.recentOutput, ...lines];
        const trimmed = newOutput.length > maxLines ? newOutput.slice(-maxLines) : newOutput;
        return { ...s, recentOutput: trimmed };
      }),
    });
  },

  appendCommand: (id, command) => {
    set({
      sessions: get().sessions.map((s) => {
        if (s.id !== id) return s;
        // 命令历史保留最近 50 条
        const history = [...s.history, command].slice(-50);
        if (s.connected) {
          // 已连接：远端/本地 shell 会自行回显命令，recentOutput 已由 appendOutput 收录，
          // 这里不再重复注入 `$ cmd`，避免 AI 上下文里同一条命令出现两遍。
          return { ...s, history };
        }
        // 离线/AI 提示模式：没有 shell 回显，手动把命令写入上下文流，保证命令→输出对应。
        const recentOutput = [...s.recentOutput, `$ ${command}`].slice(-100);
        return { ...s, history, recentOutput };
      }),
    });
  },

  getActiveSession: () => {
    const id = get().activeSessionId;
    return id ? get().sessions.find((s) => s.id === id) ?? null : null;
  },
}));
