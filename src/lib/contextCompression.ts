// =====================================================
// Agent 上下文压缩（纯函数，可单测）
// -----------------------------------------------------
// 长任务里每轮都回传完整观察，messages 会持续膨胀。压缩的目标不是「变短」，
// 而是「保留后续步骤仍然依赖的事实」。之前是自由文本摘要，实测有几个坑：
//   1. 触发只看消息条数 —— 一条超大工具输出和一句"好的"权重一样；
//   2. 自由文本摘要 —— 关键路径/端口/错误码容易在改写中丢失；
//   3. 二次压缩时把上一轮摘要当普通消息再压一遍 —— 信息逐轮衰减；
//   4. 原始任务目标会被压掉 —— 模型跑到后面忘了要干什么；
//   5. 摘要可能比原文还长 —— 白花一次调用。
// 这里针对这五点逐一处理。
// =====================================================

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** 压缩摘要消息的固定前缀，用于在 messages 里识别/复用上一轮摘要 */
export const SUMMARY_MARKER = "【历史上下文摘要】";

/** 摘要目标长度（字符）。超过会被截断，避免摘要本身膨胀成新的负担。 */
export const SUMMARY_MAX_CHARS = 2200;

/** 单条消息进入压缩输入时的长度上限，超出则头尾保留、中间省略 */
const TRANSCRIPT_MAX_PER_MESSAGE = 1600;

/** 每条消息的结构开销（role / 分隔符等） */
const PER_MESSAGE_OVERHEAD = 4;

// ---------------- token 估算 ----------------

// 中日韩字符按 ~1.5 token/字 估，其余按 4 字符 1 token。
// 只用于「要不要压缩」的相对判断，不追求精确。
const CJK_RE = /[㐀-䶿一-鿿぀-ヿ가-힯]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const rest = text.length - cjk;
  return Math.ceil(cjk * 1.5 + rest / 4);
}

export function estimateMessagesTokens(messages: Pick<ChatMessage, "content">[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + PER_MESSAGE_OVERHEAD, 0);
}

/**
 * 是否需要压缩：条数或估算 token 任一超阈值即触发。
 * 双条件是因为「条数少但每条都很长」同样会撑爆上下文。
 */
export function shouldCompress(
  messages: ChatMessage[],
  opts: { maxMessages: number; maxTokens: number }
): boolean {
  // 至少要有 system + 一轮对话才谈得上压缩。
  // 注意这里不能用较大的条数下限：否则「只有 2~3 条但每条都是超大工具输出」
  // 的场景会被整条 token 触发挡在门外，而那正是最该压缩的情况。
  if (messages.length < 3) return false;
  return (
    messages.length >= opts.maxMessages ||
    estimateMessagesTokens(messages) > opts.maxTokens
  );
}

// ---------------- 摘要识别 ----------------

export function isSummaryMessage(msg: ChatMessage): boolean {
  return msg.role === "assistant" && msg.content.startsWith(SUMMARY_MARKER);
}

/** 去掉标记前缀，拿到纯摘要正文（用于喂给下一轮压缩做滚动合并） */
export function extractSummary(msg: ChatMessage): string {
  if (!isSummaryMessage(msg)) return "";
  return msg.content.slice(SUMMARY_MARKER.length).replace(/^\s*\n/, "").trim();
}

/** 摘要过长时截断，末尾补一句提示，避免静默丢信息 */
export function clampSummary(summary: string, max: number = SUMMARY_MAX_CHARS): string {
  const text = summary.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（摘要超长已截断）`;
}

// ---------------- 压缩输入构造 ----------------

/**
 * 把待压缩的消息渲染成文本。单条过长时保留头尾（命令在头、结果/报错在尾），
 * 中间省略 —— 比单纯截断更能保住关键信息，也控制住压缩调用本身的成本。
 */
export function renderTranscript(
  messages: ChatMessage[],
  maxPerMessage: number = TRANSCRIPT_MAX_PER_MESSAGE
): string {
  return messages
    .map((m) => {
      const body = m.content ?? "";
      if (body.length <= maxPerMessage) return `### ${m.role}\n${body}`;
      const head = Math.floor(maxPerMessage * 0.6);
      const tail = Math.floor(maxPerMessage * 0.4);
      const omitted = body.length - head - tail;
      return `### ${m.role}\n${body.slice(0, head)}\n…（省略 ${omitted} 字符）…\n${body.slice(-tail)}`;
    })
    .join("\n\n");
}

const COMPRESSION_SYSTEM_PROMPT = `You are a context compression assistant for a terminal agent.
Merge the previous summary (if any) with the new transcript into ONE updated summary.

Rules:
- Output ONLY the summary. No preamble, no code fences, no commentary.
- Use EXACTLY these headings, in this order:
## 任务目标
## 已完成步骤
## 关键事实
## 错误与解决
## 当前状态
## 待办
- 已完成步骤: each executed command with its short outcome (exit code or one-line result). Keep commands EXACT — never paraphrase shell syntax, flags, or paths.
- 关键事实: concrete values later steps depend on — absolute file paths, ports, IPs, hostnames, versions, package names, users, PIDs, config values, URLs.
- 错误与解决: command + exact error message + whether resolved. Keep UNRESOLVED errors prominent and explicit.
- 当前状态: what is true right now (services running, files modified, current directory, installed versions).
- 待办: what remains to reach the goal.
- Merge carefully: carry forward previous-summary facts that are still relevant; drop facts that were superseded.
- Be dense and factual. Aim for roughly 600-900 characters. Never invent information absent from the transcript.
- Keep the same language as the transcript.`;

/**
 * 构造压缩请求。previousSummary 存在时走「滚动合并」分支，
 * 避免把上一轮摘要当普通消息再压一遍导致信息逐轮衰减。
 */
export function buildCompressionMessages(input: {
  goal: string;
  previousSummary?: string;
  transcript: string;
}): ChatMessage[] {
  const parts: string[] = [];
  parts.push(`[任务目标]\n${input.goal || "（未提供）"}`);
  parts.push(`[上一轮摘要]\n${input.previousSummary?.trim() ? input.previousSummary : "（无，这是首次压缩）"}`);
  parts.push(`[新增对话记录]\n${input.transcript}`);
  return [
    { role: "system", content: COMPRESSION_SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n\n") },
  ];
}

// ---------------- 压缩结果装配 ----------------

/**
 * 组装压缩后的 messages：
 * system + 摘要 + 原始目标 + 最近若干轮。
 *
 * 目标单独固定插入（不参与压缩）—— 否则模型跑到十几轮后容易忘了最初要干什么。
 * 若目标已经在 recent 里（任务刚开始时），则不重复插入。
 */
export function assembleCompressedMessages(input: {
  system: ChatMessage;
  goal?: string;
  summary: string;
  recent: ChatMessage[];
}): ChatMessage[] {
  const out: ChatMessage[] = [input.system];
  const summary = clampSummary(input.summary);
  if (summary) {
    out.push({ role: "assistant", content: `${SUMMARY_MARKER}\n${summary}` });
  }
  const goal = input.goal?.trim();
  if (goal) {
    // 按内容去重（不限 role）：目标文本若已在最近轮里出现过就不重复插入，
    // 否则同一句话会被塞两遍、白白占上下文。
    if (!input.recent.some((m) => m.content === goal)) {
      out.push({ role: "user", content: goal });
    }
  }
  out.push(...input.recent);
  return out;
}

/**
 * 硬截断兜底：压缩失败或摘要不给力时使用。保留 system + 目标 + 最近若干轮。
 */
export function trimMessages(
  messages: ChatMessage[],
  keepRecent: number,
  goal?: string
): ChatMessage[] {
  const system = messages[0];
  const recent = messages.slice(-keepRecent);
  const out: ChatMessage[] = [system];
  const g = goal?.trim();
  if (g && !recent.some((m) => m.content === g)) {
    out.push({ role: "user", content: g });
  }
  out.push(...recent);
  return out;
}
