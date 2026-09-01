import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAgentReply,
  splitCommandBlock,
  flattenCommand,
  buildObservation,
} from "./agent";

describe("splitCommandBlock", () => {
  it("去掉注释与空行", () => {
    assert.deepEqual(splitCommandBlock("# 注释\nls -la\n\n  "), ["ls -la"]);
  });

  it("容忍模型自作主张加的序号/列表符号", () => {
    assert.deepEqual(splitCommandBlock("1) df -h\n2. free -m\n- uptime"), [
      "df -h",
      "free -m",
      "uptime",
    ]);
  });
});

describe("parseAgentReply", () => {
  it("解析 <<<RUN>>> 块为命令列表", () => {
    const r = parseAgentReply("<<<RUN>>>\nls -la\n<<<END>>>");
    assert.equal(r.done, false);
    assert.deepEqual(r.commands, ["ls -la"]);
  });

  it("批量 RUN：多行命令拆成多条", () => {
    const r = parseAgentReply("<<<RUN>>>\n1. df -h\n2. free -h\n<<<END>>>");
    assert.deepEqual(r.commands, ["df -h", "free -h"]);
  });

  it("<<<DONE>>> 视为结束并提取结论", () => {
    const r = parseAgentReply("<<<DONE>>>\n系统健康");
    assert.equal(r.done, true);
    assert.deepEqual(r.commands, []);
    assert.equal(r.finalAnswer, "系统健康");
  });

  it("未遵循协议时退化为最终结论", () => {
    const r = parseAgentReply("这里没有协议标记，当作总结");
    assert.equal(r.done, true);
    assert.ok(r.finalAnswer?.includes("总结"));
  });
});

describe("flattenCommand", () => {
  it("单行原样返回", () => {
    assert.equal(flattenCommand("ls -la"), "ls -la");
  });

  it("多行用分号连接", () => {
    assert.equal(flattenCommand("ls\ncd /tmp"), "ls ; cd /tmp");
  });

  it("上一行以连接符结尾时直接拼接", () => {
    assert.equal(flattenCommand("echo a &&\\\n  echo b"), "echo a && echo b");
  });
});

describe("buildObservation", () => {
  it("超长输出按预算截断", () => {
    const longOut = "A".repeat(7000);
    const obs = buildObservation([
      { command: "cat big", result: { output: longOut, exitCode: 0, timedOut: false, script: "" } },
    ]);
    assert.ok(obs.includes("输出过长已截断"));
    // 原始 7000 字符不应完整保留（单条预算 6000）
    assert.ok(!obs.includes(longOut));
    // 但前 6000 个字符应当出现
    assert.ok(obs.includes("A".repeat(6000)));
  });

  it("正常输出完整保留", () => {
    const obs = buildObservation([
      { command: "ls", result: { output: "a\nb", exitCode: 0, timedOut: false, script: "" } },
    ]);
    assert.ok(obs.includes("a\nb"));
    assert.ok(obs.includes("退出码：0"));
  });
});
