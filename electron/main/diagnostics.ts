/**
 * 崩溃与退出取证 —— 唯一目标是「出事后有据可查」。
 *
 * 背景（2026-11-06 排查）：
 *   打包版在 `app.isPackaged` 时把 console.log/debug/info 全部 noop，
 *   而 GUI 进程没有 stdout，等于所有运行期日志都被丢进黑洞。
 *   结果是「软件直接退出」时现场为零：既没有主进程异常，也没有渲染进程
 *   crash 原因，Windows 事件日志里又只有安装器的记录 —— 无法定位。
 *
 * 这里补齐三类证据，全部落到 <userData>/logs/：
 *   crash.log    —— 未捕获异常 / 渲染进程 gone / 子进程 gone / 退出链路
 *   mem.log      —— 定期内存采样（判断是不是 OOM 被杀）
 *   Crashpad/    —— crashReporter 生成的 minidump（可拿 dmp 分析原生栈）
 *
 * 设计原则：
 *   1) 日志写入绝不影响主流程（全部 try/catch 吞掉）
 *   2) 单文件滚动，避免无限增长
 *   3) 只记状态与栈，不记用户凭据
 */

import { crashReporter, app, dialog, BrowserWindow } from "electron";
import { appendFileSync, copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_LOG_BYTES = 1_000_000; // 1MB
const MEM_SAMPLE_MS = 30_000;

let logDir: string | null = null;

function getLogDir(): string {
  if (logDir) return logDir;
  try {
    logDir = app.getPath("logs");
  } catch {
    logDir = join(process.cwd(), "logs");
  }
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    /* ignore */
  }
  return logDir;
}

function ts(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

/** 每个日志文件每进程只轮转一次 */
const rotated = new Set<string>();

function append(file: string, text: string): void {
  const p = join(getLogDir(), file);
  try {
    if (!rotated.has(file)) {
      rotated.add(file);
      try {
        if (statSync(p).size >= MAX_LOG_BYTES) {
          copyFileSync(p, p.replace(/\.log$/, ".old.log"));
          writeFileSync(p, "", "utf8");
        }
      } catch {
        /* 文件还不存在 */
      }
    }
    appendFileSync(p, text.endsWith("\n") ? text : text + "\n", "utf8");
  } catch {
    /* 日志失败绝不能影响主流程 */
  }
}

/** 崩溃取证主日志 */
export function crashLog(tag: string, detail?: unknown): void {
  let body = "";
  if (detail !== undefined) {
    if (detail instanceof Error) {
      body = `\n  message: ${detail.message}\n  stack:\n${indent(detail.stack || "(无栈)")}`;
    } else if (typeof detail === "string") {
      body = `\n  ${detail.replace(/\n/g, "\n  ")}`;
    } else {
      try {
        body = `\n  ${JSON.stringify(detail)}`;
      } catch {
        body = `\n  ${String(detail)}`;
      }
    }
  }
  append("crash.log", `[${ts()}] ${tag}${body}`);
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => "    " + l)
    .join("\n");
}

function mb(n: number): string {
  return (n / 1024 / 1024).toFixed(1) + "MB";
}

/** 当前主进程内存快照（判断 OOM 的关键指标） */
export function memSnapshot(): string {
  const m = process.memoryUsage();
  return `rss=${mb(m.rss)} heapUsed=${mb(m.heapUsed)} heapTotal=${mb(m.heapTotal)} external=${mb(m.external)}`;
}

let memTimer: NodeJS.Timeout | null = null;

/**
 * 启用崩溃取证。必须在 app ready 之前调用（crashReporter.start 越早越好，
 * 否则早期崩溃产生的 dmp 可能不被接管）。
 */
export function installDiagnostics(): void {
  // ── 1. 原生崩溃 minidump ───────────────────────────────────────────────
  // uploadToServer:false → 只落本地 Crashpad/reports，不外发。
  try {
    crashReporter.start({
      productName: "TermAI",
      companyName: "TermAI",
      submitURL: "https://termai.invalid/crash-report", // 不上传，仅占位
      uploadToServer: false,
      compress: true,
      rateLimit: false,
      ignoreSystemCrashHandler: false,
    });
    crashLog("diag: crashReporter 已启动", { crashDumps: app.getPath("crashDumps") });
  } catch (e) {
    crashLog("diag: crashReporter 启动失败", e);
  }

  // ── 2. 启动基线：版本 / pid / 内存 / 启动参数 ───────────────────────────
  crashLog("diag: 进程启动", {
    pid: process.pid,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    packaged: app.isPackaged,
    exe: process.execPath,
    argv: process.argv.slice(1),
    mem: memSnapshot(),
  });

  // ── 3. 主进程未捕获异常 ────────────────────────────────────────────────
  // 注意：这里**不要**每次都弹窗。原实现每个异常都 showErrorBox —— 一旦某个
  // 高频回调持续抛错，模态框会连弹、主进程看起来像「卡死/退出」。
  let errorBoxShown = false;
  process.on("uncaughtException", (err) => {
    crashLog("❌ uncaughtException", err);
    if (errorBoxShown) {
      crashLog("diag: 已弹过错误框，后续异常只记日志");
      return;
    }
    errorBoxShown = true;
    try {
      // 延迟到 app ready 之后再弹，ready 之前弹窗在部分场景下不可见
      const show = () => {
        try {
          dialog.showErrorBox(
            "TermAI 遇到内部错误",
            `${err?.message || String(err)}\n\n错误详情已写入日志：\n${join(getLogDir(), "crash.log")}`
          );
        } catch {
          /* 弹窗失败忽略 */
        }
      };
      if (app.isReady()) setTimeout(show, 0);
      else app.once("ready", () => setTimeout(show, 0));
    } catch {
      /* ignore */
    }
  });

  process.on("unhandledRejection", (reason) => {
    crashLog("❌ unhandledRejection", reason instanceof Error ? reason : String(reason));
  });

  // ── 4. 退出链路：谁让进程退出 ───────────────────────────────────────────
  // 这是本次排查的核心诉求 —— 区分「自己退」还是「被杀」。
  const noteWindows = (evt: string) => () => {
    crashLog(`diag: ${evt}`, { windows: BrowserWindow.getAllWindows().length, mem: memSnapshot() });
  };
  app.on("before-quit", noteWindows("before-quit"));
  app.on("will-quit", noteWindows("will-quit"));
  // Electron 的类型声明里没有 Windows 专属的 session-end（运行时确实存在）
  // @ts-expect-error session-end 未出现在 app 的事件重载中
  app.on("session-end", noteWindows("session-end"));
  app.on("window-all-closed", () => {
    crashLog("diag: window-all-closed", { mem: memSnapshot() });
  });
  app.on("child-process-gone", (_e, details) => {
    crashLog("💥 child-process-gone", {
      type: details.type, // GPU / Utility / Network ...
      reason: details.reason,
      exitCode: details.exitCode,
      name: details.name,
      serviceName: details.serviceName,
    });
  });
  app.on("quit", (_e, exitCode) => {
    crashLog("diag: 进程退出", { exitCode, uptimeSec: Math.round(process.uptime()) });
  });

  // 记录 app.quit() 的调用栈（能直接看出是谁主动退出的）
  try {
    const origQuit = app.quit.bind(app);
    app.quit = function patchedQuit() {
      crashLog("diag: app.quit() 被调用", new Error("quit-caller"));
      return origQuit();
    };
  } catch (e) {
    crashLog("diag: 无法挂钩 app.quit", e);
  }

  // ── 5. 内存采样 ────────────────────────────────────────────────────────
  if (memTimer) clearInterval(memTimer);
  memTimer = setInterval(() => {
    append("mem.log", `[${ts()}] ${memSnapshot()}`);
  }, MEM_SAMPLE_MS);
  // 不要 unref：进程退出前保持采样；will-quit 里会清掉
  app.on("will-quit", () => {
    if (memTimer) {
      clearInterval(memTimer);
      memTimer = null;
    }
  });
}

/**
 * 给某个窗口挂渲染进程崩溃监听。
 *
 * 原实现只 console.error —— 打包版 console 是 noop，等于完全静默，
 * 用户看到的只是「窗口白屏/消失」。这里改成：
 *   1) 落盘（reason / exitCode / 当时的窗口数与内存）
 *   2) 自动 reload 一次，失败再 reload 一次，两次都失败才放弃并提示
 *      —— 「崩溃后能自己恢复」比「崩溃后白屏」体验好得多。
 */
export function watchRenderer(win: Electron.BrowserWindow, tag: string): void {
  let reloads = 0;
  const MAX_RELOADS = 2;

  win.webContents.on("render-process-gone", (_e, details) => {
    crashLog(`💥 render-process-gone [${tag}]`, {
      reason: details.reason, // crashed / oom / killed / abnormal-exit
      exitCode: details.exitCode,
      windowId: win.id,
      destroyed: win.isDestroyed(),
      mem: memSnapshot(),
    });

    if (win.isDestroyed()) return;
    if (details.reason === "clean-exit") return;

    if (reloads < MAX_RELOADS) {
      reloads += 1;
      crashLog(`diag: 尝试恢复渲染进程 (第 ${reloads}/${MAX_RELOADS} 次)`);
      // 稍等再 reload：立刻 reload 在 GPU/共享内存尚未释放时容易连环崩
      setTimeout(() => {
        if (win.isDestroyed()) return;
        try {
          win.webContents.reload();
        } catch (e) {
          crashLog("diag: reload 失败", e);
        }
      }, 800);
    } else {
      crashLog("diag: 已达到恢复上限，不再自动重载");
      try {
        void dialog.showMessageBox({
          type: "error",
          title: "TermAI 页面进程反复异常",
          message: "界面渲染进程已多次异常退出，自动恢复已停止。",
          detail:
            `原因：${details.reason}（退出码 ${details.exitCode}）\n\n` +
            `请从系统托盘退出后重新打开。诊断日志：\n${join(getLogDir(), "crash.log")}`,
          buttons: ["知道了"],
        });
      } catch {
        /* ignore */
      }
    }
  });

  win.webContents.on("unresponsive", () => {
    crashLog(`⚠️ 页面无响应 [${tag}]`, { windowId: win.id, mem: memSnapshot() });
  });

  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    crashLog(`❌ preload 加载失败 [${tag}]`, { preloadPath, message: error?.message });
  });
}

/** 供 IPC / 设置页读取：日志目录绝对路径 */
export function diagnosticsLogDir(): string {
  return getLogDir();
}
