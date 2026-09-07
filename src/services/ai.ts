import type { AIProviderConfig, AIMessage, TerminalSessionState, HostConfig } from "@/types";
import { SYSTEM_PROMPT, buildContextBlock } from "./prompts";
import { parseCommandsFromMarkdown } from "./safety";

export interface ChatCompletionParams {
  config: AIProviderConfig;
  userMessage: string;
  chatHistory: AIMessage[];
  terminalCtx?: TerminalSessionState | null;
  hostConfig?: HostConfig | null;
  signal?: AbortSignal;
  /** 流式输出回调：OpenAI 兼容 SSE 模式下逐 token 回调（delta 文本） */
  onToken?: (delta: string) => void;
}

export interface ChatCompletionResult {
  content: string;
  commands: ReturnType<typeof parseCommandsFromMarkdown>;
}

/** 单次 AI 请求总超时（毫秒）：防止请求永久挂起导致 UI 一直转圈「无法回复」 */
const REQUEST_TIMEOUT_MS = 120_000;
/** 流式响应空闲超时（毫秒）：连接已建立但长时间没有新 token 也算卡死 */
const STREAM_IDLE_TIMEOUT_MS = 45_000;

/**
 * 把外部 signal 与一个「自动超时」合并成单个 controller。
 *
 * 背景（真实故障）：此前 AISidebar 创建了 AbortController，但只有用户手动点
 * 「停止」才会 abort。一旦请求挂起（服务端不响应 / SSE 流建立后不推数据 /
 * 网络假死），await 会永久 pending，UI 卡在 loading + 空占位气泡，表现为
 * 「AI 不回复了」。这里补上自动超时兜底，同时保留外部 abort 语义。
 */
function createTimeoutSignal(external: AbortSignal | undefined, timeoutMs: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort(new Error(`AI 请求超时：${Math.round(timeoutMs / 1000)} 秒内没有完成`));
  }, timeoutMs);
  const onExternalAbort = () => {
    clearTimeout(timer);
    ctrl.abort(external?.reason);
  };
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

/**
 * 带空闲超时的 reader.read()。
 *
 * SSE 流一旦建立，服务端若不推数据，reader.read() 会一直 pending —— 总超时
 * 之前 UI 就已经「假死」很久了。这里按「多久没收到新数据」判定，比总超时更精准。
 */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`AI 响应超时：${Math.round(idleMs / 1000)} 秒内没有收到新数据`));
    }, idleMs);
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * 底层 OpenAI 兼容请求。
 * - onToken 未提供：一次性返回完整文本（非流式，向后兼容）。
 * - onToken 提供：以 SSE 流式读取，逐 token 回调，最终返回完整文本。
 */
async function requestChat(
  config: AIProviderConfig,
  messages: OpenAIMessage[],
  signal?: AbortSignal,
  onToken?: (delta: string) => void,
  timeouts?: { totalMs?: number; idleMs?: number }
): Promise<string> {
  const totalMs = timeouts?.totalMs ?? REQUEST_TIMEOUT_MS;
  const idleMs = timeouts?.idleMs ?? STREAM_IDLE_TIMEOUT_MS;
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const stream = !!onToken;
  // 总超时覆盖「发请求 → 读完响应」全过程；外部 signal（用户点停止）依然生效。
  const timeout = createTimeoutSignal(signal, totalMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        // 流式：强制开启，便于逐步渲染；非流式也带上无害
        stream,
      }),
      signal: timeout.signal,
    });

    if (!resp.ok) {
      let errMsg = `HTTP ${resp.status}`;
      try {
        const j = await resp.json();
        if (j?.error?.message) errMsg = j.error.message;
      } catch {
        // ignore
      }
      throw new Error(`AI 请求失败：${errMsg}`);
    }

    // 非流式：直接解析 JSON
    if (!stream || !resp.body) {
      const data = await resp.json();
      return data?.choices?.[0]?.message?.content ?? "";
    }

    // 流式：逐块读取 SSE，解析 data: {...}
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    try {
      for (;;) {
        // 空闲超时：流已建立但服务端迟迟不推数据时，总超时之前 UI 就已假死，
        // 这里按「多久没收到新数据」单独判定，让卡死尽快暴露成明确错误。
        const { done, value } = await readChunk(reader, idleMs);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const json = JSON.parse(payload);
            const delta: string | undefined = json?.choices?.[0]?.delta?.content;
            if (delta) {
              full += delta;
              onToken!(delta);
            }
          } catch {
            // 畸形/不完整行直接跳过，避免单条解析失败导致整轮中断
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    return full;
  } finally {
    timeout.dispose();
  }
}

export interface RawChatCompletionParams {
  config: AIProviderConfig;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  signal?: AbortSignal;
  /** 流式输出回调 */
  onToken?: (delta: string) => void;
  /** 仅供测试/高级用法：覆盖默认超时（不传则用 REQUEST_TIMEOUT_MS / STREAM_IDLE_TIMEOUT_MS） */
  timeouts?: { totalMs?: number; idleMs?: number };
}

/**
 * 原始对话接口：完全由调用方控制 messages（用于 Agent 自主执行循环）
 */
export async function chatCompletionRaw(params: RawChatCompletionParams): Promise<string> {
  const { config, messages, signal, onToken, timeouts } = params;
  if (!config.apiKey) {
    throw new Error("还未配置 AI API Key，请在上方设置中填写后再试。");
  }
  switch (config.provider) {
    case "anthropic":
      throw new Error("Anthropic 供应商将在后续版本支持，当前请使用 OpenAI 兼容 API。");
    case "custom":
    case "openai":
    default:
      return await requestChat(config, messages, signal, onToken, timeouts);
  }
}

async function chatCompletionOpenAI(params: ChatCompletionParams): Promise<string> {
  const { config, userMessage, chatHistory, terminalCtx, hostConfig, signal, onToken } = params;

  // 构造 system prompt + 上下文
  const ctxBlock = terminalCtx
    ? buildContextBlock({
        hostIp: terminalCtx.host,
        hostname: terminalCtx.hostName,
        currentUser: terminalCtx.username,
        hostTags: hostConfig?.tags,
        recentOutput: terminalCtx.recentOutput,
        commandHistory: terminalCtx.history,
      })
    : "";

  const systemContent = [SYSTEM_PROMPT, ctxBlock].filter(Boolean).join("\n\n");

  const messages: OpenAIMessage[] = [
    { role: "system", content: systemContent },
  ];

  // 加入历史（只保留最近 10 轮对话，避免上下文过长）
  const recentHistory = chatHistory.slice(-20);
  for (const m of recentHistory) {
    // 跳过空内容（如流式占位消息），避免污染上下文
    if ((m.role === "user" || m.role === "assistant") && m.content.trim()) {
      messages.push({ role: m.role, content: m.content });
    }
  }
  messages.push({ role: "user", content: userMessage });

  return requestChat(config, messages, signal, onToken);
}

/**
 * 统一的 AI 聊天接口（前端调用这个）
 * 以后扩展 Anthropic / 自定义供应商，在这里分发
 */
export async function chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
  if (!params.config.apiKey) {
    throw new Error("还未配置 AI API Key，请在上方设置中填写后再试。");
  }

  let content: string;
  switch (params.config.provider) {
    case "anthropic":
      // TODO: 实现 Anthropic 适配（提示词格式略不同）
      throw new Error("Anthropic 供应商将在后续版本支持，当前请使用 OpenAI 兼容 API。");
    case "custom":
    case "openai":
    default:
      content = await chatCompletionOpenAI(params);
      break;
  }

  return {
    content,
    commands: parseCommandsFromMarkdown(content),
  };
}
