import { app, BrowserWindow, shell, ipcMain, dialog, safeStorage } from "electron";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSshManager } from "./ssh.js";
import { createLocalTerminalManager } from "./localTerminal.js";
import { createLocalFsManager } from "./localFs.js";
import { createRecordingsManager } from "./recordings.js";

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

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
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

  // 监听渲染进程加载完成
  win.webContents.on("did-finish-load", () => {
    console.log("[main] ✅ 页面加载完成");
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  });

  // 兜底：若 5 秒内仍未加载完成（如资源异常），也先把窗口显示出来，避免「黑屏/不启动」
  const showTimer = setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  }, 5000);
  win.once("closed", () => clearTimeout(showTimer));

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

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

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
