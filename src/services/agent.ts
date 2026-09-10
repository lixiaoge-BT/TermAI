// =====================================================
// Agent 执行引擎：把 AI 的决策真实下发到终端，并可靠取回输出
// -----------------------------------------------------
// 核心难点：终端是流式 PTY，没有「命令返回值」这回事。
// 这里用哨兵标记（sentinel）包裹命令，从数据流中精确切出
// 「本次命令的输出」与「退出码」，避免把回显、提示符混进来。
// =====================================================

import { subscribeTerminalOutput } from "@/lib/terminalBus";
import { AGENT_RUN_START, AGENT_RUN_END, AGENT_DONE, AGENT_PLAN } from "./prompts";
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
  /**
   * 非空表示本次回复是「计划声明」（<<<PLAN>>>）：run() 据此把它存为任务蓝图并继续，
   * 不会当作命令执行，也不会当作结束。
   */
  plan?: string;
  /**
   * 为真表示「回复里既无 <<<RUN>>> 也无 <<<DONE>>>，是兜底当作结束」——
   * run() 据此把模型的「过渡/解释」性裸文本与真正的任务完成区分开，
   * 避免模型在中间说一句「让我分析一下」就被误判任务结束。
   */
  noMarkerFallback?: boolean;
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

  // 计划声明：优先于命令执行。run() 据此把计划存为任务蓝图并继续，
  // 不会当作命令执行，也不会误判为结束。
  const planIdx = raw.indexOf(AGENT_PLAN);
  if (planIdx !== -1) {
    // 提示词约定 <<<PLAN>>> 既做开头也做结尾标记：剥掉结尾那个多余标记，
    // 避免蓝图文本里混入协议串（会进 UI 计划卡片与后续注入的 pinned 消息）。
    const plan = raw
      .slice(planIdx + AGENT_PLAN.length)
      .trim()
      .replace(new RegExp(`${escapeRegExp(AGENT_PLAN)}\\s*$`), "")
      .trim();
    const before = raw.slice(0, planIdx).trim();
    return { thought: before, commands: [], done: false, finalAnswer: null, raw, plan };
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

  // 兜底 2：当成最终结论（无协议标记，run() 会据此判断是否真的结束）
  return { thought: "", commands: [], done: true, finalAnswer: raw, raw, noMarkerFallback: true };
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
  /** 输出超过缓冲上限被截断（多半是读了二进制 / 命令在死循环刷屏） */
  flooded?: boolean;
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
 * 打断远程仍在运行的前台进程，把 shell 抢回可交互状态。
 *
 * 这是「装软件装到一半之后满屏乱输出」的根因修复：等待循环超时/被中止时，
 * 远端那条命令并没有停（可能是 wget 卡在下载、apt 卡在 [Y/n]、编译还在跑），
 * 它依然占着 PTY 的 stdin。此时本轮后续命令、乃至下一轮 Agent 发下的任何
 * 脚本，都会被它当成输入吞掉 —— 哨兵错位、退出码丢失、输出张冠李戴，
 * 模型拿到一堆互相穿插的残片，只能退化成反复发无关探测命令。
 *
 * 只做两件事：Ctrl+C 中断前台进程，再补一个空回车逼 shell 刷新提示符。
 * 中断失败不影响调用方，异常一律吞掉。
 */
async function abortRemoteCommand(
  w: { __termai_writeTerminal?: (sid: string, data: string) => Promise<boolean> },
  sessionId: string
): Promise<void> {
  try {
    await w.__termai_writeTerminal?.(sessionId, "\x03");
    await sleep(120);
    // Ctrl+C 之后 shell 往往要等下一次回车才回显提示符，补一下确认已恢复
    await w.__termai_writeTerminal?.(sessionId, "\r");
    await sleep(120);
  } catch {
    // 终端已断开等情况下写入会抛错，此时也没有可中断的进程
  }
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
  /**
   * 输出洪水开关。上限按字符而非字节数，够用且和 buffer.length 同口径。
   *
   * 真实故障：`cat /usr/local/bin/prometheus` 把 100MB+ 的 ELF 倒进 PTY ——
   * buffer 一路涨到上百 MB，每 200ms 还要把累积 display 全量推给 UI，
   * 这一步跑了 320 秒、卡在输出超时，整个终端被乱码刷满。
   * 这里做兜底：任何命令（含死循环刷屏、无 head 的 journalctl）一旦超过上限，
   * 立即停止收集并打断远端命令，只保留头尾片段用于判因。
   */
  const MAX_BUFFER_CHARS = 600_000;
  const MAX_DISPLAY_CHARS = 120_000;
  let flooded = false;

  // 结束哨兵必须「独占一行」才算数，详见 makeSentinelMatcher 的说明。
  const matchEnd = makeSentinelMatcher(end);

  const unsub = subscribeTerminalOutput((sid, data) => {
    if (sid !== sessionId) return;
    // 已判定洪水：后续数据一律丢弃（远端会被 wait 循环里的中断尽快掐掉）
    if (flooded) return;
    buffer += data;
    if (buffer.length > MAX_BUFFER_CHARS) {
      flooded = true;
      // 保留头尾：头部能看出是什么命令在刷，尾部可能含着结束哨兵/退出码
      const half = Math.floor(MAX_BUFFER_CHARS / 2);
      buffer =
        buffer.slice(0, half) + "\n…（输出过大，中段已丢弃）…\n" + buffer.slice(-half);
    }
    if (!sawEnd && matchEnd(buffer)) sawEnd = true;

    const now = Date.now();
    if (now - lastFlush >= 200) {
      lastFlush = now;
      // 只清理「本次新增」的片段并拼进累积显示，避免每 200ms 全量扫描整个
      // （可能很大的）buffer —— 那是 O(n²) 的根源，cat 大日志时会卡顿。
      const chunk = buffer.slice(cleanedLen);
      cleanedLen = buffer.length;
      if (chunk) display += stripEcho(chunk, begin);
      // 显示缓冲同样设上限：终端窗口本身有全量输出，这里没必要把上百 MB
      // 反复推给 UI（那是卡顿的直接来源）。
      if (display.length > MAX_DISPLAY_CHARS) {
        const half = Math.floor(MAX_DISPLAY_CHARS / 2);
        display = display.slice(0, half) + "\n…（更早输出已省略）…\n" + display.slice(-half);
      }
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
      // 输出洪水：不再等哨兵，立刻跳出并打断远端命令（否则会一直刷到硬超时）
      if (flooded) break;
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
    // 没能正常收尾（超时 / 用户中止）：远端进程多半还占着 shell 的 stdin。
    // 不把它打断，本轮后续脚本乃至下一轮 Agent 的命令都会被它当输入吞掉，
    // 输出彻底错位 —— 详见 abortRemoteCommand 的说明。
    if (!sawEnd) {
      await abortRemoteCommand(w, sessionId);
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
    return { output: parsed.output, exitCode: parsed.exitCode, timedOut, script, flooded };
  }
  // 兜底：没切到哨兵（脚本回显丢失等极端情况），退化为返回已清理的整段缓冲
  return { output: cleanTerminalText(buffer), exitCode: null, timedOut, script, flooded };
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

/**
 * 生成「哨兵是否已出现」的判定器。
 *
 * 判据是**独占一行**，而不是简单的子串包含 —— PTY 会把整段脚本原样回显回来，
 * 回显里同样含有 `TERMAI_END_xxx` 字样（形如 `echo "TERMAI_END_xxx"`）。
 * 若用 includes 判定，命令还没开始执行就会误认为已结束，循环立刻退出，
 * 慢命令只能拿到残缺输出，且 timedOut=false / exitCode=null 会被上层 isOk()
 * 当成「执行成功」，AI 会基于假成功继续操作远程主机。
 *
 * 返回的判定器内部缓存正则，并先用 includes 做廉价预筛 —— 命中才跑正则，
 * 避免在大 buffer（cat 大日志）上每次输出都全量匹配。
 */
export function makeSentinelMatcher(sentinel: string): (buffer: string) => boolean {
  const re = new RegExp(`(?:^|\\r?\\n)${sentinel}`);
  return (buffer: string) => buffer.includes(sentinel) && re.test(buffer);
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
 * 超长输出聚焦：优先抽取错误/异常行 + 尾部若干行，让 AI 在字符预算内看到
 * 关键失败信息，而不是被开头几 KB 的正常日志淹没（docker build / npm run
 * build 失败时，报错几乎总在结尾）。若输出中没有任何错误关键词，则回退为
 * 原「取前 N 字符」截断，保持向后兼容。
 */
/**
 * 输出清洗：把终端原始输出变成「信息密度高、体量可控」的文本。
 * 终端输出常带 ANSI 颜色/光标控制符、大量空行、以及几万行的日志（cat 大文件、
 * find /、journalctl 全量），直接喂给模型既浪费 token 又淹没关键信息。
 * 只做无损或近无损的收敛：去控制符、压连续空行、超行数时保留头尾、
 * 单行过长时截断。**不改行内内容**，保证模型仍能读到真实错误原文。
 */
// ANSI CSI 序列（颜色/光标控制）。ESC 用运行时拼接：直接写 \x1B 会触发
// eslint 的 no-control-regex，而这类控制符对模型全是噪音，必须剥掉。
const ANSI_CSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[\\x20-\\x2F]*[@-~]`, "g");

export function sanitizeOutput(text: string, maxLines = 80, maxLineLen = 0): string {
  // \r 常见于 PTY 进度条回显；ANSI CSI 序列是颜色/光标控制，对模型全是噪音
  const cleaned = text.replace(/\r/g, "").replace(ANSI_CSI_RE, "");
  let lines = cleaned.split("\n");
  if (maxLineLen > 0) {
    lines = lines.map((l) =>
      l.length > maxLineLen ? `${l.slice(0, maxLineLen)} …（该行过长已截断）` : l
    );
  }
  // 连续空行压成一个，纯空白行直接去掉
  const compact: string[] = [];
  let blank = 0;
  for (const l of lines) {
    if (!l.trim()) {
      blank += 1;
      if (blank > 1) continue;
    } else {
      blank = 0;
    }
    compact.push(l);
  }
  if (compact.length <= maxLines) return compact.join("\n");
  const headN = Math.max(1, Math.floor(maxLines * 0.3));
  const tailN = maxLines - headN;
  const head = compact.slice(0, headN);
  const tail = compact.slice(-tailN);
  return [
    ...head,
    `……（已省略 ${compact.length - headN - tailN} 行中间输出）`,
    ...tail,
  ].join("\n");
}

function focusOutput(text: string, budget: number): string {
  const lines = text.split("\n");
  const KEY_RE =
    /error|fail|exception|refused|denied|not found|cannot|unable|traceback|fatal|warning|no such|permission|could not|abort/i;
  // 错误行也设上限：grep -r / 编译告警这类场景能匹配上千行，全塞进来一样会爆上下文
  const errorLines = Array.from(new Set(lines.filter((l) => KEY_RE.test(l)))).slice(0, 30);
  if (errorLines.length === 0) {
    return text.slice(0, budget);
  }
  const tail = lines.slice(-40);
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const l of [...errorLines, ...tail]) {
    const key = l.trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(l);
  }
  let result = picked.join("\n");
  if (result.length > budget) {
    // 优先保错误行，尾部过长则整体截掉
    result = errorLines.join("\n");
  }
  return result + `\n（已聚焦错误/异常行，原始输出 ${text.length} 字符）`;
}

/**
 * 把执行结果包装成喂给模型的观察（observation）消息。
 * 支持一次传入多条（批量探测），按条数均摊字符预算，避免单条输出吃满上下文。
 */
export function buildObservation(
  entries: Array<{ command: string; result: ExecResult }>,
  maxChars = 6000,
  goal?: string
): string {
  const total = Math.max(1, entries.length);
  const lines: string[] = [
    total > 1
      ? `[系统] 已在终端真实执行 ${entries.length} 条命令，以下是各自结果。`
      : "[系统] 命令已在终端真实执行完毕。",
  ];

  entries.forEach((entry, idx) => {
    const { command, result } = entry;
    const perBudget = Math.max(800, Math.floor(maxChars / total));
    const rawOut = result.output || "(无输出)";
    // 先做无损清洗（控制符/空行/超长日志），再按预算聚焦，避免噪音行挤占预算
    let out = sanitizeOutput(rawOut);
    let truncated = out.length < rawOut.length;
    if (out.length > perBudget) {
      out = focusOutput(out, perBudget);
      truncated = true;
    }
    const exitText = result.exitCode === null ? "未知（未捕获到退出码）" : String(result.exitCode);
    const flags = [
      result.timedOut
        ? "（等待输出超时被强制终止。最常见原因：命令在等待交互输入——如 [Y/n] 确认、密码、配置向导。若是安装/配置类命令，请加非交互参数（-y、DEBIAN_FRONTEND=noninteractive 等）后重发；若是长耗时任务，请改用后台启动 + 轮询日志的方式）"
        : "",
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
      truncated ? `（输出过长已截断，共 ${rawOut.length} 字符）` : ""
    );
  });

  lines.push(
    "",
    "基于以上真实输出决定下一步：还缺信息就用 <<<RUN>>> 给命令（只读无依赖的可批量一次给）；已达成目标用 <<<DONE>>> 给总结。"
  );
  if (goal) lines.push(`目标：${goal}`);
  return lines.join("\n");
}
