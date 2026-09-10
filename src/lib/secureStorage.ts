import type { StateStorage } from "zustand/middleware";

// 渲染进程侧的「加密存储」：把持久化状态通过 preload 交给主进程的
// Electron safeStorage 做静态加密后再写入 localStorage。
// 这样 SSH 密码 / 私钥 / API Key 等凭据不会以明文落盘。
//
// 退化策略：若主进程加密不可用（部分 Linux 缺少 libsecret 等），
// 主进程会直接返回明文，这里照常写入 —— 保证功能不崩，只是不加密。

/**
 * 已经成功读过一次的 key 集合。
 *
 * 存在的意义：zustand persist 的 setState 包装是 `savedSetState(...); return setItem();`
 * —— **没有任何 hasHydrated 守卫**，且 hydrate() 失败只会被 `.catch` 静默吞掉。
 * 于是当 getItem 抛异常时（localStorage 被企业策略禁用 / 隐私模式 / 配额异常），
 * 水合失败、store 停在初始空状态（hosts: []），之后任意一次 set（哪怕只是
 * 打开主机表单）都会把空状态写回磁盘 —— 主机清单和 API Key 就这么没了。
 *
 * 只有**确认本次会话成功读过**该 key，才允许写回。读不到时宁可本次不持久化，
 * 也要保住磁盘上的原始数据。
 */
const readableKeys = new Set<string>();

/** 仅供测试：清空「已成功读取」记录 */
export function __resetReadableKeysForTest(): void {
  readableKeys.clear();
}

export const secureStorage: StateStorage = {
  getItem: async (name) => {
    let raw: string | null;
    try {
      raw = localStorage.getItem(name);
    } catch {
      // 存储不可用：返回 null 让水合走默认值，同时**不**登记为可读，
      // 从而阻止后续 setItem 把空状态覆盖到磁盘。
      return null;
    }
    // 同步读取成功 ⇒ 存储可用，放行后续写入
    readableKeys.add(name);
    if (raw == null) return null;
    try {
      return await window.secureStorage.decrypt(raw);
    } catch {
      return raw;
    }
  },
  setItem: async (name, value) => {
    if (!readableKeys.has(name)) return;
    let payload = value;
    try {
      payload = await window.secureStorage.encrypt(value);
    } catch {
      /* 主进程加密不可用 → 退化为明文写入，保证功能不崩 */
    }
    try {
      localStorage.setItem(name, payload);
    } catch {
      /* 写入失败（配额满 / 被禁用）时静默放弃：异常绝不能冒泡到 zustand，
         否则一次 setState 就会连带让 UI 操作失败 */
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      /* 同上 */
    }
  },
};
