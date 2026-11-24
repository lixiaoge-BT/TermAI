/**
 * 连接断开容忍窗口的单测。
 *
 * 对应真实故障：Agent 帮用户固定 IP 时，`systemctl restart network` 一生效
 * SSH 就断，主进程 2~4 秒能自动重连回来，但引擎在循环顶部直接判死，
 * 任务 100% 失败。这里锁住「断开后要等重连」这个行为。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { waitForReconnect } from "./agent";

describe("waitForReconnect", () => {
  it("断开后 600ms 恢复 → 返回 true", async () => {
    const t0 = Date.now();
    let connected = false;
    setTimeout(() => {
      connected = true;
    }, 600);
    const ok = await waitForReconnect(() => connected, () => false, 5000);
    assert.equal(ok, true);
    // 必须真的等过一轮轮询，不能立刻放行
    assert.ok(Date.now() - t0 >= 400, "应当等到了重连，而不是直接返回");
  });

  it("窗口内始终没恢复 → false", async () => {
    const t0 = Date.now();
    const ok = await waitForReconnect(() => false, () => false, 300);
    assert.equal(ok, false);
    assert.ok(Date.now() - t0 >= 290, "应当走满窗口才放弃");
  });

  it("一开始就正常 → 立即返回 true（不白等）", async () => {
    const t0 = Date.now();
    const ok = await waitForReconnect(() => true, () => false, 5000);
    assert.equal(ok, true);
    assert.ok(Date.now() - t0 < 100);
  });

  it("用户中途终止 → 立即 false，不等满窗口", async () => {
    let aborted = false;
    setTimeout(() => {
      aborted = true;
    }, 200);
    const t0 = Date.now();
    const ok = await waitForReconnect(() => false, () => aborted, 10_000);
    assert.equal(ok, false);
    assert.ok(Date.now() - t0 < 2000, "被中止时不应继续等");
  });
});
