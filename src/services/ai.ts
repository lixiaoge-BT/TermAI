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
  /** 模型的输出被 max_tokens 截断（finish_reason === "length"），内容可能不完整 */
  truncated?: boolean;
}

/** 单次 AI 请求总超时（毫秒）：防止请求永久挂起导致 UI 一直转圈「无法回复」 */
const REQUEST_TIMEOUT_MS = 120_000;
/** 流式响应空闲超时（毫秒）：连接已建立但长时间没有新 token 也算卡死 */
const STREAM_IDLE_TIMEOUT_MS = 45_000;
/** 可重试错误的最大重试次数（不含首次） */
const MAX_RETRIES = 2;
/** 重试退避（毫秒） */
const RETRY_BACKOFF_MS = [800, 2400];
/** 这些 HTTP 状态值得重试（限流 / 服务端临时故障） */
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
/** 聊天历史回传的字符预算：按「总字符数」而不是「条数」裁剪，避免超长历史顶爆上下文 */
const MAX_HISTORY_CHARS = 12_000;

/**
 * 空正文（且没有任何思考痕迹）时的提示。
 * 前缀「模型未返回任何内容」被 store/agent.ts 用作「值得原样重试一次」的判据，
 * 改动时务必保留该前缀。
 */
const OUTPUT_BUDGET_MESSAGE =
  "模型连续多轮没有输出正文：输出额度被「思考过程」占满（已自动关闭思考并加大输出上限仍失败）。" +
  "建议改用非思考型模型（如 Qwen3.5-4B-Instruct / DeepSeek-V3），或在设置里把 maxTokens 调大后重试。";

const EMPTY_RESPONSE_MESSAGE =
  "模型未返回任何内容。可能原因：① 「模型名」不是对话模型（如误填 DeepSeek-OCR、嵌入、图像生成、TTS 等专用模型）；" +
  "② 服务端瞬时异常或限流。请确认模型支持 chat/completion 后重试。";

/**
 * 思考型模型自动关闭思考（Agent 场景专用）。
 *
 * Qwen3 系（含 Qwen3.5）默认开启 thinking：每轮先输出一大段思考，既直接
 * 烧 token，又可能把 max_tokens 吃光导致正文全空。Agent 要的是「立刻按协议
 * 吐命令」，思考纯属浪费，因此显式关闭。
 * 只对确认支持该字段的模型族注入；网关若不认（返回 400/422），requestChat
 * 会自动去掉它重试，不会把原来能跑的请求搞挂。
 */
export function thinkingDisableExtra(model: string): Record<string, unknown> | undefined {
  return /\bqwen3(\.\d+)?\b/i.test(model) ? { enable_thinking: false } : undefined;
}

/** 一次请求的元信息：用于感知输出被 max_tokens 截断 */
export interface RequestMeta {
  finishReason?: string;
  /** finish_reason === "length"：模型还没说完就被 max_tokens 截断 */
  truncated: boolean;
}

/** 可重试错误（限流 / 5xx / 网络抖动 / 网关不支持流式） */
class RetryableAIError extends Error {
  /** HTTP 状态码（网络层失败时无）—— 用于判断「是不是我们多塞的请求体字段被网关拒了」 */
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "RetryableAIError";
    this.status = status;
  }
}

/** 确定性的 HTTP 错误（401/402/404…）：重试只会更慢，直接抛 */
class APIStatusError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "APIStatusError";
    this.status = status;
  }
}

/** 流式响应为空：多半是网关不支持 SSE，下一次尝试退回非流式 */
class EmptyStreamError extends Error {
  constructor() {
    super("流式响应为空，可能是网关不支持 SSE");
    this.name = "EmptyStreamError";
  }
}

/**
 * 「输出预算被思考过程吃光」——不是配错模型，重试必须换参数才有意义。
 *
 * 真实故障：Qwen3 系等 thinking 模型默认先输出一大段思考。若 max_tokens
 * 偏小（Agent 曾压到 1600），思考就能把预算吃干净，于是 finish_reason=length
 * 而正文 content 一个字都没有。此时若照原样重试，结果必然还是空 —— 必须
 * 「关掉思考 + 加大预算」再试（见 requestChat）。
 *
 * 与之相对，「模型根本不支持对话」（如误配 DeepSeek-OCR）也会给出空正文，
 * 但那种情况连思考都没有（reasoning_content 为空），且重试永远为空。
 */
class OutputBudgetError extends Error {
  constructor(readonly finishReason?: string) {
    super("模型输出预算被思考过程占满（正文为空）");
    this.name = "OutputBudgetError";
  }
}

/**
 * 把 HTTP 状态码翻译成人能看懂的中文提示。
 * 之前只拼 `HTTP ${status}`，用户看到「AI 请求失败：HTTP 402」完全不知道该干嘛
 * （402 = 余额用尽，401 = Key 无效，429 = 限流），只能反复重试或以为程序坏了。
 */
export function describeHttpStatus(status: number, detail?: string): string {
  const map: Record<number, string> = {
    400: "请求参数有误（请检查模型名、temperature 等参数）",
    401: "API Key 无效或已过期，请到 ⚙️ 设置里重新填写",
    402: "账户余额不足或额度已用尽，请充值后重试",
    403: "没有访问该模型/接口的权限",
    404: "接口地址或模型不存在（请检查 Base URL 与模型名）",
    405: "请求方法不被允许（Base URL 可能填写有误）",
    408: "请求超时，请稍后重试",
    409: "请求冲突，请稍后重试",
    422: "请求参数不被接受（该模型可能不支持某些参数）",
    429: "请求过于频繁或已达速率/额度上限，请稍后重试",
    500: "AI 服务端内部错误",
    502: "网关错误（Base URL 可能填写有误或代理不可用）",
    503: "AI 服务暂时不可用，请稍后重试",
    504: "AI 服务端响应超时",
  };
  const base = map[status] ?? `HTTP ${status}`;
  // 保留服务端原始说明，便于对照排查（例如模型名拼错的具体提示）
  if (detail && !base.includes(detail)) return `${base}（${detail}）`;
  return base;
}

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
 * 单次（不重试）OpenAI 兼容请求。
 * - onToken 未提供：一次性返回完整文本（非流式，向后兼容）。
 * - onToken 提供：以 SSE 流式读取，逐 token 回调，最终返回完整文本。
 */
async function attemptChat(
  config: AIProviderConfig,
  messages: OpenAIMessage[],
  signal: AbortSignal | undefined,
  onToken: ((delta: string) => void) | undefined,
  timeouts: { totalMs: number; idleMs: number },
  onMeta?: (meta: RequestMeta) => void
): Promise<string> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  // 总超时覆盖「发请求 → 读完响应」全过程；外部 signal（用户点停止）依然生效。
  const timeout = createTimeoutSignal(signal, timeouts.totalMs);
  let emitted = 0;
  try {
    let resp: Response;
    try {
      resp = await fetch(url, {
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
          stream: !!onToken,
          // 各家网关的私有开关（如 Qwen3 的 enable_thinking）原样平铺。
          // 默认 undefined → 完全不影响既有请求体。
          ...(config.extraBody ?? {}),
        }),
        signal: timeout.signal,
      });
    } catch (e) {
      // fetch 只在「网络层失败」时 reject（DNS / 连接被拒 / 跨域 / 代理 / 断网），
      // 这类抖动重试一次往往就好了，但用户此前只能看到一个原始的 TypeError。
      if (signal?.aborted) throw e;
      const raw = (e as Error)?.message ?? String(e);
      throw new RetryableAIError(`网络请求失败（${raw}），请检查网络、Base URL 或代理设置`);
    }

    if (!resp.ok) {
      let errMsg = "";
      try {
        const j = await resp.json();
        if (j?.error?.message) errMsg = String(j.error.message);
      } catch {
        // ignore
      }
      const friendly = describeHttpStatus(resp.status, errMsg);
      if (RETRY_STATUS.has(resp.status) && !signal?.aborted) {
        throw new RetryableAIError(`AI 请求失败：${friendly}`, resp.status);
      }
      throw new APIStatusError(`AI 请求失败：${friendly}`, resp.status);
    }

    // 非流式：直接解析 JSON
    if (!onToken || !resp.body) {
      const data = await resp.json();
      const finishReason: string | undefined = data?.choices?.[0]?.finish_reason;
      const content: string = data?.choices?.[0]?.message?.content ?? "";
      // 思考型模型（Qwen3 / GLM / DeepSeek-R1…）把思考内容放在这个字段，
      // 部分网关放在 message.reasoning 里，两种都认，只用来判因、不参与输出。
      const reasoning: string =
        data?.choices?.[0]?.message?.reasoning_content ?? data?.choices?.[0]?.message?.reasoning ?? "";
      onMeta?.({ finishReason, truncated: finishReason === "length" });
      if (!content.trim()) {
        // 空正文分两种，处置完全不同（此前一律怪「模型名配错」，把
        // 「思考吃光预算」也误判成配错模型，误导排查方向）：
        // ① 有思考痕迹 / 被 length 截断 → 预算不足，换个参数重试能救；
        // ② 连思考都没有 → 多半真是模型不支持对话，重试无意义，首轮即停。
        if (finishReason === "length" || reasoning.trim()) {
          throw new OutputBudgetError(finishReason);
        }
        throw new Error(EMPTY_RESPONSE_MESSAGE);
      }
      return content;
    }

    // 流式：逐块读取 SSE，解析 data: {...}
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let finishReason: string | undefined;
    /** 收到的思考内容字符数（reasoning_content）：只用于「空正文」时判因 */
    let thinkingChars = 0;
    try {
      for (;;) {
        // 空闲超时：流已建立但服务端迟迟不推数据时，总超时之前 UI 就已假死，
        // 这里按「多久没收到新数据」单独判定，让卡死尽快暴露成明确错误。
        const { done, value } = await readChunk(reader, timeouts.idleMs);
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
            const fr: string | undefined = json?.choices?.[0]?.finish_reason;
            if (fr) finishReason = fr;
            const delta: string | undefined = json?.choices?.[0]?.delta?.content;
            if (delta) {
              full += delta;
              emitted += 1;
              onToken(delta);
            }
            // 思考块（Qwen3 等）：不计入正文，只在正文为空时说明「预算被谁吃了」
            const think: string | undefined =
              json?.choices?.[0]?.delta?.reasoning_content ?? json?.choices?.[0]?.delta?.reasoning;
            if (think) thinkingChars += think.length;
          } catch {
            // 畸形/不完整行直接跳过，避免单条解析失败导致整轮中断
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    onMeta?.({ finishReason, truncated: finishReason === "length" });

    // 一个正文 token 都没收到，分两种情况：
    // ① 有思考输出 → 预算被思考吃光，退回非流式也是白搭，按预算不足处理
    //    （上层会关掉思考 + 加大 max_tokens 再试）；
    // ② 完全没动静 → 多半是网关/代理不支持 SSE，退回非流式再试一次。
    // （已吐过 token 就不重试了，否则会把已渲染的内容重复一遍。）
    if (!full && emitted === 0) {
      if (thinkingChars > 0) throw new OutputBudgetError(finishReason);
      throw new EmptyStreamError();
    }
    return full;
  } finally {
    timeout.dispose();
  }
}

/**
 * 底层 OpenAI 兼容请求（带重试）。
 * 可重试：网络抖动、429、5xx、网关不支持 SSE。
 * 不可重试：用户主动中止、超时、401/402/404 等确定性错误（重试只会更慢）。
 */
async function requestChat(
  config: AIProviderConfig,
  messages: OpenAIMessage[],
  signal?: AbortSignal,
  onToken?: (delta: string) => void,
  timeouts?: { totalMs?: number; idleMs?: number },
  onMeta?: (meta: RequestMeta) => void
): Promise<string> {
  const totalMs = timeouts?.totalMs ?? REQUEST_TIMEOUT_MS;
  const idleMs = timeouts?.idleMs ?? STREAM_IDLE_TIMEOUT_MS;
  let useStream = !!onToken;
  let lastErr: unknown;
  /** 本轮生效配置：预算不足 / 字段被拒时会在此基础上升级后重试 */
  let cfg = config;
  /** 因「思考吃光输出预算」升级过几次（最多 1 次，避免无上限加大消耗） */
  let budgetRetried = false;
  /** 已试过「去掉 extraBody」重试（只试一次） */
  let droppedExtraBody = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) break;
    if (attempt > 0) {
      const wait = RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      return await attemptChat(
        cfg,
        messages,
        signal,
        useStream ? onToken : undefined,
        { totalMs, idleMs },
        onMeta
      );
    } catch (e) {
      lastErr = e;
      if (e instanceof EmptyStreamError) {
        useStream = false;
        continue;
      }
      // 输出预算被思考吃光：原样重试毫无意义（同一模型同一预算必然同样为空），
      // 必须换参数 —— 关掉思考 + 把预算放大一个量级再试。
      if (e instanceof OutputBudgetError && !budgetRetried && !signal?.aborted) {
        budgetRetried = true;
        cfg = {
          ...cfg,
          maxTokens: Math.max(Math.ceil((cfg.maxTokens || 2048) * 4), 8192),
          extraBody: { ...(cfg.extraBody ?? {}), enable_thinking: false },
        };
        continue;
      }
      // 多塞的 extraBody 字段被网关拒绝（400/422）：去掉它重试，保证
      // 「自动关思考」这个优化永远不会把原本能跑的请求搞挂。
      const status = (e as { status?: number })?.status;
      if (cfg.extraBody && !droppedExtraBody && (status === 400 || status === 422)) {
        droppedExtraBody = true;
        cfg = { ...cfg, extraBody: undefined };
        continue;
      }
      if (e instanceof OutputBudgetError) throw new Error(OUTPUT_BUDGET_MESSAGE);
      if (!(e instanceof RetryableAIError) || signal?.aborted) throw e;
    }
  }
  if (lastErr instanceof OutputBudgetError) throw new Error(OUTPUT_BUDGET_MESSAGE);
  throw lastErr ?? new Error("AI 请求失败：未知错误");
}

export interface RawChatCompletionParams {
  config: AIProviderConfig;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  signal?: AbortSignal;
  /** 流式输出回调 */
  onToken?: (delta: string) => void;
  /** 仅供测试/高级用法：覆盖默认超时（不传则用 REQUEST_TIMEOUT_MS / STREAM_IDLE_TIMEOUT_MS） */
  timeouts?: { totalMs?: number; idleMs?: number };
  /** 请求元信息回调：用于感知「输出被 max_tokens 截断」 */
  onMeta?: (meta: RequestMeta) => void;
}

/**
 * 原始对话接口：完全由调用方控制 messages（用于 Agent 自主执行循环）
 */
export async function chatCompletionRaw(params: RawChatCompletionParams): Promise<string> {
  const { config, messages, signal, onToken, timeouts, onMeta } = params;
  if (!config.apiKey) {
    throw new Error("还未配置 AI API Key，请在上方设置中填写后再试。");
  }
  switch (config.provider) {
    case "anthropic":
      throw new Error("Anthropic 供应商将在后续版本支持，当前请使用 OpenAI 兼容 API。");
    case "custom":
    case "openai":
    default:
      return await requestChat(config, messages, signal, onToken, timeouts, onMeta);
  }
}

async function chatCompletionOpenAI(params: ChatCompletionParams): Promise<ChatCompletionResult> {
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

  // 加入历史：按「字符预算」从最近往前取，而不是固定取 20 条。
  // 固定条数的问题是一条几万字符的命令输出和一句「好的」权重相同，
  // 长对话里很容易把上下文顶爆（表现为请求变慢、被截断、或直接 400）。
  const pickedHistory: OpenAIMessage[] = [];
  let used = 0;
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    const m = chatHistory[i];
    // 跳过空内容（如流式占位消息），避免污染上下文
    if ((m.role !== "user" && m.role !== "assistant") || !m.content.trim()) continue;
    const size = m.content.length;
    if (used + size > MAX_HISTORY_CHARS) break;
    used += size;
    pickedHistory.push({ role: m.role, content: m.content });
  }
  pickedHistory.reverse();
  messages.push(...pickedHistory);
  messages.push({ role: "user", content: userMessage });

  let truncated = false;
  const text = await requestChat(config, messages, signal, onToken, undefined, (meta) => {
    truncated = meta.truncated;
  });
  return { content: text, commands: parseCommandsFromMarkdown(text), truncated };
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
  let truncated = false;
  switch (params.config.provider) {
    case "anthropic":
      // TODO: 实现 Anthropic 适配（提示词格式略不同）
      throw new Error("Anthropic 供应商将在后续版本支持，当前请使用 OpenAI 兼容 API。");
    case "custom":
    case "openai":
    default: {
      const r = await chatCompletionOpenAI(params);
      content = r.content;
      truncated = !!r.truncated;
      break;
    }
  }

  return {
    content,
    commands: parseCommandsFromMarkdown(content),
    truncated,
  };
}
