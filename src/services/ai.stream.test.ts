import { test } from "node:test";
import assert from "node:assert/strict";
import { chatCompletionRaw } from "./ai";

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
