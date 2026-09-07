import { app, BrowserWindow, shell, ipcMain, dialog, safeStorage } from "electron";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSshManager } from "./ssh.js";
import { createLocalTerminalManager } from "./localTerminal.js";
import { createLocalFsManager } from "./localFs.js";
import { createRecordingsManager } from "./recordings.js";
import { parseJumpArgs, type JumpConnectParams } from "./deepLink.js";
import { logArgvEntry, logEmptyArgvNotice } from "./argvDebug.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

if (release().startsWith("6.1")) app.disableHardwareAcceleration();
if (process.platform === "win32") {
  app.setAppUserModelId(app.getName());
  // Windows 下禁用 GPU 加速以提升启动速度并避免黑屏
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu", "true");
  app.commandLine.appendSwitch("disable-gpu-compositing", "true");
  app.commandLine.appendSwitch("no-sandbox", "true");
  app.commandLine.appendSwitch("disable-dev-shm-usage", "true");
}

// ---------- 自定义协议注册（堡垒机 / deep link 唤起用） ----------
// 让 termai://connect?... 能被系统唤起到本进程。开发模式下需要显式传 argv
// 告诉 Electron 用哪个 exe 去注册，避免 dev server 时注册到 node 上。
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient("termai", process.execPath, [
    join(__dirname, ".."), // 项目根目录，让 dev 模式也能命中
  ]);
} else {
  app.setAsDefaultProtocolClient("termai");
}

/**
 * 「待推送」外部跳转连接请求：在 did-finish-load 之前就被解析出来的请求先存这里，
 * 渲染层 ready 后由 deliverJumpRequest 一次性推过去，避免消息丢失。
 * @type {JumpConnectParams | null}
 */
let pendingJumpRequest: JumpConnectParams | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// 本进程拿到锁（即本进程是 first instance），先试着从 process.argv 解析外部跳转参数。
// macOS 上 URL 走 open-url 不走 argv；这里只覆盖 Windows 协议唤起 / 命令行启动场景。
{
  const init = parseJumpArgs(process.argv, "windows-protocol");
  if (init) {
    pendingJumpRequest = init;
    console.log("[main] ✅ 首次启动 argv 解析到跳转参数:", {
      protocol: init.protocol,
      host: init.host,
      port: init.port,
      username: init.username,
      hasPassword: !!init.password,
    });
  }
  // 把「启动期 argv + 解析结果」写到本地日志，方便排查堡垒机到底传了什么格式
  logArgvEntry(process.argv, "first-instance", init);
  if (!init) logEmptyArgvNotice();
}

// ---------- 启动期错误兜底 ----------
// 任何未被捕获的异常都会弹窗展示，避免「启动不了」却无任何提示。
process.on("uncaughtException", (err) => {
  console.error("[main] ❌ uncaughtException:", err);
  try {
    dialog.showErrorBox(
      "TermAI 启动失败",
      `${err?.message || String(err)}\n\n${(err as Error)?.stack || ""}`
    );
  } catch {
    /* 对话框也可能失败，忽略 */
  }
});
process.on("unhandledRejection", (reason) => {
  console.error("[main] ❌ unhandledRejection:", reason);
});

// 生产环境降噪：仅保留 error / warn，避免内部日志泄露到控制台并减少开销
if (app.isPackaged) {
  const noop = () => {};
  console.log = noop;
  console.debug = noop;
  console.info = noop;
}

/** @type {BrowserWindow | null} */
let win = null;
let sshManager = null;
let localTerminalManager = null;
let localFsManager = null;
let recordingsManager = null;

const preload = join(__dirname, "../preload/index.cjs");
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

async function createWindow() {
  win = new BrowserWindow({
    title: "TermAI - AI 智能终端",
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0d1117",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
    },
  });

  // ── ① 关键顺序：did-finish-load 监听必须在 loadURL/loadFile 之前注册 ──────────
  // 原实现把 `await win.loadFile()` 放在注册之前，而 await 返回时 did-finish-load
  // 早已触发完毕 —— 监听器永远收不到事件。后果：堡垒机「首次唤起」TermAI 时，
  // argv 解析成功（[main] ✅ 首次启动 argv 解析到跳转参数），但参数卡在
  // pendingJumpRequest 里推不进渲染层，表现就是「TermAI 弹出来了但只连到本地终端」。
  win.webContents.on("did-finish-load", () => {
    console.log("[main] ✅ 页面加载完成");
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();

    // 把启动早期缓存的跳转参数送进渲染层（堡垒机首次唤起走这条路径）。
    if (pendingJumpRequest) {
      console.log("[main] 📡 推送缓存的跳转参数给渲染层:", {
        protocol: pendingJumpRequest.protocol,
        host: pendingJumpRequest.host,
        port: pendingJumpRequest.port,
        username: pendingJumpRequest.username,
      });
      win.webContents.send("jump:connect", pendingJumpRequest);
      pendingJumpRequest = null;
    }
  });

  // ── ② 兜底显示窗口（在 load 之前启动；放到 await 之后创建等于没有兜底）──────
  const showTimer = setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  }, 5000);
  win.once("closed", () => clearTimeout(showTimer));

  // ── ③ 加载页面 ──────────────────────────────────────────────────────────────
  if (VITE_DEV_SERVER_URL) {
    await win.loadURL(VITE_DEV_SERVER_URL);
    // 开发期不再自动弹出 DevTools，需要时按 F12 手动打开
    // win.webContents.openDevTools({ mode: "detach" });
  } else {
    // 生产环境加载打包后的 index.html
    // __dirname 在打包后指向 dist-electron/main，所以 index.html 在 dist/index.html
    const indexHtml = join(__dirname, "../../dist/index.html");
    try {
      await win.loadFile(indexHtml);
    } catch (err) {
      console.error("[main] ❌ 加载 index.html 失败:", indexHtml);
      console.error("[main] 错误:", err);
      // 失败时尝试打开 DevTools 以便调试
      win.webContents.openDevTools({ mode: "detach" });
    }
  }

  // 同步初始化 SSH Manager 和 Local Terminal Manager，确保渲染进程发起 IPC 时已经就绪
  sshManager = createSshManager(win);
  localTerminalManager = createLocalTerminalManager(win);
  localFsManager = createLocalFsManager();
  recordingsManager = createRecordingsManager();
  console.log("[main] SSH Manager 和 Local Terminal Manager 已初始化");

  // ── ⑤ 双保险：万一 did-finish-load 仍未触发（极端时序 / 页面瞬时完成）──────────
  // 只要页面已就绪就直接补发，避免堡垒机的跳转参数卡死在缓存里。
  if (pendingJumpRequest && win && !win.isDestroyed() && !win.webContents.isLoading()) {
    console.log("[main] 📡 补发缓存的跳转参数（did-finish-load 未触发，兜底直投）:", {
      protocol: pendingJumpRequest.protocol,
      host: pendingJumpRequest.host,
      port: pendingJumpRequest.port,
      username: pendingJumpRequest.username,
    });
    win.webContents.send("jump:connect", pendingJumpRequest);
    pendingJumpRequest = null;
  }

  // 监听渲染进程加载失败
  win.webContents.on("did-fail-load", (_e, errorCode, errorDescription, validatedUrl) => {
    console.error(`[main] ❌ 页面加载失败: ${validatedUrl}, code=${errorCode}, desc=${errorDescription}`);
  });

  // 监听渲染进程崩溃
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error(`[main] ❌ 渲染进程崩溃: reason=${details.reason}, exitCode=${details.exitCode}`);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:") || url.startsWith("http:")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // 快捷键：F12 切换 DevTools（所有模式可用）
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "F12") {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools({ mode: "detach" });
      }
    }
  });

  // 监听 preload 加载错误
  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    console.error("[main] ❌ preload 加载失败:", preloadPath);
    console.error("[main] 错误:", error?.message || error);
  });

  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    // 捕获渲染进程的 console 输出
    if (level >= 2) {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    }
  });
}

app.whenReady().then(() => {
  console.log("[main] Electron app ready, 创建窗口...");
  try {
    createWindow();
  } catch (e) {
    console.error("[main] 创建窗口失败:", e);
    dialog.showErrorBox("TermAI 启动失败", `${(e as Error)?.message || String(e)}\n\n${(e as Error)?.stack || ""}`);
  }
});

app.on("window-all-closed", () => {
  win = null;
  if (sshManager) {
    sshManager.disposeAll();
    sshManager = null;
  }
  if (localTerminalManager) {
    localTerminalManager.disposeAll();
    localTerminalManager = null;
  }
  if (localFsManager) {
    localFsManager = null;
  }
  if (recordingsManager) {
    recordingsManager = null;
  }
  if (process.platform !== "darwin") app.quit();
});

app.on("second-instance", (_event, argv) => {
  console.log("[main] second-instance argv:", argv);
  // 把已有窗口抢到前台（用户感知：堡垒机里再点一下 TermAI 不闪退）
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  // 二次启动：堡垒机再次点击 / deep-link 重新唤起，会带新 argv 入来。
  // 这里解析后立刻转发给渲染层（已有窗口），不走 pendingJumpRequest 缓存。
  const req = parseJumpArgs(argv || [], "second-instance");
  logArgvEntry(argv || [], "second-instance", req);
  if (req) {
    console.log("[main] 📡 second-instance → 解析到跳转参数 →", {
      protocol: req.protocol,
      host: req.host,
      port: req.port,
      username: req.username,
    });
    deliverJumpRequest(req);
  }
});

// macOS 协议唤起专用：URL 走 open-url 而不是 argv
app.on("open-url", (event, url) => {
  console.log("[main] open-url:", url);
  event.preventDefault?.();
  const argv = [url];
  const req = parseJumpArgs(argv, "open-url");
  logArgvEntry(argv, "open-url", req);
  if (req) {
    console.log("[main] 📡 open-url → 解析到跳转参数 →", {
      protocol: req.protocol,
      host: req.host,
      port: req.port,
      username: req.username,
    });
    deliverJumpRequest(req);
  }
});

/**
 * 把外部跳转连接请求送到渲染层（jump:connect）。
 * 若窗口尚未 ready，请求会暂存到 pendingJumpRequest，等 did-finish-load 再补发。
 */
function deliverJumpRequest(req: JumpConnectParams) {
  if (
    win &&
    !win.isDestroyed() &&
    win.webContents &&
    !win.webContents.isLoading()
  ) {
    win.webContents.send("jump:connect", req);
    return;
  }
  // 还没 ready 或正在 load，先缓存
  pendingJumpRequest = req;
}

app.on("activate", () => {
  const allWindows = BrowserWindow.getAllWindows();
  if (allWindows.length) {
    allWindows[0].focus();
  } else {
    createWindow();
  }
});

// ---------- IPC 通信 ----------

// 调试：检查 IPC 桥是否通畅
ipcMain.handle("ping", async (_evt, msg) => {
  console.log("[main] 收到 ping:", msg);
  return `pong: ${msg}`;
});

// ---------- 凭据静态加密（safeStorage）----------
// 渲染进程把持久化状态（含 SSH 密码 / 私钥 / API Key）发来加密后再落盘，
// 解密时若数据未带 ENC: 前缀则按旧明文处理，保证升级平滑。
ipcMain.handle("secure:encrypt", (_evt, plain: string) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return plain;
    return "ENC:" + safeStorage.encryptString(plain).toString("base64");
  } catch {
    return plain;
  }
});

ipcMain.handle("secure:decrypt", (_evt, cipher: string) => {
  if (typeof cipher !== "string") return "";
  if (cipher.startsWith("ENC:")) {
    try {
      return safeStorage.decryptString(Buffer.from(cipher.slice(4), "base64"));
    } catch {
      return cipher.slice(4);
    }
  }
  return cipher;
});

ipcMain.handle("ssh:connect", async (_evt, params, sessionId) => {
  console.log("[main] 收到 ssh:connect, sessionId:", sessionId, "params:", JSON.stringify({ host: params.host, port: params.port, username: params.username, hasPassword: !!params.password }));
  if (!sshManager) {
    console.error("[main] SSH Manager 未初始化!");
    throw new Error("SSH Manager 未初始化");
  }
  try {
    const result = await sshManager.connect(sessionId, params);
    console.log("[main] ssh:connect 成功:", result);
    return result;
  } catch (err) {
    console.error("[main] ssh:connect 失败:", err.message);
    console.error("[main] 错误详情:", err.stack || err);
    throw err;
  }
});

ipcMain.handle("ssh:disconnect", async (_evt, sessionId) => {
  console.log("[main] ssh:disconnect:", sessionId);
  if (!sshManager) throw new Error("SSH Manager 未初始化");
  return sshManager.disconnect(sessionId);
});

ipcMain.handle("ssh:write", async (_evt, sessionId, data) => {
  if (!sshManager) throw new Error("SSH Manager 未初始化");
  return sshManager.write(sessionId, data);
});

ipcMain.handle("ssh:resize", async (_evt, sessionId, cols, rows) => {
  if (!sshManager) throw new Error("SSH Manager 未初始化");
  return sshManager.resize(sessionId, cols, rows);
});

ipcMain.handle("ssh:list-sessions", () => {
  if (!sshManager) return [];
  return sshManager.listSessions();
});

// ---------- 端口转发 ----------
ipcMain.handle("ssh:forward-local", async (_evt, sessionId, spec) => {
  if (!sshManager) throw new Error("SSH Manager 未初始化");
  return sshManager.forwardLocal(sessionId, spec);
});
ipcMain.handle("ssh:forward-remote", async (_evt, sessionId, spec) => {
  if (!sshManager) throw new Error("SSH Manager 未初始化");
  return sshManager.forwardRemote(sessionId, spec);
});
ipcMain.handle("ssh:forward-dynamic", async (_evt, sessionId, spec) => {
  if (!sshManager) throw new Error("SSH Manager 未初始化");
  return sshManager.forwardDynamic(sessionId, spec);
});
ipcMain.handle("ssh:list-forwards", async (_evt, sessionId) => {
  if (!sshManager) return [];
  return sshManager.listForwards(sessionId);
});
ipcMain.handle("ssh:cancel-forward", async (_evt, sessionId, id) => {
  if (!sshManager) throw new Error("SSH Manager 未初始化");
  return sshManager.cancelForward(sessionId, id);
});

ipcMain.handle("win:open-new-window", () => {
  createWindow();
});

// ---------- Local Terminal IPC ----------

ipcMain.handle("local-terminal:create", async (_evt, sessionId, shell, cols, rows) => {
  if (!localTerminalManager) throw new Error("Local Terminal Manager 未初始化");
  return localTerminalManager.create(sessionId, shell, cols, rows);
});

ipcMain.handle("local-terminal:write", async (_evt, sessionId, data) => {
  if (!localTerminalManager) throw new Error("Local Terminal Manager 未初始化");
  return localTerminalManager.write(sessionId, data);
});

ipcMain.handle("local-terminal:resize", async (_evt, sessionId, cols, rows) => {
  if (!localTerminalManager) throw new Error("Local Terminal Manager 未初始化");
  return localTerminalManager.resize(sessionId, cols, rows);
});

ipcMain.handle("local-terminal:dispose", async (_evt, sessionId) => {
  if (!localTerminalManager) throw new Error("Local Terminal Manager 未初始化");
  return localTerminalManager.dispose(sessionId);
});

// ---------- SFTP 文件传输 IPC ----------

ipcMain.handle("sftp:connect", async (_evt, params, sessionId) => {
  if (!sshManager) throw new Error("SSH Manager 未初始化");
  return sshManager.sftpConnect(sessionId, params);
});

ipcMain.handle("sftp:list", async (_evt, sessionId, path) => {
  if (!sshManager) throw new Error("SSH Manager 未初始化");
  return sshManager.sftpList(sessionId, path);
});

ipcMain.handle("sftp:mkdir", async (_evt, sessionId, path) => {
  if (!sshManager) throw new Error("SSH Manager 未初始化");
  return sshManager.sftpMkdir(sessionId, path);
});

ipcMain.handle("sftp:remove", async (_evt, sessionId, path, isDir) => {
  if (!sshManager) throw new Error("SSH Manager 未初始化");
  return sshManager.sftpRemove(sessionId, path, isDir);
});

ipcMain.handle("sftp:rename", async (_evt, sessionId, oldPath, newPath) => {
  if (!sshManager) throw new Error("SSH Manager 未初始化");
  return sshManager.sftpRename(sessionId, oldPath, newPath);
});

ipcMain.handle("sftp:download", async (_evt, sessionId, remotePath, localPath) => {
  if (!sshManager) throw new Error("SSH Manager 未初始化");
  return sshManager.sftpDownload(sessionId, remotePath, localPath);
});

ipcMain.handle("sftp:upload", async (_evt, sessionId, localPath, remotePath) => {
  if (!sshManager) throw new Error("SSH Manager 未初始化");
  return sshManager.sftpUpload(sessionId, localPath, remotePath);
});

ipcMain.handle("sftp:realpath", async (_evt, sessionId, path) => {
  if (!sshManager) throw new Error("SSH Manager 未初始化");
  return sshManager.sftpRealpath(sessionId, path);
});

ipcMain.handle("sftp:disconnect", async (_evt, sessionId) => {
  if (!sshManager) throw new Error("SSH Manager 未初始化");
  return sshManager.sftpDisconnect(sessionId);
});

// ---------- 本地文件系统 IPC ----------

ipcMain.handle("local-fs:list-dir", async (_evt, path) => {
  if (!localFsManager) throw new Error("Local FS Manager 未初始化");
  return localFsManager.listDir(path);
});

ipcMain.handle("local-fs:list-roots", async () => {
  if (!localFsManager) throw new Error("Local FS Manager 未初始化");
  return localFsManager.listRoots();
});

ipcMain.handle("local-fs:get-desktop-path", async () => {
  if (!localFsManager) throw new Error("Local FS Manager 未初始化");
  return localFsManager.getDesktopPath();
});

ipcMain.handle("local-fs:mkdir", async (_evt, path) => {
  if (!localFsManager) throw new Error("Local FS Manager 未初始化");
  return localFsManager.mkdir(path);
});

ipcMain.handle("local-fs:rename", async (_evt, oldPath, newPath) => {
  if (!localFsManager) throw new Error("Local FS Manager 未初始化");
  return localFsManager.rename(oldPath, newPath);
});

ipcMain.handle("local-fs:remove", async (_evt, path) => {
  if (!localFsManager) throw new Error("Local FS Manager 未初始化");
  return localFsManager.remove(path);
});

// ---------- 会话录制 IPC ----------

ipcMain.handle("recording:get-dir", () => {
  if (!recordingsManager) throw new Error("Recordings Manager 未初始化");
  return recordingsManager.getDir();
});

ipcMain.handle("recording:save", async (_evt, input: { name: string; content: string; duration?: number }) => {
  if (!recordingsManager) throw new Error("Recordings Manager 未初始化");
  return recordingsManager.save(input);
});

ipcMain.handle("recording:list", async () => {
  if (!recordingsManager) throw new Error("Recordings Manager 未初始化");
  return recordingsManager.list();
});

ipcMain.handle("recording:read", async (_evt, id: string) => {
  if (!recordingsManager) throw new Error("Recordings Manager 未初始化");
  return recordingsManager.read(id);
});

ipcMain.handle("recording:remove", async (_evt, id: string) => {
  if (!recordingsManager) throw new Error("Recordings Manager 未初始化");
  return recordingsManager.remove(id);
});

ipcMain.handle("recording:rename", async (_evt, id: string, name: string) => {
  if (!recordingsManager) throw new Error("Recordings Manager 未初始化");
  return recordingsManager.rename(id, name);
});

ipcMain.handle("recording:open-dir", async () => {
  if (!recordingsManager) throw new Error("Recordings Manager 未初始化");
  return recordingsManager.openDir();
});
