/**
 * argv 调试日志 —— 把每次启动 / 二次唤起时 TermAI 实际收到的命令行参数，
 * 以及解析结果（成功/失败/原因），写到本地日志文件。
 *
 * 堡垒机 H5 配置 Xshell 路径替换为 TermAI.exe 后，
 * 各堡垒机厂商（齐治 / 安恒 / 碉堡 / 行云 等）spawn TermAI 的命令行五花八门，
 * 单看代码无法 100% 推断用户用的是哪种格式。
 *
 * 让用户把日志贴回来，立刻能看出：
 *   1) 堡垒机到底传没传参数（如果 argv 只有 exe 自身路径，说明堡垒机没传）
 *   2) 传的是什么格式（-url ssh:// / -ssh user@host / .xsh 文件 / 其它）
 *   3) 我们的 parser 解析结果（命中 / 没命中 / 为什么没命中）
 *
 * 日志路径（不可改写，便于用户定位）：
 *   - 生产:   %APPDATA%/TermAI/logs/argv-debug.log
 *   - 开发:   <cwd>/logs/argv-debug.log
 */

import { appendFileSync, copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/** 单文件上限，超过则把旧内容转存到 argv-debug.old.log 后重新开始（约 1MB ≈ 数千条记录） */
const MAX_LOG_BYTES = 1_000_000;

let logDir: string | null = null;

function getLogDir(): string {
  if (logDir) return logDir;
  // app.getPath('logs') 在 Electron 主进程可用；dev 模式可能还没 ready，
  // 用 cwd 兜底（确保 npm start 时日志也能落盘）。
  try {
    if (app && typeof app.getPath === "function") {
      logDir = app.getPath("logs");
    }
  } catch {
    /* ignore */
  }
  if (!logDir) {
    logDir = join(process.cwd(), "logs");
  }
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    /* ignore */
  }
  return logDir;
}

function logPath(): string {
  return join(getLogDir(), "argv-debug.log");
}

function ts(): string {
  // 本地时间，YYYY-MM-DD HH:MM:SS.mmm，方便排查
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

/**
 * 日志轮转：超过上限就把当前内容转存到 argv-debug.old.log，当前文件重新开始。
 * 只保留一份备份（这是纯调试设施，不需要多级归档）。
 * 每个进程只检查一次，避免每次写日志都 stat。
 */
let rotated = false;
function rotateIfNeeded(): void {
  if (rotated) return;
  rotated = true;
  const p = logPath();
  try {
    const st = statSync(p);
    if (st.size < MAX_LOG_BYTES) return;
    const old = join(getLogDir(), "argv-debug.old.log");
    // copyFileSync 可覆盖已存在的备份；Windows 下 renameSync 遇到同名文件会失败
    copyFileSync(p, old);
    writeFileSync(
      p,
      `[${ts()}] [rotate] 日志超过 ${MAX_LOG_BYTES} 字节，旧内容已转存至 argv-debug.old.log\n`,
      "utf8"
    );
  } catch {
    // 文件还不存在 / 无权限：都不影响主流程
  }
}

function writeLine(line: string) {
  const p = logPath();
  try {
    rotateIfNeeded();
    appendFileSync(p, line + "\n", "utf8");
  } catch (e) {
    // 日志失败不能阻塞主流程，console 兜底
    console.error("[argv-debug] 日志写入失败:", (e as Error).message);
  }
}

/**
 * 记录「启动期 argv + 解析结果」。
 * @param argv process.argv（或 second-instance 提供的 argv）
 * @param entry 来源: 'first-instance' | 'second-instance' | 'open-url'
 * @param parsed 解析到的参数对象（null 表示没解析到）
 */
export function logArgvEntry(
  argv: string[],
  entry: "first-instance" | "second-instance" | "open-url",
  parsed: unknown
): void {
  // 密码脱敏：argv 里的明文密码写到日志前替换成 '***'，避免泄露。
  // 需要覆盖两种形态：
  //   1) 内联在 URL 里:   ssh://user:pass@host
  //   2) 独立 token 形式: -pw xxx / --password xxx / -w xxx / --pw=xxx
  const PW_FLAGS = new Set(["-pw", "--pw", "-password", "--password", "-w", "-pass", "--pass"]);
  // 按值脱敏：Electron 的 second-instance 会重排 argv（开关提前、值拆到末尾），
  // 「紧跟 -pw 的下一个 token」这条规则会失效，密码会以明文位置参数的形式漏出来。
  // 这里改用解析结果反查：任何与该密码值完全相等的 token 一律打码，与位置无关。
  const pwRaw = (parsed as { password?: unknown } | null | undefined)?.password;
  const pwValue = typeof pwRaw === "string" && pwRaw.length > 0 ? pwRaw : null;

  const safeArgv = argv.map((t, i) => {
    if (typeof t !== "string") return t;
    // 优先级最高：按值命中（覆盖 argv 重排）
    if (pwValue && t === pwValue) return "***";
    // 形态 2a: 前一个 token 是密码 flag → 整个 token 打码
    if (i > 0 && PW_FLAGS.has(String(argv[i - 1]).toLowerCase())) return "***";
    // 形态 2b: --password=xxx / -pw=xxx 内联等号形式
    const eq = t.match(/^(--?-?[a-z]*(?:pw|password|pass)[a-z]*)=(.+)$/i);
    if (eq) return `${eq[1]}***`;
    // 形态 1: ssh://user:pass@host
    return t.replace(
      /((?:ssh|telnet):\/\/[^:/?#@]+:)([^@]+)(@[^/?#]+)/i,
      (_m, p1, _p2, p3) => `${p1}***${p3}`
    );
  });

  // parsed.password / privateKey 也不打明文
  const safeParsed = parsed && typeof parsed === "object"
    ? {
        ...(parsed as Record<string, unknown>),
        password: (parsed as Record<string, unknown>).password ? "***" : (parsed as Record<string, unknown>).password,
        privateKey: (parsed as Record<string, unknown>).privateKey ? "***(<key>)" : (parsed as Record<string, unknown>).privateKey,
      }
    : parsed;

  writeLine(
    `[${ts()}] entry=${entry} argv.length=${argv.length}\n` +
      `  argv = ${JSON.stringify(safeArgv)}\n` +
      `  parsed = ${JSON.stringify(safeParsed)}`
  );
}

/** 记录「无参数唤起」的快速诊断（用于排查堡垒机是不是根本没传参） */
export function logEmptyArgvNotice(): void {
  writeLine(`[${ts()}] [warn] 启动/唤起时未携带任何外部跳转参数。\n` +
    `  这通常意味着：堡垒机 spawn TermAI 时只传了 exe 路径，没有附加 -url / -ssh / .xsh 之类的连接信息。\n` +
    `  请检查堡垒机的「外部客户端配置」是否同时配置了「命令行模板」或「额外参数」字段，\n` +
    `  或者改用 termai://connect?host=...&user=... 自定义协议唤起。`);
}