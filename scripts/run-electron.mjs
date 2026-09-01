// 启动 Electron 并在 dist-electron 变更时自动重启
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST_MAIN = join(ROOT, "dist-electron/main");
const DIST_PRELOAD = join(ROOT, "dist-electron/preload");

const ELECTRON_BIN = join(ROOT, "node_modules/electron/cli.js");
const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";

/** @type {import('child_process').ChildProcess | null} */
let electronProc = null;
let restartTimer = null;

function startElectron() {
  if (electronProc) {
    try { electronProc.kill("SIGTERM"); } catch {}
  }
  console.log("[electron] 启动 / 重启 Electron...");
  electronProc = spawn(
    process.execPath,
    [
      ELECTRON_BIN,
      ".",
      `--user-data-dir=${join(ROOT, ".electron-userdata")}`,
      "--no-sandbox",
      "--disable-gpu-sandbox",
    ],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: DEV_URL,
        ELECTRON_DISABLE_SANDBOX: "1",
      },
    }
  );
  electronProc.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.log(`[electron] 进程退出，代码 ${code}`);
    }
  });
}

function scheduleRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    startElectron();
  }, 300);
}

// 首次启动
startElectron();

// 监听 dist-electron 变更
try {
  watch(DIST_MAIN, { recursive: true }, () => {
    console.log("[electron] 检测到主进程代码变更，准备重启...");
    scheduleRestart();
  });
  watch(DIST_PRELOAD, { recursive: true }, () => {
    console.log("[electron] 检测到 preload 代码变更，准备重启...");
    scheduleRestart();
  });
} catch (e) {
  console.warn("[electron] 无法监听 dist-electron，自动重启未启用:", e.message);
}

// 保持进程
process.on("SIGINT", () => {
  if (electronProc) electronProc.kill("SIGTERM");
  process.exit(0);
});
