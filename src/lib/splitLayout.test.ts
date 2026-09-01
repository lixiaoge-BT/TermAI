import { test, describe } from "node:test";
import assert from "node:assert";
import {
  createLeaf,
  splitPane,
  closePane,
  setPaneSession,
  setRatio,
  mapLeaves,
  listLeaves,
  findLeaf,
  findLeafBySession,
  computeLayout,
  type SplitNode,
} from "./splitLayout";

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

describe("splitPane", () => {
  test("在目标叶子处切成两个面板，原叶子在前", () => {
    const a = createLeaf("s1");
    const b = createLeaf("s2");
    const root = splitPane(a, a.id, "row", b);
    assert.strictEqual(root.type, "split");
    if (root.type !== "split") return;
    assert.strictEqual(root.direction, "row");
    assert.strictEqual(root.ratio, 0.5);
    assert.strictEqual(root.children[0].id, a.id);
    assert.strictEqual(root.children[1].id, b.id);
    assert.deepStrictEqual(
      listLeaves(root).map((l) => l.sessionId),
      ["s1", "s2"]
    );
  });

  test("目标不存在时原样返回（同一引用）", () => {
    const a = createLeaf("s1");
    const out = splitPane(a, "nope", "row", createLeaf("s2"));
    assert.strictEqual(out, a);
  });

  test("嵌套分屏：能命中深层叶子且不误伤兄弟节点", () => {
    const a = createLeaf("s1");
    const b = createLeaf("s2");
    const c = createLeaf("s3");
    const root = splitPane(splitPane(a, a.id, "row", b), b.id, "column", c);
    assert.deepStrictEqual(
      listLeaves(root).map((l) => l.sessionId),
      ["s1", "s2", "s3"]
    );
    // 第一层仍是 row
    if (root.type === "split") assert.strictEqual(root.direction, "row");
  });
});

describe("closePane", () => {
  test("关闭分支中的一个叶子 → 兄弟节点顶替上来", () => {
    const a = createLeaf("s1");
    const b = createLeaf("s2");
    const root = splitPane(a, a.id, "row", b);
    const out = closePane(root, b.id);
    assert.strictEqual(out?.id, a.id);
    assert.strictEqual(out?.type, "leaf");
  });

  test("关闭唯一面板 → 返回 null（调用方应阻止）", () => {
    const a = createLeaf("s1");
    assert.strictEqual(closePane(a, a.id), null);
  });

  test("关闭不存在的面板 → 原样返回同一引用", () => {
    const a = createLeaf("s1");
    assert.strictEqual(closePane(a, "nope"), a);
  });

  test("嵌套：关掉中间层叶子后结构仍然合法", () => {
    const a = createLeaf("s1");
    const b = createLeaf("s2");
    const c = createLeaf("s3");
    const root = splitPane(splitPane(a, a.id, "row", b), b.id, "column", c);
    const out = closePane(root, c.id);
    assert.deepStrictEqual(
      listLeaves(out!).map((l) => l.sessionId),
      ["s1", "s2"]
    );
  });
});

describe("setPaneSession / setRatio / mapLeaves", () => {
  test("设置指定面板的会话", () => {
    const a = createLeaf("s1");
    const b = createLeaf("s2");
    const root = splitPane(a, a.id, "row", b);
    const out = setPaneSession(root, b.id, "s9");
    assert.strictEqual(findLeafBySession(out, "s9")?.id, b.id);
  });

  test("ratio 被夹在 0.1~0.9，避免面板被拖没", () => {
    const a = createLeaf("s1");
    const b = createLeaf("s2");
    const root = splitPane(a, a.id, "row", b);
    if (root.type !== "split") return;
    const hi = setRatio(root, root.id, 0.99);
    const lo = setRatio(root, root.id, -5);
    const mid = setRatio(root, root.id, 0.42);
    if (hi.type !== "split" || lo.type !== "split" || mid.type !== "split") {
      assert.fail("setRatio 应保持 split 结构");
    }
    assert.strictEqual(hi.ratio, 0.9);
    assert.strictEqual(lo.ratio, 0.1);
    assert.strictEqual(mid.ratio, 0.42);
  });

  test("mapLeaves 只改叶子、保持树结构", () => {
    const a = createLeaf("s1");
    const b = createLeaf("s2");
    const root = splitPane(a, a.id, "column", b);
    const out = mapLeaves(root, (l) => ({ ...l, sessionId: null }));
    if (out.type !== "split") assert.fail("应保持 split 结构");
    assert.strictEqual(out.direction, "column");
    assert.deepStrictEqual(
      listLeaves(out).map((l) => l.sessionId),
      [null, null]
    );
  });

  test("findLeaf 能定位面板", () => {
    const a = createLeaf("s1");
    const b = createLeaf("s2");
    const root = splitPane(a, a.id, "row", b);
    assert.strictEqual(findLeaf(root, b.id)?.sessionId, "s2");
    assert.strictEqual(findLeaf(root, "missing"), null);
  });
});

describe("computeLayout", () => {
  test("单个叶子占满整个区域", () => {
    const { leaves, dividers } = computeLayout(createLeaf("s1"));
    assert.strictEqual(leaves.length, 1);
    assert.deepStrictEqual(leaves[0].rect, { x: 0, y: 0, w: 1, h: 1 });
    assert.strictEqual(dividers.length, 0);
  });

  test("row 方向：左右各占一半，分隔线在 0.5", () => {
    const a = createLeaf("s1");
    const b = createLeaf("s2");
    const root = splitPane(a, a.id, "row", b);
    const { leaves, dividers } = computeLayout(root);
    const [l0, l1] = leaves;
    assert.ok(near(l0.rect.x, 0) && near(l0.rect.w, 0.5));
    assert.ok(near(l1.rect.x, 0.5) && near(l1.rect.w, 0.5));
    assert.ok(near(l0.rect.h, 1) && near(l1.rect.h, 1));
    assert.strictEqual(dividers.length, 1);
    assert.strictEqual(dividers[0].direction, "row");
    assert.ok(near(dividers[0].at, 0.5));
  });

  test("column 方向：上下各占一半", () => {
    const a = createLeaf("s1");
    const b = createLeaf("s2");
    const root = splitPane(a, a.id, "column", b);
    const { leaves } = computeLayout(root);
    assert.ok(near(leaves[0].rect.h, 0.5) && near(leaves[0].rect.y, 0));
    assert.ok(near(leaves[1].rect.y, 0.5) && near(leaves[1].rect.h, 0.5));
    assert.ok(near(leaves[0].rect.w, 1) && near(leaves[1].rect.w, 1));
  });

  test("嵌套分屏：矩形互不重叠且铺满父区域", () => {
    const a = createLeaf("s1");
    const b = createLeaf("s2");
    const c = createLeaf("s3");
    let root: SplitNode = splitPane(a, a.id, "row", b);
    root = splitPane(root, b.id, "column", c);
    const { leaves, dividers } = computeLayout(root);
    assert.strictEqual(leaves.length, 3);
    assert.strictEqual(dividers.length, 2);
    // 面积之和为 1 → 说明恰好铺满、无重叠无缝隙
    const area = leaves.reduce((s, l) => s + l.rect.w * l.rect.h, 0);
    assert.ok(near(area, 1));
  });

  test("ratio 生效：0.3 时左 0.3 右 0.7", () => {
    const a = createLeaf("s1");
    const b = createLeaf("s2");
    const root = setRatio(splitPane(a, a.id, "row", b), "any", 0.3);
    // splitId 不匹配时保持 0.5；这里用真实 splitId 再算一次
    if (root.type !== "split") return;
    const r03 = setRatio(root, root.id, 0.3);
    if (r03.type !== "split") assert.fail("应保持 split 结构");
    const out = computeLayout(r03);
    assert.ok(near(out.leaves[0].rect.w, 0.3));
    assert.ok(near(out.leaves[1].rect.x, 0.3));
    assert.ok(near(out.leaves[1].rect.w, 0.7));
  });
});
