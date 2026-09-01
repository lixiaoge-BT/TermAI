// =====================================================
// Agent 执行引擎：把 AI 的决策真实下发到终端，并可靠取回输出
// -----------------------------------------------------
// 核心难点：终端是流式 PTY，没有「命令返回值」这回事。
// 这里用哨兵标记（sentinel）包裹命令，从数据流中精确切出
// 「本次命令的输出」与「退出码」，避免把回显、提示符混进来。
// =====================================================

import { subscribeTerminalOutput } from "@/lib/terminalBus";
import { AGENT_RUN_START, AGENT_RUN_END, AGENT_DONE } from "./prompts";
import { useTerminalStore } from "@/store/terminal";

export { AGENT_RUN_START, AGENT_RUN_END, AGENT_DONE };

export interface AgentReply {
  /** 命令/结论之前的思考说明 */
  thought: string;
  /**
   * 本次要执行的命令。批量探测时会有多条（彼此无依赖的只读命令），
   * 引擎按顺序全部执行后一次性回传，以此把多次 AI 往返压缩成一次。
   */
  commands: string[];
  /** 是否结束 */
  done: boolean;
  /** 结束时的最终总结 */
  finalAnswer: string | null;
  raw: string;
}

/** 把 <<<RUN>>> 块里的多行内容拆成命令列表（容忍模型自作主张加的序号/列表符号） */
export function splitCommandBlock(block: string): string[] {
  return block
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.replace(/^\s*(?:\d+[.)、]|[-*•])\s*/, "").trim())
    .filter(Boolean);
}

/**
 * 解析 Agent 的回复，严格遵循 <<<RUN>>> / <<<DONE>>> 协议。
 * 若模型没按协议输出（常见），则退化为「整段就是最终结论」，避免死循环。
 */
export function parseAgentReply(text: string): AgentReply {
  const raw = (text ?? "").trim();

  const doneIdx = raw.indexOf(AGENT_DONE);
  if (doneIdx !== -1) {
    const after = raw.slice(doneIdx + AGENT_DONE.length).trim();
    const before = raw.slice(0, doneIdx).trim();
    // 兼容：模型可能在 <<<DONE>>> 之前先给了命令，则命令作废，以结论为准
    return {
      thought: before,
      commands: [],
      done: true,
      finalAnswer: after || before || raw,
      raw,
    };
  }

  const runRegex = new RegExp(
    `${escapeRegExp(AGENT_RUN_START)}([\\s\\S]*?)${escapeRegExp(AGENT_RUN_END)}`
  );
  const m = raw.match(runRegex);
  if (m) {
    const commands = splitCommandBlock(m[1] ?? "");
    const before = raw.slice(0, m.index ?? 0).trim();
    if (commands.length > 0) {
      return { thought: before, commands, done: false, finalAnswer: null, raw };
    }
  }

  // 兜底 1：只写了开标记没写闭标记
  const looseIdx = raw.indexOf(AGENT_RUN_START);
  if (looseIdx !== -1) {
    const commands = splitCommandBlock(raw.slice(looseIdx + AGENT_RUN_START.length));
    if (commands.length > 0) {
      return { thought: "", commands, done: false, finalAnswer: null, raw };
    }
  }

  // 兜底 2：当成最终结论
  return { thought: "", commands: [], done: true, finalAnswer: raw, raw };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ExecResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  /** 发给终端的完整脚本（含哨兵），用于在 UI 上说明真实执行了什么 */
  script: string;
  /** 执行本身抛异常时的错误信息（区别于命令返回非 0） */
  error?: string;
}

export interface ExecOptions {
  /** 基础超时（默认 20s）。超时后若仍在持续产生输出，会自动延长 */
  timeoutMs?: number;
  /** 硬上限（默认 60s），无论如何到此为止 */
  maxTimeoutMs?: number;
  signal?: AbortSignal;
  /** 实时输出回调（已清理 ANSI，供 UI 流式展示） */
  onOutput?: (output: string) => void;
}

/** 多行命令折叠成单行（AI 偶尔会输出多行命令/脚本） */
export function flattenCommand(cmd: string): string {
  const lines = cmd
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\\\s*$/, "").trim())
    .filter(Boolean);
  if (lines.length <= 1) return lines[0] ?? "";

  let out = lines[0];
  for (let i = 1; i < lines.length; i++) {
    const prev = out.trimEnd();
    const line = lines[i];
    // 上一行以连接符结尾，或当前行是控制关键字 → 直接空格拼接，否则用 ; 分隔
    if (/(&&|\|\||\||;|&)$/.test(prev) || /^(}|\)|\{|then|do|else|elif|fi|done|esac)\b/.test(line)) {
      out = `${prev} ${line}`;
    } else {
      out = `${prev} ; ${line}`;
    }
  }
  return out;
}

/**
 * 在终端里执行一条命令，并返回它的输出与退出码。
 *
 * 实现要点：
 * - 用 echo 打上 BEGIN/EXIT/END 三个唯一哨兵，从数据流中精确切分
 * - BEGIN/END 的匹配要求「独占一行」，从而跳过 PTY 对整条脚本的回显
 * - 支持 heredoc / 多行脚本：落盘为临时脚本再执行，结束后自动清理
 * - 超时或中断时，退化为返回已收集到的全部输出
 */
export async function execCommand(
  sessionId: string,
  command: string,
  opts: ExecOptions = {}
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const maxTimeoutMs = Math.max(opts.maxTimeoutMs ?? 60000, timeoutMs);
  const token = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const begin = `TERMAI_BEGIN_${token}`;
  const end = `TERMAI_END_${token}`;
  const exitTag = `TERMAI_EXIT_${token}`;

  const flat = flattenCommand(command);
  const needsTempScript = /<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(command);

  let script: string;
  if (needsTempScript && command.includes("\n")) {
    const path = `/tmp/termai_agent_${token}.sh`;
    script = [
      `cat > ${path} <<'TERMAI_AGENT_EOF'`,
      command.trim(),
      `TERMAI_AGENT_EOF`,
      `echo "${begin}"`,
      `bash ${path} 2>&1`,
      `echo "${exitTag}:$?"`,
      `echo "${end}"`,
      `rm -f ${path}`,
    ].join("\n");
  } else {
    script = `echo "${begin}"; ${flat} 2>&1; echo "${exitTag}:$?"; echo "${end}"`;
  }

  let buffer = "";
  let display = ""; // 已清理并推送的累积显示文本
  let sawEnd = false;
  let lastFlush = 0;
  let cleanedLen = 0; // 已清理过的 buffer 长度，下次只扫增量

  const unsub = subscribeTerminalOutput((sid, data) => {
    if (sid !== sessionId) return;
    buffer += data;
    if (buffer.includes(end)) sawEnd = true;

    const now = Date.now();
    if (now - lastFlush >= 200) {
      lastFlush = now;
      // 只清理「本次新增」的片段并拼进累积显示，避免每 200ms 全量扫描整个
      // （可能很大的）buffer —— 那是 O(n²) 的根源，cat 大日志时会卡顿。
      const chunk = buffer.slice(cleanedLen);
      cleanedLen = buffer.length;
      if (chunk) display += stripEcho(chunk, begin);
      opts.onOutput?.(display);
    }
  });

  try {
    const w = window as unknown as {
      __termai_writeTerminal?: (sid: string, data: string) => Promise<boolean>;
    };

    // 下发前先确认终端仍然在线：若连接中途断开，直接报错而非傻等 60s 硬超时
    const session = useTerminalStore.getState().sessions.find((s) => s.id === sessionId);
    if (!session?.connected) {
      throw new Error("终端已断开连接，无法执行命令");
    }

    // PTY 里「回车」是 \r，把脚本里的换行统一转成 \r，等价于逐行敲回车
    const payload = script.replace(/\r?\n/g, "\r") + "\r";
    const wrote = (await w.__termai_writeTerminal?.(sessionId, payload)) ?? false;
    if (!wrote) {
      throw new Error("命令下发失败：终端未就绪或已断开");
    }

    // 等待输出收尾。两条优化：
    // 1) 轮询从 120ms 降到 60ms，命令结束后能更快被感知
    // 2) 超时自适应：超过基础超时后，只要「最近 3 秒仍有新数据」就继续等，
    //    直到硬上限。find / du 这类慢命令不会被硬切成半截输出误导 AI 判断。
    const startedAt = Date.now();
    let lastDataAt = startedAt;
    let lastLen = 0;

    while (!sawEnd) {
      if (opts.signal?.aborted) break;
      const now = Date.now();
      const elapsed = now - startedAt;
      if (elapsed >= maxTimeoutMs) break;
      if (elapsed >= timeoutMs && now - lastDataAt >= 3000) break;
      await sleep(60);
      if (buffer.length !== lastLen) {
        lastLen = buffer.length;
        lastDataAt = Date.now();
      }
    }
    // 收到结束标记后只需极短缓冲（END 是最后一条输出，后面只剩提示符）
    await sleep(sawEnd ? 80 : 150);
  } finally {
    unsub();
  }

  const timedOut = !sawEnd;
  // 收尾时基于完整 buffer 再清理一次，消除增量拼接可能残留的哨兵边界碎片
  opts.onOutput?.(stripEcho(buffer, begin));

  const parsed = extractResult(buffer, begin, end, exitTag);
  if (parsed) {
    return { output: parsed.output, exitCode: parsed.exitCode, timedOut, script };
  }
  // 兜底：没切到哨兵（脚本回显丢失等极端情况），退化为返回已清理的整段缓冲
  return { output: cleanTerminalText(buffer), exitCode: null, timedOut, script };
}

export interface BatchExecOptions extends ExecOptions {
  /** 某条命令开始执行 */
  onItemStart?: (index: number) => void;
  /** 某条命令的实时输出 */
  onItemOutput?: (index: number, output: string) => void;
  /** 某条命令结束（成功或失败都会回调） */
  onItemDone?: (index: number, result: ExecResult) => void;
}

/**
 * 批量执行一批命令（按顺序串行，避免输出在终端里交织导致哨兵失效），
 * 全部完成后一次性返回。用于把「多次 AI 往返的只读探测」压缩成一次。
 */
export async function execCommandBatch(
  sessionId: string,
  commands: string[],
  opts: BatchExecOptions = {}
): Promise<ExecResult[]> {
  const results: ExecResult[] = [];
  for (let i = 0; i < commands.length; i++) {
    if (opts.signal?.aborted) break;
    const cmd = commands[i];
    opts.onItemStart?.(i);
    try {
      const res = await execCommand(sessionId, cmd, {
        timeoutMs: opts.timeoutMs,
        maxTimeoutMs: opts.maxTimeoutMs,
        signal: opts.signal,
        onOutput: (out) => opts.onItemOutput?.(i, out),
      });
      results.push(res);
      opts.onItemDone?.(i, res);
    } catch (e) {
      const failed: ExecResult = {
        output: "",
        exitCode: null,
        timedOut: false,
        script: cmd,
        error: (e as Error)?.message ?? String(e),
      };
      results.push(failed);
      opts.onItemDone?.(i, failed);
    }
  }
  return results;
}

/** 从缓冲区里切出 BEGIN..END 之间的真实输出，并解析退出码 */
function extractResult(
  buffer: string,
  begin: string,
  end: string,
  exitTag: string
): { output: string; exitCode: number | null } | null {
  // 要求哨兵独占一行：避免匹配到 PTY 回显的 `echo "TERMAI_BEGIN_xxx"; ...`
  const beginRe = new RegExp(`(?:^|\\r?\\n)${begin}\\r?\\n`);
  const bm = buffer.match(beginRe);
  if (!bm || bm.index === undefined) return null;

  let rest = buffer.slice(bm.index + bm[0].length);

  const endRe = new RegExp(`(?:^|\\r?\\n)${end}`);
  const em = rest.match(endRe);
  if (em && em.index !== undefined) {
    rest = rest.slice(0, em.index);
  }

  let exitCode: number | null = null;
  const exitRe = new RegExp(`${exitTag}:(\\d+)`);
  const xm = rest.match(exitRe);
  if (xm) {
    exitCode = Number(xm[1]);
    rest = rest.replace(exitRe, "");
  }

  return { output: cleanTerminalText(rest), exitCode };
}

/** 去掉 PTY 对脚本自身的回显、清理控制符 */
function stripEcho(buffer: string, begin: string): string {
  const lines = buffer.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (line.includes('echo "TERMAI_BEGIN_')) continue;
    if (line.includes('echo "TERMAI_END_')) continue;
    if (line.includes('echo "TERMAI_EXIT_')) continue;
    if (line.includes("TERMAI_AGENT_EOF")) continue;
    kept.push(line);
  }
  const text = cleanTerminalText(kept.join("\n"));
  // 极端情况下 BEGIN 标记泄漏到展示里，顺手清掉
  return text.split(begin).join("").trim();
}

function cleanTerminalText(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把执行结果包装成喂给模型的观察（observation）消息。
 * 支持一次传入多条（批量探测），按条数均摊字符预算，避免单条输出吃满上下文。
 */
export function buildObservation(
  entries: Array<{ command: string; result: ExecResult }>,
  maxChars = 6000
): string {
  const total = Math.max(1, entries.length);
  const lines: string[] = [
    total > 1
      ? `[系统] 已在终端真实执行 ${entries.length} 条命令，以下是各自的结果。`
      : "[系统] 命令已在终端真实执行完毕。",
  ];

  entries.forEach((entry, idx) => {
    const { command, result } = entry;
    const perBudget = Math.max(800, Math.floor(maxChars / total));
    let out = result.output || "(无输出)";
    let truncated = false;
    if (out.length > perBudget) {
      out = out.slice(0, perBudget);
      truncated = true;
    }
    const exitText = result.exitCode === null ? "未知（未捕获到退出码）" : String(result.exitCode);
    const flags = [
      result.timedOut ? "（等待输出超时，结果可能不完整）" : "",
      result.error ? ` 执行异常：${result.error}` : "",
    ].join("");

    lines.push(
      "",
      total > 1 ? `### ${idx + 1}. \`${command}\`` : `命令：\`${command}\``,
      `退出码：${exitText}${flags}`,
      "输出：",
      "```",
      out,
      "```",
      truncated ? `（输出过长已截断，共 ${result.output.length} 字符）` : ""
    );
  });

  lines.push(
    "",
    "请基于以上真实输出决定下一步：还需要信息就继续用 <<<RUN>>> 给出命令（彼此无依赖的只读命令请批量一次给出）；信息足够就用 <<<DONE>>> 给出最终总结。"
  );
  return lines.join("\n");
}
