import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isAgentHoldingInput, isStopShortcut } from "./agentInputGate";

describe("isAgentHoldingInput（AI 接管期间独占键盘）", () => {
  test("接管中（含等待确认）必须独占", () => {
    // 思考期间终端看似空闲，用户敲的字会留在 shell 行缓冲里，
    // 等下一条命令写进来就粘成 `半行cmd` —— 所以 running 全程都要拦。
    assert.equal(isAgentHoldingInput("running"), true);
    assert.equal(isAgentHoldingInput("awaiting-confirm"), true);
  });

  test("结束/停止/出错/空闲必须放行", () => {
    // 反过来的误判更致命：一次异常退出若仍判为独占，键盘就永久失效了。
    assert.equal(isAgentHoldingInput("done"), false);
    assert.equal(isAgentHoldingInput("stopped"), false);
    assert.equal(isAgentHoldingInput("error"), false);
    assert.equal(isAgentHoldingInput("idle"), false);
    assert.equal(isAgentHoldingInput(undefined), false);
  });
});

describe("isStopShortcut", () => {
  test("只认 Ctrl+C", () => {
    assert.equal(isStopShortcut("\x03"), true);
    // 宽松判据：普通字符/回车/退格都不能当停止
    assert.equal(isStopShortcut("\r"), false);
    assert.equal(isStopShortcut("c"), false);
    assert.equal(isStopShortcut("\u007f"), false);
    assert.equal(isStopShortcut(""), false);
  });
});
