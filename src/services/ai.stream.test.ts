import { test } from "node:test";
import assert from "node:assert/strict";
import { chatCompletionRaw, describeHttpStatus, thinkingDisableExtra } from "./ai";

// 用一组字符串分块构造一个符合 Web ReadableStream 接口的伪响应体
function fakeBody(chunks: string[]) {
  let i = 0;
  return {
    getReader() {
      return {
        read() {
          if (i < chunks.length) {
            return Promise.resolve({ value: new TextEncoder().encode(chunks[i++]), done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
        releaseLock() {
          /* noop */
        },
      };
    },
  };
}

const baseConfig = {
  provider: "openai" as const,
  apiKey: "test-key",
  baseUrl: "https://api.example.com/v1",
  model: "gpt-4o-mini",
  temperature: 0,
  maxTokens: 100,
};

test("chatCompletionRaw 流式解析 SSE：逐 token 回调并累积完整文本", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"世界"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const saved = globalThis.fetch;
  const deltas: string[] = [];
  globalThis.fetch = (async () => ({
    ok: true,
    body: fakeBody(sse),
  })) as unknown as typeof fetch;
  try {
    const full = await chatCompletionRaw({
      config: baseConfig,
      messages: [{ role: "user", content: "hi" }],
      onToken: (d) => deltas.push(d),
    });
    assert.equal(full, "你好世界");
    assert.deepEqual(deltas, ["你好", "世界"]);
  } finally {
    globalThis.fetch = saved;
  }
});

test("非流式（无 onToken）直接解析 JSON", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "直接返回" } }] }),
  })) as unknown as typeof fetch;
  try {
    const full = await chatCompletionRaw({
      config: baseConfig,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(full, "直接返回");
  } finally {
    globalThis.fetch = saved;
  }
});

test("流式响应中跳过畸形/不完整行，不中断整轮", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
    "data: {broken json\n\n", // 畸形行
    'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    body: fakeBody(sse),
  })) as unknown as typeof fetch;
  try {
    const full = await chatCompletionRaw({
      config: baseConfig,
      messages: [{ role: "user", content: "hi" }],
      onToken: () => {},
    });
    assert.equal(full, "AB");
  } finally {
    globalThis.fetch = saved;
  }
});

test("HTTP 非 200 抛出可读错误", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: "Invalid API key" } }),
  })) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () =>
        chatCompletionRaw({
          config: baseConfig,
          messages: [{ role: "user", content: "hi" }],
        }),
      /Invalid API key/
    );
  } finally {
    globalThis.fetch = saved;
  }
});
// ---------------------------------------------------------------------------
// 错误码翻译：以前只报「AI 请求失败：HTTP 402」，用户完全看不懂该怎么办
// ---------------------------------------------------------------------------

test("HTTP 状态码被翻译成可行动的中文提示", () => {
  assert.match(describeHttpStatus(401, "Invalid API key"), /API Key 无效/);
  assert.match(describeHttpStatus(402), /余额不足|额度/);
  assert.match(describeHttpStatus(404), /Base URL|模型名/);
  assert.match(describeHttpStatus(429), /频繁|速率/);
  assert.match(describeHttpStatus(500), /服务端内部错误/);
  // 保留服务端原始说明，便于对照排查
  assert.match(describeHttpStatus(401, "Invalid API key"), /Invalid API key/);
});

// ---------------------------------------------------------------------------
// 重试：限流 / 5xx 值得重试，401/402 不该重试（重试只会更慢）
// ---------------------------------------------------------------------------

test("429 会被重试并最终成功", async () => {
  let calls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, status: 429, json: async () => ({ error: { message: "rate limited" } }) };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }) };
  }) as unknown as typeof fetch;
  try {
    const out = await chatCompletionRaw({
      config: baseConfig,
      messages: [{ role: "user", content: "hi" }],
      timeouts: { totalMs: 5_000 },
    });
    assert.equal(out, "ok");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = saved;
  }
});

test("401 不重试（一次失败就抛出）", async () => {
  let calls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    return { ok: false, status: 401, json: async () => ({ error: { message: "Invalid API key" } }) };
  }) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () => chatCompletionRaw({ config: baseConfig, messages: [{ role: "user", content: "hi" }] }),
      /API Key 无效/
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = saved;
  }
});

// ---------------------------------------------------------------------------
// 截断感知：max_tokens 用尽（finish_reason=length）时必须让调用方知道，
// 否则引擎拿到残缺文本 → 解析不出命令 → 越跑越偏。
// ---------------------------------------------------------------------------

test("输出被 max_tokens 截断时 onMeta 上报 truncated", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "说到一半" }, finish_reason: "length" }],
    }),
  })) as unknown as typeof fetch;
  const metas: Array<{ finishReason?: string; truncated: boolean }> = [];
  try {
    const out = await chatCompletionRaw({
      config: baseConfig,
      messages: [{ role: "user", content: "hi" }],
      onMeta: (m) => metas.push(m),
    });
    assert.equal(out, "说到一半");
    assert.equal(metas.length, 1);
    assert.equal(metas[0].finishReason, "length");
    assert.equal(metas[0].truncated, true);
  } finally {
    globalThis.fetch = saved;
  }
});

test("正常结束不上报截断", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "完整" }, finish_reason: "stop" }],
    }),
  })) as unknown as typeof fetch;
  const metas: Array<{ truncated: boolean }> = [];
  try {
    await chatCompletionRaw({
      config: baseConfig,
      messages: [{ role: "user", content: "hi" }],
      onMeta: (m) => metas.push(m),
    });
    assert.equal(metas[0].truncated, false);
  } finally {
    globalThis.fetch = saved;
  }
});

// ---------------------------------------------------------------------------
// 网关不支持 SSE：流式一个 token 都没收到时自动退回非流式
// ---------------------------------------------------------------------------

test("流式响应为空时退回非流式重试", async () => {
  const calls: string[] = [];
  const saved = globalThis.fetch;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push(body.stream ? "stream" : "json");
    if (body.stream) {
      // 网关不支持 SSE：把整包 JSON 一次性返回
      return Promise.resolve({
        ok: true,
        body: fakeBody(['data: {"choices":[{"delta":{"content":""}}]}\n\n', "data: [DONE]\n\n"]),
      });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "退回成功" } }] }),
    });
  }) as unknown as typeof fetch;
  try {
    const out = await chatCompletionRaw({
      config: baseConfig,
      messages: [{ role: "user", content: "hi" }],
      onToken: () => {},
      timeouts: { totalMs: 5_000 },
    });
    assert.equal(out, "退回成功");
    assert.deepEqual(calls, ["stream", "json"]);
  } finally {
    globalThis.fetch = saved;
  }
});

// ---------------------------------------------------------------------------
// 超时保护：真实故障是「AI 多问几轮 / 让改点东西就永久转圈不回复」。
// 根因是请求挂起时没有任何超时能救 —— 这里用注入的短超时验证两条防线。
// ---------------------------------------------------------------------------

/** 构造一个永不 resolve 的 promise，模拟「连接已建立但服务端不响应」 */
const never = () => new Promise<never>(() => {});

test("流式已建立但服务端不推数据 → 空闲超时抛错（不再永久挂起）", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    body: {
      getReader: () => ({
        read: never,
        releaseLock: () => {},
      }),
    },
  })) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () =>
        chatCompletionRaw({
          config: baseConfig,
          messages: [{ role: "user", content: "hi" }],
          onToken: () => {},
          timeouts: { idleMs: 30, totalMs: 5_000 },
        }),
      /没有收到新数据/
    );
  } finally {
    globalThis.fetch = saved;
  }
});

test("fetch 永不返回 → 总超时抛错", async () => {
  const saved = globalThis.fetch;
  // 注意：mock 必须像真实 fetch 那样响应 signal，否则 abort 后 promise 永远 pending，
  // 反而会把测试拖成 "Promise resolution is still pending"。
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const s = init?.signal;
      if (!s) return;
      if (s.aborted) reject(s.reason);
      else s.addEventListener("abort", () => reject(s.reason), { once: true });
    })) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () =>
        chatCompletionRaw({
          config: baseConfig,
          messages: [{ role: "user", content: "hi" }],
          timeouts: { totalMs: 30 },
        }),
      /请求超时/
    );
  } finally {
    globalThis.fetch = saved;
  }
});

// ---------------------------------------------------------------------------
// 思考型模型（Qwen3 等）：把输出预算全花在思考上 → 正文为空。
// 真实故障：Agent 把 maxTokens 压到 1600，Qwen3.5-4B 思考一下就吃光预算，
// finish_reason=length 而 content 一字无，任务直接报错失败。
// 处置：原样重试毫无意义（必然同样为空），必须关思考 + 加大预算再试。
// ---------------------------------------------------------------------------

test("思考吃光输出预算 → 自动关思考并加大预算重试", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const saved = globalThis.fetch;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    bodies.push(body);
    // 关掉思考后才正常给正文；否则只吐思考并把预算耗尽
    if (body.enable_thinking === false) {
      return Promise.resolve({
        ok: true,
        body: fakeBody([
          'data: {"choices":[{"delta":{"content":"<<<DONE>>>搞定"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      });
    }
    return Promise.resolve({
      ok: true,
      body: fakeBody([
        'data: {"choices":[{"delta":{"reasoning_content":"让我想想…"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    });
  }) as unknown as typeof fetch;
  try {
    const out = await chatCompletionRaw({
      config: { ...baseConfig, maxTokens: 1600 },
      messages: [{ role: "user", content: "hi" }],
      onToken: () => {},
      timeouts: { totalMs: 5_000 },
    });
    assert.equal(out, "<<<DONE>>>搞定", "升级预算后应拿到正文");
    assert.equal(bodies.length, 2, "应恰好重试一次");
    assert.equal(bodies[0].max_tokens, 1600);
    assert.ok(
      (bodies[1].max_tokens as number) >= 8192,
      `重试时必须加大输出上限（实际 ${bodies[1].max_tokens}）`
    );
    assert.equal(bodies[1].enable_thinking, false, "重试时必须显式关闭思考");
  } finally {
    globalThis.fetch = saved;
  }
});

test("空正文且无任何思考痕迹 → 判定为模型不支持对话，不重试", async () => {
  let calls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    // 连 reasoning_content 都没有 = 模型根本没产出任何东西（如误配 OCR 模型）
    return { ok: true, json: async () => ({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }) };
  }) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () =>
        chatCompletionRaw({
          config: baseConfig,
          messages: [{ role: "user", content: "hi" }],
        }),
      /模型未返回任何内容/
    );
    assert.equal(calls, 1, "配错模型重试无意义，一次就应抛出");
  } finally {
    globalThis.fetch = saved;
  }
});

// ---------------------------------------------------------------------------
// extraBody 透传：Qwen3 系默认开思考，Agent 场景要显式关掉（省 token + 防预算被吃光）
// ---------------------------------------------------------------------------

test("extraBody 原样平铺进请求体", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const saved = globalThis.fetch;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) });
  }) as unknown as typeof fetch;
  try {
    await chatCompletionRaw({
      config: { ...baseConfig, extraBody: { enable_thinking: false, top_k: 20 } },
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(bodies[0].enable_thinking, false);
    assert.equal(bodies[0].top_k, 20);
    assert.equal(bodies[0].stream, false, "原有字段不应被覆盖");
  } finally {
    globalThis.fetch = saved;
  }
});

test("网关拒绝 extraBody（400）时自动去掉该字段重试", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const saved = globalThis.fetch;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    bodies.push(body);
    if ("enable_thinking" in body) {
      return Promise.resolve({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "unknown field enable_thinking" } }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: "退化成功" } }] }) });
  }) as unknown as typeof fetch;
  try {
    const out = await chatCompletionRaw({
      config: { ...baseConfig, extraBody: { enable_thinking: false } },
      messages: [{ role: "user", content: "hi" }],
      timeouts: { totalMs: 5_000 },
    });
    assert.equal(out, "退化成功");
    assert.equal(bodies.length, 2);
    assert.ok("enable_thinking" in bodies[0]);
    assert.ok(!("enable_thinking" in bodies[1]), "第二跳必须去掉被拒的字段");
  } finally {
    globalThis.fetch = saved;
  }
});

test("thinkingDisableExtra 只对 Qwen3 系生效", () => {
  assert.deepEqual(thinkingDisableExtra("Qwen/Qwen3.5-4B"), { enable_thinking: false });
  assert.deepEqual(thinkingDisableExtra("qwen3-8b-instruct"), { enable_thinking: false });
  assert.deepEqual(thinkingDisableExtra("Qwen/Qwen3-32B"), { enable_thinking: false });
  // 非 Qwen3 模型不应被注入（避免给不认该字段的网关添乱）
  assert.equal(thinkingDisableExtra("gpt-4o-mini"), undefined);
  assert.equal(thinkingDisableExtra("deepseek-chat"), undefined);
});

test("正常流式响应不受超时逻辑影响（回归保护）", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  let i = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    body: {
      getReader: () => ({
        read: () =>
          i < sse.length
            ? Promise.resolve({ value: new TextEncoder().encode(sse[i++]), done: false })
            : Promise.resolve({ value: undefined, done: true }),
        releaseLock: () => {},
      }),
    },
  })) as unknown as typeof fetch;
  try {
    const full = await chatCompletionRaw({
      config: baseConfig,
      messages: [{ role: "user", content: "hi" }],
      onToken: () => {},
      timeouts: { idleMs: 30, totalMs: 5_000 },
    });
    assert.equal(full, "ab", "短超时不应影响正常响应");
  } finally {
    globalThis.fetch = saved;
  }
});
