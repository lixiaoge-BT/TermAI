import type { StateStorage } from "zustand/middleware";

// 渲染进程侧的「加密存储」：把持久化状态通过 preload 交给主进程的
// Electron safeStorage 做静态加密后再写入 localStorage。
// 这样 SSH 密码 / 私钥 / API Key 等凭据不会以明文落盘。
//
// 退化策略：若主进程加密不可用（部分 Linux 缺少 libsecret 等），
// 主进程会直接返回明文，这里照常写入 —— 保证功能不崩，只是不加密。
export const secureStorage: StateStorage = {
  getItem: async (name) => {
    const raw = localStorage.getItem(name);
    if (raw == null) return null;
    try {
      return await window.secureStorage.decrypt(raw);
    } catch {
      return raw;
    }
  },
  setItem: async (name, value) => {
    try {
      const out = await window.secureStorage.encrypt(value);
      localStorage.setItem(name, out);
    } catch {
      localStorage.setItem(name, value);
    }
  },
  removeItem: (name) => {
    localStorage.removeItem(name);
  },
};
