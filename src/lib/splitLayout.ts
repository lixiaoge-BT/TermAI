// =====================================================
// 分屏布局：纯函数（树结构 + 几何计算），不依赖 React/DOM
// -----------------------------------------------------
// 用二叉树描述分屏：leaf 是一个面板（持有 sessionId），split 是按
// direction 把矩形按比例切成两半的容器。
// direction: "row" = 左右排列（分隔线竖直）；"column" = 上下排列（分隔线水平）。
// 所有矩形都是 0~1 的分数，不需要测量 DOM 就能算出来。
// =====================================================

export type SplitDirection = "row" | "column";

export interface SplitLeaf {
  type: "leaf";
  id: string;
  sessionId: string | null;
}

export interface SplitBranch {
  type: "split";
  id: string;
  direction: SplitDirection;
  /** 第一个子项占比 0~1 */
  ratio: number;
  children: [SplitNode, SplitNode];
}

export type SplitNode = SplitLeaf | SplitBranch;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LeafLayout {
  paneId: string;
  sessionId: string | null;
  rect: Rect;
}

export interface DividerLayout {
  splitId: string;
  direction: SplitDirection;
  /** 父容器的矩形，拖拽时用来把像素坐标换算回比例 */
  parent: Rect;
  /** 分隔线在父矩形主轴上的相对位置（分数） */
  at: number;
}

export interface ComputedLayout {
  leaves: LeafLayout[];
  dividers: DividerLayout[];
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

export function createLeaf(sessionId: string | null = null): SplitLeaf {
  return { type: "leaf", id: nextId("pane"), sessionId };
}

export function createBranch(
  a: SplitNode,
  b: SplitNode,
  direction: SplitDirection,
  ratio = 0.5
): SplitBranch {
  return { type: "split", id: nextId("split"), direction, ratio, children: [a, b] };
}

const clampRatio = (r: number) => Math.min(0.9, Math.max(0.1, r));

// ---------------- 树操作（不可变：命中才返回新对象，否则原样返回） ----------------

/** 在 paneId 处切一刀，newLeaf 成为新面板 */
export function splitPane(
  root: SplitNode,
  paneId: string,
  direction: SplitDirection,
  newLeaf: SplitLeaf
): SplitNode {
  if (root.type === "leaf") {
    return root.id === paneId ? createBranch(root, newLeaf, direction) : root;
  }
  const [a, b] = root.children;
  const na = splitPane(a, paneId, direction, newLeaf);
  if (na !== a) return { ...root, children: [na, b] };
  const nb = splitPane(b, paneId, direction, newLeaf);
  if (nb !== b) return { ...root, children: [a, nb] };
  return root;
}

/** 关闭面板；若关闭的是最后一个面板则返回 null（调用方需阻止） */
export function closePane(root: SplitNode, paneId: string): SplitNode | null {
  if (root.type === "leaf") return root.id === paneId ? null : root;
  const [a, b] = root.children;
  const na = closePane(a, paneId);
  if (na === null) return b;
  if (na !== a) return { ...root, children: [na, b] };
  const nb = closePane(b, paneId);
  if (nb === null) return a;
  if (nb !== b) return { ...root, children: [a, nb] };
  return root;
}

export function setPaneSession(
  root: SplitNode,
  paneId: string,
  sessionId: string | null
): SplitNode {
  if (root.type === "leaf") {
    return root.id === paneId ? { ...root, sessionId } : root;
  }
  const [a, b] = root.children;
  const na = setPaneSession(a, paneId, sessionId);
  if (na !== a) return { ...root, children: [na, b] };
  const nb = setPaneSession(b, paneId, sessionId);
  if (nb !== b) return { ...root, children: [a, nb] };
  return root;
}

export function setRatio(root: SplitNode, splitId: string, ratio: number): SplitNode {
  if (root.type === "leaf") return root;
  const r = clampRatio(ratio);
  if (root.id === splitId) return { ...root, ratio: r };
  const [a, b] = root.children;
  const na = setRatio(a, splitId, r);
  if (na !== a) return { ...root, children: [na, b] };
  const nb = setRatio(b, splitId, r);
  if (nb !== b) return { ...root, children: [a, nb] };
  return root;
}

/** 对所有叶子应用变换 */
export function mapLeaves(
  root: SplitNode,
  fn: (leaf: SplitLeaf) => SplitLeaf
): SplitNode {
  if (root.type === "leaf") return fn(root);
  const [a, b] = root.children;
  const na = mapLeaves(a, fn);
  const nb = mapLeaves(b, fn);
  return na === a && nb === b ? root : { ...root, children: [na, nb] };
}

export function listLeaves(root: SplitNode): SplitLeaf[] {
  if (root.type === "leaf") return [root];
  return [...listLeaves(root.children[0]), ...listLeaves(root.children[1])];
}

export function findLeaf(root: SplitNode, paneId: string): SplitLeaf | null {
  return listLeaves(root).find((l) => l.id === paneId) ?? null;
}

export function findLeafBySession(root: SplitNode, sessionId: string): SplitLeaf | null {
  return listLeaves(root).find((l) => l.sessionId === sessionId) ?? null;
}

/** 找出所有祖先 split 的 id（用于判断面板嵌套结构，暂未使用但便于调试/扩展） */
export function findAncestorSplitIds(root: SplitNode, paneId: string): string[] {
  const walk = (node: SplitNode, acc: string[]): string[] | null => {
    if (node.type === "leaf") return node.id === paneId ? acc : null;
    const next = [...acc, node.id];
    return walk(node.children[0], next) ?? walk(node.children[1], next);
  };
  return walk(root, []) ?? [];
}

// ---------------- 几何计算 ----------------

/**
 * 计算每个叶子的矩形与每条分隔线的位置。
 * 全部是 0~1 分数，配合 CSS 百分比定位即可，无需读取 DOM 尺寸。
 */
export function computeLayout(root: SplitNode): ComputedLayout {
  const leaves: LeafLayout[] = [];
  const dividers: DividerLayout[] = [];

  const walk = (node: SplitNode, rect: Rect) => {
    if (node.type === "leaf") {
      leaves.push({ paneId: node.id, sessionId: node.sessionId, rect });
      return;
    }
    const r = clampRatio(node.ratio);
    const [a, b] = node.children;
    if (node.direction === "row") {
      const aw = rect.w * r;
      walk(a, { x: rect.x, y: rect.y, w: aw, h: rect.h });
      walk(b, { x: rect.x + aw, y: rect.y, w: rect.w - aw, h: rect.h });
      dividers.push({ splitId: node.id, direction: "row", parent: rect, at: r });
    } else {
      const ah = rect.h * r;
      walk(a, { x: rect.x, y: rect.y, w: rect.w, h: ah });
      walk(b, { x: rect.x, y: rect.y + ah, w: rect.w, h: rect.h - ah });
      dividers.push({ splitId: node.id, direction: "column", parent: rect, at: r });
    }
  };

  walk(root, { x: 0, y: 0, w: 1, h: 1 });
  return { leaves, dividers };
}
