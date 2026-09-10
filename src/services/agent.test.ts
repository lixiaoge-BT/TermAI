import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAgentReply,
  splitCommandBlock,
  flattenCommand,
  buildObservation,
  makeSentinelMatcher,
  sanitizeOutput,
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
    // 真·结束不带兜底标记，run() 会据此立即收尾而非要求继续
    assert.equal(r.noMarkerFallback, undefined);
  });

  it("未遵循协议时退化为最终结论（标记 noMarkerFallback）", () => {
    const r = parseAgentReply("这里没有协议标记，当作总结");
    assert.equal(r.done, true);
    assert.ok(r.finalAnswer?.includes("总结"));
    // 无标记兜底：run() 应区分「过渡/解释」与「真完成」，避免没做完就停
    assert.equal(r.noMarkerFallback, true);
  });

  it("<<<PLAN>>> 计划声明：剥掉尾部重复的闭合标记", () => {
    const r = parseAgentReply("先出计划\n<<<PLAN>>>\n1. 探测环境\n2. 安装 nginx\n<<<PLAN>>>");
    assert.equal(r.done, false);
    assert.equal(r.commands.length, 0);
    assert.ok(r.plan);
    // 蓝图文本不应混入协议串（会进 UI 计划卡片与 pinned 注入消息）
    assert.ok(!r.plan!.includes("<<<PLAN>>>"));
    assert.ok(r.plan!.includes("安装 nginx"));
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

describe("sanitizeOutput", () => {
  it("剥离 ANSI 控制符与 \\r，压缩连续空行", () => {
    const raw = "line1\r\n\x1B[31mRED\x1B[0m\n\n\n\nline2";
    const out = sanitizeOutput(raw);
    assert.ok(!out.includes("\x1B"), "不该残留 ANSI 序列");
    assert.ok(!out.includes("\r"));
    assert.ok(out.includes("RED"), "行内真实内容必须保留");
    assert.ok(!/\n\n\n/.test(out), "连续空行应被压缩");
  });

  it("超长输出保留头尾并标注省略行数", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `L${i}`);
    const out = sanitizeOutput(lines.join("\n"), 20);
    assert.ok(out.includes("已省略"), "应标注省略");
    assert.ok(out.includes("L0"), "应保留头部");
    assert.ok(out.includes("L299"), "应保留尾部");
    assert.ok(out.length < lines.join("\n").length);
  });

  it("短输出原样保留", () => {
    const raw = "a\nb\nc";
    assert.equal(sanitizeOutput(raw), raw);
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

describe("makeSentinelMatcher（结束哨兵判定）", () => {
  const token = "a1b2c3";
  const begin = `TERMAI_BEGIN_${token}`;
  const end = `TERMAI_END_${token}`;
  const exitTag = `TERMAI_EXIT_${token}`;

  // execCommand 下发的脚本（换行在发送时统一转成 \r），PTY 会把它整段回显回来
  const script = `echo "${begin}"; uptime 2>&1; echo "${exitTag}:$?"; echo "${end}"`;
  const echoBack = (script.replace(/\r?\n/g, "\r") + "\r").replace(/\r/g, "\r\n");

  it("回显里的哨兵不算数（否则命令还没跑就被判为已结束）", () => {
    const matchEnd = makeSentinelMatcher(end);
    // 回显确实含有哨兵子串，说明这条用例真的覆盖到了 PTY 回显场景
    assert.ok(echoBack.includes(end), "前置条件：回显应包含哨兵子串");
    assert.equal(matchEnd(echoBack), false);
  });

  it("命令真正跑完、哨兵独占一行时才算出现", () => {
    const matchEnd = makeSentinelMatcher(end);
    const realOut = echoBack + `${begin}\r\n 09:00:01 up 3 days\r\n${exitTag}:0\r\n${end}\r\n`;
    assert.equal(matchEnd(realOut), true);
  });

  it("哨兵出现在行尾（后面还有提示符）也算出现", () => {
    const matchEnd = makeSentinelMatcher(end);
    assert.equal(matchEnd(`output\r\n${end}$ `), true);
  });
});
