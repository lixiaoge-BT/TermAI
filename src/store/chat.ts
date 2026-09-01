import { create } from "zustand";
import type { AIMessage } from "@/types";

// 每个终端标签页（session）拥有独立的 AI 对话，切换标签页时对话随之切换。
// 没有可用会话（例如尚未创建标签页）时统一落到这个 key。
export const GLOBAL_CHAT_KEY = "__global__";

export interface ChatBucket {
  messages: AIMessage[];
  isLoading: boolean;
  error: string | null;
}

const EMPTY_BUCKET: ChatBucket = { messages: [], isLoading: false, error: null };

interface ChatState {
  buckets: Record<string, ChatBucket>;

  addMessage: (key: string, msg: Omit<AIMessage, "id" | "timestamp">) => AIMessage;
  removeMessage: (key: string, id: string) => void;
  updateMessage: (key: string, id: string, patch: Partial<AIMessage>) => void;
  setLoading: (key: string, loading: boolean) => void;
  setError: (key: string, err: string | null) => void;
  clearMessages: (key: string) => void;
  removeBucket: (key: string) => void;
}

export const useChatStore = create<ChatState>((set) => {
  /** 更新（不存在则创建） */
  const write = (key: string, updater: (b: ChatBucket) => ChatBucket) => {
    set((s) => ({
      buckets: { ...s.buckets, [key]: updater(s.buckets[key] ?? EMPTY_BUCKET) },
    }));
  };

  return {
    buckets: {},

    addMessage: (key, msg) => {
      const newMsg: AIMessage = {
        ...msg,
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
      };
      write(key, (b) => ({ ...b, messages: [...b.messages, newMsg] }));
      return newMsg;
    },

    removeMessage: (key, id) => {
      write(key, (b) => ({ ...b, messages: b.messages.filter((m) => m.id !== id) }));
    },

    updateMessage: (key, id, patch) => {
      write(key, (b) => ({
        ...b,
        messages: b.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      }));
    },

    setLoading: (key, loading) => write(key, (b) => ({ ...b, isLoading: loading })),
    setError: (key, err) => write(key, (b) => ({ ...b, error: err })),
    clearMessages: (key) => write(key, (b) => ({ ...b, messages: [], error: null })),
    removeBucket: (key) =>
      set((s) => {
        if (!s.buckets[key]) return s;
        const next = { ...s.buckets };
        delete next[key];
        return { buckets: next };
      }),
  };
});

/**
 * 便捷 hook：拿到某个终端会话的对话数据与操作方法。
 * 会话不存在时返回稳定的空桶（引用不变，不会触发额外渲染）。
 */
export function useSessionChat(sessionId?: string | null) {
  const key = sessionId || GLOBAL_CHAT_KEY;
  const bucket = useChatStore((s) => s.buckets[key]) ?? EMPTY_BUCKET;
  const addMessage = useChatStore((s) => s.addMessage);
  const updateMessage = useChatStore((s) => s.updateMessage);
  const setLoading = useChatStore((s) => s.setLoading);
  const setError = useChatStore((s) => s.setError);
  const clearMessages = useChatStore((s) => s.clearMessages);

  return {
    key,
    messages: bucket.messages,
    isLoading: bucket.isLoading,
    error: bucket.error,
    addMessage: (msg: Omit<AIMessage, "id" | "timestamp">) => addMessage(key, msg),
    updateMessage: (id: string, patch: Partial<AIMessage>) => updateMessage(key, id, patch),
    setLoading: (loading: boolean) => setLoading(key, loading),
    setError: (err: string | null) => setError(key, err),
    clearMessages: () => clearMessages(key),
  };
}

/** 非 hook 场景（事件监听器等）读取当前会话 key */
export function currentChatKey(sessionId?: string | null): string {
  return sessionId || GLOBAL_CHAT_KEY;
}
