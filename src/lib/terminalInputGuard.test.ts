import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  IME_KEY_CODE,
  STUCK_COMPOSITION_MS,
  isImeProcessKey,
  isStuckComposition,
} from "./terminalInputGuard";
import {
  isAutoFocusSuppressed,
  resetAutoFocusSuppression,
  suppressAutoFocus,
} from "./uiFocus";

describe("isImeProcessKey（输入法接管的 keydown）", () => {
  it("keyCode 229 与 key=Process 都算输入法接管", () => {
    assert.equal(isImeProcessKey({ keyCode: IME_KEY_CODE, key: "a" }), true);
    assert.equal(isImeProcessKey({ keyCode: 0, key: "Process" }), true);
  });

  it("普通可打印键 / 控制键不算", () => {
    assert.equal(isImeProcessKey({ keyCode: 32, key: " " }), false); // 空格
    assert.equal(isImeProcessKey({ keyCode: 8, key: "Backspace" }), false);
    assert.equal(isImeProcessKey({ keyCode: 70, key: "f", ctrlKey: true } as never), false);
  });

  it("缺失字段时安全返回 false（不抛异常）", () => {
    assert.equal(isImeProcessKey({}), false);
  });
});

describe("isStuckComposition（组合态卡死判定）", () => {
  const now = 10_000;

  it("不在组合中永远不判定卡死", () => {
    assert.equal(
      isStuckComposition({ now, composing: false, lastCompositionAt: now - 60_000 }),
      false
    );
  });

  it("刚有组合活动 → 不判定卡死（正常输入法不该被误伤）", () => {
    assert.equal(
      isStuckComposition({ now, composing: true, lastCompositionAt: now - 50 }),
      false
    );
  });

  it("229 还在来但没有组合活动超过阈值 → 判定卡死", () => {
    assert.equal(
      isStuckComposition({ now, composing: true, lastCompositionAt: now - STUCK_COMPOSITION_MS - 1 }),
      true
    );
  });

  it("没有 compositionstart 记录时保守放行", () => {
    assert.equal(isStuckComposition({ now, composing: true, lastCompositionAt: 0 }), false);
  });

  it("阈值可注入", () => {
    assert.equal(
      isStuckComposition({ now, composing: true, lastCompositionAt: now - 200, thresholdMs: 100 }),
      true
    );
    assert.equal(
      isStuckComposition({ now, composing: true, lastCompositionAt: now - 200, thresholdMs: 500 }),
      false
    );
  });
});

describe("UI 静默（自动唤起 AI 不抢焦点）", () => {
  it("未声明时不做抑制", () => {
    resetAutoFocusSuppression();
    assert.equal(isAutoFocusSuppressed(), false);
  });

  it("声明后窗口内抑制，过期后自动解除", () => {
    resetAutoFocusSuppression();
    const base = 1_000_000;
    // 依赖 Date.now()：这里用相对时间验证窗口边界
    suppressAutoFocus(50);
    assert.equal(isAutoFocusSuppressed(), true);
    assert.equal(isAutoFocusSuppressed(Date.now() + 51), false);
    assert.ok(base > 0);
    resetAutoFocusSuppression();
  });

  it("ms<=0 等同于不抑制", () => {
    resetAutoFocusSuppression();
    suppressAutoFocus(0);
    assert.equal(isAutoFocusSuppressed(Date.now() + 1), false);
  });
});
