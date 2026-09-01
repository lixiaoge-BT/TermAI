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
