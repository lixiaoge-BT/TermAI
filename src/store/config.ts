import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { HostConfig, AIProviderConfig } from "@/types";
import { secureStorage } from "@/lib/secureStorage";
import { parseHostsBackup, type HostsBackup } from "./configImport";

interface AppConfigState {
  hosts: HostConfig[];
  hostGroups: string[];
  aiConfig: AIProviderConfig;
  theme: "dark" | "light" | "system";
  hostFormOpen: boolean;
  fileTransferHostId: string | null;
  forwardHostId: string | null;

  addHost: (host: Omit<HostConfig, "id" | "createdAt" | "updatedAt">) => HostConfig;
  updateHost: (id: string, patch: Partial<HostConfig>) => void;
  removeHost: (id: string) => void;
  getHost: (id: string) => HostConfig | undefined;
  addHostGroup: (name: string) => void;
  removeHostGroup: (name: string) => void;

  updateAIConfig: (patch: Partial<AIProviderConfig>) => void;
  setTheme: (theme: "dark" | "light" | "system") => void;
  setHostFormOpen: (open: boolean) => void;
  openFileTransfer: (hostId: string) => void;
  closeFileTransfer: () => void;
  openForward: (hostId: string) => void;
  closeForward: () => void;

  /** 导出全部主机与分组为 JSON 文本（明文，含凭据，供换机迁移） */
  exportHosts: () => string;
  /** 导入主机备份 JSON，按 id 合并（已存在则更新）。返回新增/更新计数 */
  importHosts: (json: string) => { added: number; updated: number; groups: number };
}

const defaultAIConfig: AIProviderConfig = {
  provider: "openai",
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  temperature: 0.3,
  maxTokens: 2048,
  autoAnalyze: false,
};

export const useAppConfig = create<AppConfigState>()(
  persist(
    (set, get) => ({
      hosts: [],
      hostGroups: [],
      aiConfig: defaultAIConfig,
      theme: "light",
      hostFormOpen: false,
      fileTransferHostId: null,
      forwardHostId: null,

      addHost: (host) => {
        const now = Date.now();
        const newHost: HostConfig = {
          ...host,
          id: `host_${now}_${Math.random().toString(36).slice(2, 8)}`,
          createdAt: now,
          updatedAt: now,
        };
        set({ hosts: [newHost, ...get().hosts] });
        return newHost;
      },
      updateHost: (id, patch) => {
        set({
          hosts: get().hosts.map((h) =>
            h.id === id ? { ...h, ...patch, updatedAt: Date.now() } : h
          ),
        });
      },
      removeHost: (id) => {
        set({ hosts: get().hosts.filter((h) => h.id !== id) });
      },
      getHost: (id) => get().hosts.find((h) => h.id === id),
      addHostGroup: (name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const prev = get().hostGroups;
        if (prev.includes(trimmed)) return;
        set({ hostGroups: [...prev, trimmed] });
      },
      removeHostGroup: (name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        // 同时从 hostGroups 中移除，并把该分组下的主机移入「未分组」
        set({
          hostGroups: get().hostGroups.filter((g) => g !== trimmed),
          hosts: get().hosts.map((h) =>
            (h.group || "").trim() === trimmed
              ? { ...h, group: "", updatedAt: Date.now() }
              : h
          ),
        });
      },

      updateAIConfig: (patch) => {
        set({ aiConfig: { ...get().aiConfig, ...patch } });
      },
      setTheme: (theme) => {
        set({ theme });
      },
      setHostFormOpen: (open) => {
        set({ hostFormOpen: open });
      },
      openFileTransfer: (hostId) => {
        set({ fileTransferHostId: hostId });
      },
      closeFileTransfer: () => {
        set({ fileTransferHostId: null });
      },
      openForward: (hostId) => {
        set({ forwardHostId: hostId });
      },
      closeForward: () => {
        set({ forwardHostId: null });
      },

      exportHosts: () => {
        const { hosts, hostGroups } = get();
        const backup: HostsBackup = {
          version: 1,
          exportedAt: Date.now(),
          hosts,
          hostGroups,
        };
        return JSON.stringify(backup, null, 2);
      },
      importHosts: (json: string) => {
        const parsed = parseHostsBackup(json);
        const existing = get().hosts;
        const existingById = new Map(existing.map((h) => [h.id, h]));
        let added = 0;
        let updated = 0;
        const merged: HostConfig[] = [...existing];
        for (const h of parsed.hosts) {
          if (existingById.has(h.id)) {
            const idx = merged.findIndex((m) => m.id === h.id);
            if (idx >= 0) {
              merged[idx] = { ...existingById.get(h.id)!, ...h, updatedAt: Date.now() };
            }
            updated++;
          } else {
            merged.unshift(h);
            added++;
          }
        }
        const groups = new Set<string>([...get().hostGroups, ...parsed.hostGroups]);
        set({ hosts: merged, hostGroups: [...groups] });
        return { added, updated, groups: parsed.hostGroups.length };
      },
    }),
    {
      name: "termai-config-v1",
      // 用加密存储：hosts 里的 password/privateKey/passphrase 与 aiConfig.apiKey
      // 都以密文落盘，而非明文 JSON。
      storage: createJSONStorage(() => secureStorage),
      partialize: (state) => ({
        hosts: state.hosts,
        hostGroups: state.hostGroups,
        aiConfig: state.aiConfig,
        theme: state.theme,
      }),
    }
  )
);
