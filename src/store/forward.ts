import { create } from "zustand";
import type { SshForwardStatus, SshForwardConfig, SshForwardType } from "@/types";

interface ForwardState {
  // 按 sessionId 维护当前活动转发状态
  statuses: Record<string, SshForwardStatus[]>;
  initialized: boolean;
  init: () => void;
  refresh: (sessionId: string) => Promise<void>;
  start: (sessionId: string, cfg: SshForwardConfig) => Promise<void>;
  stop: (sessionId: string, id: string) => Promise<void>;
  // 连接建立后恢复 host 中 enabled 的转发
  restore: (sessionId: string, forwards: SshForwardConfig[]) => Promise<void>;
}

function specFromConfig(cfg: SshForwardConfig) {
  return {
    id: cfg.id,
    type: cfg.type as SshForwardType,
    localAddress: cfg.localAddress,
    localPort: cfg.localPort,
    remoteAddress: cfg.remoteAddress,
    remotePort: cfg.remotePort,
  };
}

export const useForwardStore = create<ForwardState>()((set, get) => ({
  statuses: {},
  initialized: false,

  init: () => {
    if (get().initialized) return;
    const w = window as unknown as {
      ssh?: {
        onForward?: (cb: (sid: string, status: SshForwardStatus) => void) => () => void;
      };
    };
    if (!w.ssh?.onForward) return;
    w.ssh.onForward((sessionId, status) => {
      set((s) => {
        const list = s.statuses[sessionId] ? [...s.statuses[sessionId]] : [];
        const idx = list.findIndex((x) => x.id === status.id);
        if (idx >= 0) list[idx] = status;
        else list.push(status);
        return { statuses: { ...s.statuses, [sessionId]: list } };
      });
    });
    set({ initialized: true });
  },

  refresh: async (sessionId) => {
    const w = window as unknown as { ssh?: { listForwards?: (sid: string) => Promise<SshForwardStatus[]> } };
    if (!w.ssh?.listForwards) return;
    const list = await w.ssh.listForwards(sessionId);
    set((s) => ({ statuses: { ...s.statuses, [sessionId]: list } }));
  },

  start: async (sessionId, cfg) => {
    const w = window as unknown as {
      ssh?: {
        forwardLocal?: (sid: string, spec: unknown) => Promise<SshForwardStatus>;
        forwardRemote?: (sid: string, spec: unknown) => Promise<SshForwardStatus>;
        forwardDynamic?: (sid: string, spec: unknown) => Promise<SshForwardStatus>;
      };
    };
    const spec = specFromConfig(cfg);
    try {
      if (cfg.type === "local") await w.ssh?.forwardLocal?.(sessionId, spec);
      else if (cfg.type === "remote") await w.ssh?.forwardRemote?.(sessionId, spec);
      else await w.ssh?.forwardDynamic?.(sessionId, spec);
    } catch {
      // 错误会经由 ssh:forward 事件以 error 状态回传，这里仅忽略异常
    }
    await get().refresh(sessionId);
  },

  stop: async (sessionId, id) => {
    const w = window as unknown as { ssh?: { cancelForward?: (sid: string, id: string) => Promise<boolean> } };
    await w.ssh?.cancelForward?.(sessionId, id);
    await get().refresh(sessionId);
  },

  restore: async (sessionId, forwards) => {
    for (const cfg of forwards) {
      if (cfg.enabled) await get().start(sessionId, cfg);
    }
  },
}));
