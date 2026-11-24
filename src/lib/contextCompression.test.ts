import { test, describe } from "node:test";
import assert from "node:assert";
import {
  estimateTokens,
  estimateMessagesTokens,
  shouldCompress,
  isSummaryMessage,
  extractSummary,
  clampSummary,
  renderTranscript,
  buildCompressionMessages,
  assembleCompressedMessages,
  trimMessages,
  estimateContextWindow,
  SUMMARY_MARKER,
  SUMMARY_MAX_CHARS,
  type ChatMessage,
} from "./contextCompression";

const sys = (content: string): ChatMessage => ({ role: "system", content });
const user = (content: string): ChatMessage => ({ role: "user", content });
const asst = (content: string): ChatMessage => ({ role: "assistant", content });

describe("estimateTokens / estimateMessagesTokens", () => {
  test("空串为 0", () => {
    assert.strictEqual(estimateTokens(""), 0);
  });

  test("纯英文按 4 字符 1 token 估算", () => {
    // 100 个英文字符 → 25 token
    const t = estimateTokens("a".repeat(100));
    assert.strictEqual(t, 25);
  });

  test("中日韩字符权重更高（同样字数 token 更多）", () => {
    const cn = estimateTokens("你".repeat(20));
    const en = estimateTokens("a".repeat(20));
    assert.ok(cn > en, `中文 ${cn} 应大于英文 ${en}`);
  });

  test("消息列表额外计入每条的结构开销", () => {
    const msgs = [user("a".repeat(100)), user("a".repeat(100))];
    // 2 × 25 + 2 × 4 = 58
    assert.strictEqual(estimateMessagesTokens(msgs), 25 + 25 + 4 + 4);
  });
});

describe("shouldCompress", () => {
  const opts = { maxMessages: 18, maxTokens: 6000 };

  test("消息太少时不压缩", () => {
    assert.strictEqual(shouldCompress([sys("s"), user("hi")], opts), false);
  });

  test("条数达阈值即触发", () => {
    const msgs = [sys("s"), ...Array.from({ length: 20 }, () => user("x"))];
    assert.strictEqual(shouldCompress(msgs, opts), true);
  });

  test("条数少但内容超长也触发（旧版只看条数会漏掉）", () => {
    const msgs = [sys("s"), user("x".repeat(40000)), asst("y".repeat(40000))];
    assert.ok(msgs.length < opts.maxMessages, "条数确实没到阈值");
    assert.strictEqual(shouldCompress(msgs, opts), true);
  });

  test("条数与 token 都没超则不触发", () => {
    const msgs = [sys("s"), ...Array.from({ length: 10 }, () => user("short"))];
    assert.strictEqual(shouldCompress(msgs, opts), false);
  });
});

describe("摘要识别", () => {
  test("识别带标记且为 assistant 的摘要消息", () => {
    assert.strictEqual(isSummaryMessage(asst(`${SUMMARY_MARKER}\n正文`)), true);
    assert.strictEqual(isSummaryMessage(user(`${SUMMARY_MARKER}\n正文`)), false);
    assert.strictEqual(isSummaryMessage(asst("普通回复")), false);
  });

  test("extractSummary 去掉标记与首个换行", () => {
    assert.strictEqual(extractSummary(asst(`${SUMMARY_MARKER}\n第一步\n第二步`)), "第一步\n第二步");
  });

  test("非摘要消息返回空串", () => {
    assert.strictEqual(extractSummary(asst("普通")), "");
  });
});

describe("clampSummary", () => {
  test("未超长时原样返回", () => {
    assert.strictEqual(clampSummary("短摘要"), "短摘要");
  });

  test("超长时截断并留下提示", () => {
    const long = "x".repeat(SUMMARY_MAX_CHARS + 500);
    const out = clampSummary(long);
    assert.ok(out.length < long.length);
    assert.ok(out.includes("摘要超长已截断"));
  });

  test("可自定义上限", () => {
    const out = clampSummary("y".repeat(300), 50);
    assert.ok(out.startsWith("yyyy"));
    assert.ok(out.includes("截断"));
  });
});

describe("renderTranscript", () => {
  test("短消息原样渲染，带 role 标题", () => {
    const out = renderTranscript([user("ls -la")]);
    assert.strictEqual(out, "### user\nls -la");
  });

  test("超长消息保留头尾、中间省略（命令在头、报错在尾）", () => {
    const body = `HEAD${"m".repeat(5000)}TAIL`;
    const out = renderTranscript([user(body)], 200);
    assert.ok(out.includes("HEAD"), "应保留开头");
    assert.ok(out.includes("TAIL"), "应保留结尾");
    assert.ok(out.includes("省略"), "应有省略提示");
    assert.ok(out.length < 400, `渲染结果应被控制住，实际 ${out.length}`);
  });
});

describe("buildCompressionMessages", () => {
  test("首次压缩：上一轮摘要标注为「无」", () => {
    const msgs = buildCompressionMessages({ goal: "装 nginx", transcript: "### user\nls" });
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].role, "system");
    assert.ok(msgs[0].content.includes("## 任务目标"), "提示词应含结构化标题");
    assert.ok(msgs[1].content.includes("装 nginx"));
    assert.ok(msgs[1].content.includes("（无，这是首次压缩）"));
  });

  test("二次压缩：带上上一轮摘要走滚动合并", () => {
    const msgs = buildCompressionMessages({
      goal: "装 nginx",
      previousSummary: "已完成 apt update",
      transcript: "### user\napt install nginx",
    });
    assert.ok(msgs[1].content.includes("已完成 apt update"));
    assert.ok(!msgs[1].content.includes("（无，这是首次压缩）"));
  });

  test("提示词明确要求保留命令原文与未解决错误", () => {
    const msgs = buildCompressionMessages({ goal: "g", transcript: "t" });
    assert.ok(/EXACT/.test(msgs[0].content), "应要求命令保持原文");
    assert.ok(/UNRESOLVED/.test(msgs[0].content), "应强调未解决错误");
  });

  test("提示词要求单列「已排除的假设」，避免压缩后重复失败过的尝试", () => {
    const msgs = buildCompressionMessages({ goal: "g", transcript: "t" });
    assert.ok(msgs[0].content.includes("## 已排除的假设"));
    assert.ok(/FAILED/.test(msgs[0].content), "必须明确这是「试过且失败」的方法");
  });
});

describe("assembleCompressedMessages", () => {
  test("顺序为 system → 摘要 → 目标 → 最近轮", () => {
    const out = assembleCompressedMessages({
      system: sys("SYS"),
      goal: "原始目标",
      summary: "摘要正文",
      recent: [user("最近1"), asst("最近2")],
    });
    assert.strictEqual(out.length, 5);
    assert.strictEqual(out[0].content, "SYS");
    assert.ok(out[1].content.startsWith(SUMMARY_MARKER));
    assert.strictEqual(out[2].content, "原始目标");
    assert.strictEqual(out[3].content, "最近1");
  });

  test("目标已在最近轮里则不重复插入", () => {
    const out = assembleCompressedMessages({
      system: sys("SYS"),
      goal: "原始目标",
      summary: "摘要",
      recent: [user("原始目标"), asst("回复")],
    });
    assert.strictEqual(out.filter((m) => m.content === "原始目标").length, 1);
  });

  test("摘要为空时跳过摘要消息", () => {
    const out = assembleCompressedMessages({
      system: sys("SYS"),
      goal: "g",
      summary: "   ",
      recent: [user("r")],
    });
    assert.ok(!out.some(isSummaryMessage));
  });

  test("超长摘要被截断（防止摘要本身膨胀）", () => {
    const out = assembleCompressedMessages({
      system: sys("SYS"),
      goal: "g",
      summary: "z".repeat(SUMMARY_MAX_CHARS + 1000),
      recent: [],
    });
    const summaryMsg = out.find(isSummaryMessage);
    assert.ok(summaryMsg);
    assert.ok(summaryMsg!.content.length <= SUMMARY_MAX_CHARS + SUMMARY_MARKER.length + 30);
  });
});

describe("trimMessages（硬截断兜底）", () => {
  test("保留 system + 目标 + 最近若干轮", () => {
    const msgs = [sys("SYS"), user("目标"), user("旧1"), asst("旧2"), user("新1"), asst("新2")];
    const out = trimMessages(msgs, 2, "目标");
    assert.strictEqual(out[0].content, "SYS");
    assert.strictEqual(out[1].content, "目标");
    assert.strictEqual(out[2].content, "新1");
    assert.strictEqual(out[3].content, "新2");
  });

  test("目标已在保留窗口内则不重复插入", () => {
    const msgs = [sys("SYS"), user("旧"), asst("目标")];
    const out = trimMessages(msgs, 2, "目标");
    assert.strictEqual(out.filter((m) => m.content === "目标").length, 1);
  });

  test("未提供目标时只保留 system + 最近轮", () => {
    const msgs = [sys("SYS"), user("旧"), user("新")];
    const out = trimMessages(msgs, 1);
    assert.deepStrictEqual(out.map((m) => m.content), ["SYS", "新"]);
  });

  test("给出 token 预算时按预算收口，而不是固定条数", () => {
    // 实测故障：41 条 40205 token，按条数截断后仍有 29157 token，
    // 阈值写着 28k 却照样超 —— 小窗口模型（8k/16k）直接 400。
    const big = "x".repeat(4000);
    const msgs: ChatMessage[] = [
      sys("SYS"),
      ...Array.from({ length: 40 }, (_, i) => user(`${i}:${big}`)),
    ];
    const out = trimMessages(msgs, 29, "目标", 10000);
    assert.ok(
      estimateMessagesTokens(out) <= 10000,
      `必须收进预算内，实际 ${estimateMessagesTokens(out)}`
    );
    assert.ok(out.length < msgs.length, "确实发生了截断");
    // 同时断言宽松判据：不传预算时行为不变（按条数），避免把老调用方一起改坏
    const byCount = trimMessages(msgs, 29, "目标");
    // system + 目标 + 最近 29 条 = 31
    assert.equal(byCount.length, 31);
    assert.ok(estimateMessagesTokens(byCount) > 10000);
  });

  test("预算小于单条内容时仍保留最后一条", () => {
    // 全砍光会让模型看不到「刚刚那轮发生了什么」，于是重发同一条命令。
    const msgs = [sys("SYS"), user("y".repeat(40000))];
    const out = trimMessages(msgs, 5, undefined, 100);
    assert.equal(out[out.length - 1].content.length, 40000);
  });
});

describe("estimateContextWindow", () => {
  test("模型名自带窗口声明时以它为准", () => {
    assert.equal(estimateContextWindow({ model: "some-local-model-32k" }), 32768);
  });

  test("本地推理服务按 8192 估（ollama/llama.cpp 常见 n_ctx）", () => {
    assert.equal(estimateContextWindow({ model: "qwen3.5:9b", baseUrl: "http://localhost:11434/v1" }), 8192);
    assert.equal(estimateContextWindow({ model: "x", baseUrl: "http://127.0.0.1:8000/v1" }), 8192);
  });

  test("gpt-3.5-turbo 按 16k 估，主流大窗口模型不误伤", () => {
    assert.equal(estimateContextWindow({ model: "gpt-3.5-turbo", baseUrl: "https://api.openai.com" }), 16385);
    // 宽松判据：gpt-4o / claude 这类必须保持大窗口，不能被下调策略误判成 8k
    assert.equal(estimateContextWindow({ model: "gpt-4o", baseUrl: "https://api.openai.com" }), 128000);
    assert.equal(
      estimateContextWindow({ model: "claude-3-5-sonnet", baseUrl: "https://api.anthropic.com" }),
      128000
    );
  });
});
