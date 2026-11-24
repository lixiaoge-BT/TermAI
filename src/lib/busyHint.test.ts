import test from "node:test";
import assert from "node:assert/strict";
import {
  busyHint,
  THINK_SLOW_SEC,
  EXEC_SLOW_SEC,
  COMPRESS_SLOW_SEC,
} from "./busyHint";

test("thinking：只有真的等模型超过阈值才提示「可点停止」", () => {
  const early = busyHint("thinking", "running", 3);
  assert.match(early.label, /思考/);
  assert.equal(early.hint, "");
  assert.equal(early.warn, false);

  const edge = busyHint("thinking", "running", THINK_SLOW_SEC - 1);
  assert.equal(edge.hint, "", "差一秒也不能报慢");

  const slow = busyHint("thinking", "running", THINK_SLOW_SEC);
  assert.match(slow.hint, /模型响应较慢/);
  assert.equal(slow.warn, true);
});

test("exec：执行命令的时间不再被算成「模型慢」", () => {
  const running = busyHint("exec", "running", 30);
  assert.match(running.label, /执行命令/);
  assert.equal(running.hint, "", "30s 的安装命令很正常，不该报慢");
  assert.equal(running.warn, false);

  const stuck = busyHint("exec", "running", EXEC_SLOW_SEC);
  assert.match(stuck.hint, /等待交互/);
  assert.equal(stuck.warn, true);
});

test("compress：给出「超时会自动跳过」，且不着警示色", () => {
  assert.equal(busyHint("compress", "running", 5).hint, "");
  const long = busyHint("compress", "running", COMPRESS_SLOW_SEC);
  assert.match(long.hint, /自动跳过/);
  assert.equal(long.warn, false, "压缩慢不影响任务，不该吓用户");
});

test("reconnect：文案说明最长等待，不显示秒数暗示模型卡住", () => {
  const r = busyHint("reconnect", "running", 90);
  assert.match(r.label, /重连/);
  assert.equal(r.warn, false);
});

test("awaiting-confirm 以 phase 为准，压过残留的 stage", () => {
  assert.match(busyHint("thinking", "awaiting-confirm", 80).label, /确认/);
  assert.match(busyHint("confirm", "running", 5).label, /确认/);
});

test("没有 stage（刚启动/旧数据）时按 thinking 处理", () => {
  assert.match(busyHint(undefined, "running", 1).label, /思考/);
});
