import { create } from "zustand";
import {
  createLeaf,
  splitPane,
  closePane,
  setPaneSession,
  setRatio,
  mapLeaves,
  listLeaves,
  findLeaf,
  collapseToLeaf,
  type SplitNode,
  type SplitDirection,
  type SplitLeaf,
} from "@/lib/splitLayout";

interface LayoutState {
  root: SplitNode;
  focusedPaneId: string | null;

  focusPane: (paneId: string) => void;
  /** 在 paneId 处切一刀，newLeaf 成为新面板 */
  splitWith: (paneId: string, direction: SplitDirection, newLeaf: SplitLeaf) => void;
  /**
   * 取消分屏：把所有面板合并为一个，保留传入/聚焦/第一个面板作为唯一叶子。
   * 仅一个面板时 no-op。
   */
  mergeToSinglePane: (paneId?: string) => void;
  /** 关闭面板（最后一个面板不允许关闭） */
  closePaneById: (paneId: string) => void;
  setPaneSessionById: (paneId: string, sessionId: string | null) => void;
  setSplitRatio: (splitId: string, ratio: number) => void;
  /**
   * 会话（标签）变动后清理面板：
   * - 已不存在的会话置空
   * - 同一会话出现在多个面板时只保留一个（聚焦面板优先）
   * - 空面板优先用 fallback 顶替，没有 fallback 就关掉（但至少留一个面板）
   */
  pruneSessions: (aliveSessionIds: string[], fallback: string | null) => void;
  /** 保证该会话至少在一个面板里可见（否则塞进聚焦面板） */
  ensureVisible: (sessionId: string) => void;
  reset: () => void;
}

const initialLeaf = createLeaf(null);

/** 结构变更后校正聚焦面板：失效则回落到第一个面板 */
function withValidFocus(root: SplitNode, focusedPaneId: string | null) {
  const leaves = listLeaves(root);
  const valid = focusedPaneId && leaves.some((l) => l.id === focusedPaneId);
  return { root, focusedPaneId: valid ? focusedPaneId : (leaves[0]?.id ?? null) };
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  root: initialLeaf,
  focusedPaneId: initialLeaf.id,

  focusPane: (paneId) => {
    if (!findLeaf(get().root, paneId)) return;
    set({ focusedPaneId: paneId });
  },

  splitWith: (paneId, direction, newLeaf) => {
    const next = splitPane(get().root, paneId, direction, newLeaf);
    if (next === get().root) return;
    // 新面板成为焦点，方便立即操作
    set(withValidFocus(next, newLeaf.id));
  },

  /**
   * 取消分屏：把所有面板合并成一个面板，留下的就是当前聚焦的那个。
   * - 仅一个面板时直接 no-op（没有可收的）
   * - 未传 paneId 时回退到第一个面板
   * - 其它面板的会话不会从 terminalStore 删除，只是不再展示；
   *   通过重新分屏或点击对应 tab（ensureVisible）可以再次显示。
   */
  mergeToSinglePane: (paneId) => {
    const root = get().root;
    if (listLeaves(root).length <= 1) return;
    const target =
      paneId && findLeaf(root, paneId)
        ? paneId
        : (findLeaf(root, get().focusedPaneId ?? "")?.id ?? listLeaves(root)[0]?.id);
    if (!target) return;
    const leaf = collapseToLeaf(root, target);
    if (!leaf) return;
    set(withValidFocus(leaf, leaf.id));
  },

  closePaneById: (paneId) => {
    const root = get().root;
    // 至少保留一个面板
    if (listLeaves(root).length <= 1) return;
    const next = closePane(root, paneId);
    if (!next) return;
    set(withValidFocus(next, get().focusedPaneId));
  },

  setPaneSessionById: (paneId, sessionId) => {
    set({ root: setPaneSession(get().root, paneId, sessionId) });
  },

  setSplitRatio: (splitId, ratio) => {
    set({ root: setRatio(get().root, splitId, ratio) });
  },

  pruneSessions: (aliveSessionIds, fallback) => {
    const alive = new Set(aliveSessionIds);
    const focused = get().focusedPaneId;
    const seen = new Set<string>();

    let root = mapLeaves(get().root, (leaf) => {
      // 会话已不存在 → 置空
      if (!leaf.sessionId || !alive.has(leaf.sessionId)) return { ...leaf, sessionId: null };
      // 重复占用：聚焦面板优先保留，其余置空
      if (!seen.has(leaf.sessionId)) {
        seen.add(leaf.sessionId);
        return leaf;
      }
      if (leaf.id === focused) return leaf;
      return { ...leaf, sessionId: null };
    });

    // 空面板：优先用 fallback 顶替，否则关闭（永远保留最后一个面板）
    let guard = 0;
    while (guard < 64) {
      guard += 1;
      const leaves = listLeaves(root);
      const empties = leaves.filter((l) => l.sessionId === null);
      if (empties.length === 0) break;
      const target = empties[0];
      const fallbackUsable =
        !!fallback &&
        alive.has(fallback) &&
        !leaves.some((l) => l.sessionId === fallback);
      if (leaves.length <= 1 || fallbackUsable) {
        root = setPaneSession(root, target.id, fallbackUsable ? fallback : null);
        if (!fallbackUsable) break; // 只剩一个面板且没有可用 fallback，保持为空
        continue;
      }
      const next = closePane(root, target.id);
      if (!next) {
        root = createLeaf(fallback ?? null);
        break;
      }
      root = next;
    }

    set(withValidFocus(root, get().focusedPaneId));
  },

  ensureVisible: (sessionId) => {
    const root = get().root;
    if (listLeaves(root).some((l) => l.sessionId === sessionId)) return;
    const target = (findLeaf(root, get().focusedPaneId ?? "") ?? listLeaves(root)[0])?.id;
    if (!target) return;
    set({ root: setPaneSession(root, target, sessionId) });
  },

  reset: () => {
    const leaf = createLeaf(null);
    set({ root: leaf, focusedPaneId: leaf.id });
  },
}));
