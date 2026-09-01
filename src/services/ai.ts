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
  onToken?: (delta: string) => void
): Promise<string> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const stream = !!onToken;
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
    signal,
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
      const { done, value } = await reader.read();
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
}

export interface RawChatCompletionParams {
  config: AIProviderConfig;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  signal?: AbortSignal;
  /** 流式输出回调 */
  onToken?: (delta: string) => void;
}

/**
 * 原始对话接口：完全由调用方控制 messages（用于 Agent 自主执行循环）
 */
export async function chatCompletionRaw(params: RawChatCompletionParams): Promise<string> {
  const { config, messages, signal, onToken } = params;
  if (!config.apiKey) {
    throw new Error("还未配置 AI API Key，请在上方设置中填写后再试。");
  }
  switch (config.provider) {
    case "anthropic":
      throw new Error("Anthropic 供应商将在后续版本支持，当前请使用 OpenAI 兼容 API。");
    case "custom":
    case "openai":
    default:
      return await requestChat(config, messages, signal, onToken);
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
