// 7za.exe wrapper：拦截 electron-builder 调用的 7za x 解压命令
// 自动注入 -x!darwin* -x!linux* -x!openssl-ia32* 参数，避免符号链接创建失败
// 用法：此文件编译为 7za.exe（通过 pkg 或 nexe），替换原版 7za.exe
// 本实现使用 Node 做命令行代理，直接在 node_modules/7zip-bin/win/x64 替换 7za.exe 入口
// 简化做法：放一个 7za-wrapper.js，然后用批处理 7za.cmd 包装也行，但 electron-builder 调用的是 .exe。
// 折中：创建一个 7za.ps1 不行；用 Go 编译 exe 太大。
// 最终方案：用 node 编译成 exe —— 用 node SEA (Single Executable)，或直接写一个 C 小程序
// 这里做一个"Node SEA"方案：把一个 7za-wrapper 注入 node.exe 并改名为 7za.exe（体积较大 ~70MB）。
//
// 更简单：把 7za.exe 重命名为 7za-real.exe，此脚本以命令行工具形式 7za.cmd 作为代理？
// 检查 electron-builder 是否会尝试 .cmd — 它一般直接调用具体路径的 exe。
//
// 采用 Node SEA (Single Executable Application)：
//   1. Copy C:\Program Files\nodejs\node.exe → 7za.exe
//   2. 将此脚本写入 BLOB 注入到 7za.exe 的尾部资源
// 但用户可能没有 postject。更务实：使用已经存在的 bat+exe 组合，我们手动修改 7zip-bin 的配置路径。
//
// 7zip-bin 包在 index.js 里用 process.platform + arch 算出 7za 路径。
// 实际上 electron-builder 通过 require("7zip-bin").path7za 找到 7za.exe。
// 我们可以用 require 钩子或者直接覆盖 node_modules/7zip-bin/index.js 的导出。

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// 找到 7za 真实位置
const PKG_DIR = path.join(process.cwd(), "node_modules", "7zip-bin");
const ORIG_BIN = path.join(PKG_DIR, "win", "x64", "7za.exe");
const REAL_BIN = path.join(PKG_DIR, "win", "x64", "7za.real.exe");
const WRAPPER_BAT = path.join(PKG_DIR, "win", "x64", "7za.bat"); // fallback
const WRAPPER_NODE_SCRIPT = path.join(PKG_DIR, "win", "x64", "7za-run.js");

// Step 1. 备份真实 7za.exe → 7za.real.exe（第一次才做，之后跳过）
if (fs.existsSync(ORIG_BIN) && !fs.existsSync(REAL_BIN)) {
  fs.copyFileSync(ORIG_BIN, REAL_BIN);
  console.log("[install] 备份真实 7za.exe → 7za.real.exe");
}

// Step 2. 写代理脚本 7za-run.js
const WRAPPER_CODE = `
// 自动注入 -x!darwin* -x!linux* -x!openssl-ia32* 参数
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const realBin = path.join(__dirname, "7za.real.exe");
if (!fs.existsSync(realBin)) {
  console.error("7za wrapper: real exe not found at " + realBin);
  process.exit(1);
}

const args = process.argv.slice(2);
let newArgs = args.slice();
const action = (args[0] || "").toLowerCase();
// 对 x (解压缩) 和 e (解压到当前目录) 注入排除项
if (action === "x" || action === "e") {
  const already = newArgs.some((a) => /^-x!/.test(a));
  if (!already) {
    // 找到输出目录参数 -o<dir> 之后插入（或追加到末尾，7za 支持末尾放选项）
    // 注意要在 "archive name" 之前或之后都可以
    newArgs.push("-x!darwin*", "-x!linux*", "-x!openssl-ia32*");
  }
}

const r = spawnSync(realBin, newArgs, {
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(r.status === null ? 1 : r.status);
`;
fs.writeFileSync(WRAPPER_NODE_SCRIPT, WRAPPER_CODE);
console.log(`[install] 生成代理脚本: ${path.relative(process.cwd(), WRAPPER_NODE_SCRIPT)}`);

// Step 3. 覆盖 7za.exe：用 node.exe + blob 的方式做 SEA。
// Node 20 支持用 node --experimental-sea-config 制作单文件 exe。
// 但更稳妥的做法：创建一个 "7za.cmd" 并让 7zip-bin 导出路径指向它。
// 不，因为 electron-builder 内部用的是 .exe 路径。所以我们用 node SEA。
const nodeExe = process.execPath; // C:\Program Files\nodejs\node.exe
console.log(`[install] 宿主 node.exe: ${nodeExe}`);

// 构建 SEA config
const seaDir = path.join(process.cwd(), ".sea-build");
if (!fs.existsSync(seaDir)) fs.mkdirSync(seaDir, { recursive: true });

const seaConfig = {
  main: "7za-run.js",
  output: "sea-prep.blob",
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
};
const seaConfigFile = path.join(seaDir, "sea-config.json");
fs.writeFileSync(seaConfigFile, JSON.stringify(seaConfig, null, 2));

// 复制运行脚本到 sea 目录
fs.copyFileSync(WRAPPER_NODE_SCRIPT, path.join(seaDir, "7za-run.js"));

// Step 3a: 生成 SEA blob
console.log("[install] 生成 SEA blob...");
const r1 = spawnSync(process.execPath, ["--experimental-sea-config", seaConfigFile], {
  stdio: ["inherit", "inherit", "inherit"], cwd: seaDir,
});
if (r1.status !== 0) {
  console.log("[install] SEA blob 失败 (exit " + r1.status + ")。尝试方案二：替换 7zip-bin 的 path7za 指向 CMD 包装。");
  fallbackBatMode();
  process.exit(0);
}

// Step 3b: 拷贝 node.exe 到 7za.exe，并注入 blob
const targetExe = path.join(seaDir, "7za.exe");
fs.copyFileSync(nodeExe, targetExe);

// 尝试用 postject 注入 blob
let injected = false;
try {
  const blob = path.join(seaDir, "sea-prep.blob");
  const r2 = spawnSync(process.execPath, [
    path.join(process.cwd(), "node_modules", "postject", "dist", "cli.js"),
    targetExe, "NODE_SEA_BLOB", blob,
    "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ], {
    stdio: ["inherit", "inherit", "inherit"], cwd: process.cwd(),
  });
  if (r2.status === 0) injected = true;
  else {
    // postject 可能没装（devDependencies 里）。直接 npx 调用。
    const r3 = spawnSync(process.execPath, [
      "--import", `data:text/javascript,import {createRequire} from "node:module";const r=createRequire("${process.cwd()}/");try{r("postject");}catch(e){process.exit(1);}`
    ], ["--version"], { stdio: "pipe" });
    console.log("[install] postject npx fallback required...");
  }
} catch (e) { console.log("[install] postject inject error:", e.message); }

if (injected) {
  // 把注入后的 7za.exe 替换 7zip-bin/win/x64/7za.exe
  fs.copyFileSync(targetExe, ORIG_BIN);
  console.log("[install] ✅ 7za SEA 替换成功！所有 7za x 命令将自动排除 darwin/linux 符号链接目录");
} else {
  console.log("[install] SEA 注入失败，使用方案二：补丁 7zip-bin 的 path.js");
  fallbackBatMode();
}

function fallbackBatMode() {
  // 创建 7za.bat
  const batPath = path.join(PKG_DIR, "win", "x64", "7za-run.bat");
  const bat = `
@echo off
setlocal
set "REAL=%~dp07za.real.exe"
set "ARGS=%*"
set "ACTION=%1"
if /I "%ACTION%"=="x" goto ADD_EXCLUDE
if /I "%ACTION%"=="e" goto ADD_EXCLUDE
goto RUN
:ADD_EXCLUDE
set "ARGS=%ARGS% -x!darwin* -x!linux* -x!openssl-ia32*"
:RUN
"%REAL%" %ARGS%
exit /B %ERRORLEVEL%
`.trim() + "\r\n";
  fs.writeFileSync(batPath, bat);

  // 补丁 node_modules/7zip-bin/path.js（或 index.js）导出 .bat 路径
  // 7zip-bin 的使用：module.exports = { path7za: <abs path> }（老写法）；新版也用 package.json exports
  // 检查 7zip-bin/index.js 内容
  const idx = path.join(PKG_DIR, "index.js");
  let content;
  try { content = fs.readFileSync(idx, "utf-8"); } catch { content = ""; }
  if (content.includes("path7za")) {
    // 新版：替换 "path7za": ... 指向我们的 bat
    // 实际更简单：直接在 .js 头部写死覆盖值
    const patched = `
// ---------- TermAI patched (${new Date().toISOString()}) ----------
// 用 node 脚本作为 7za 代理，自动排除符号链接目录
// 防止 electron-builder winCodeSign 解压失败 (symlink privilege issue)
const p = require.resolve("./win/x64/7za.real.exe");
if (p && false) {} // no-op
const { spawnSync } = require("node:child_process");
function runViaWrapper(argv) {
  const realBin = require.resolve("./win/x64/7za.real.exe");
  const args = argv.slice(1); // node 自己会跳过 argv[0]=node
  const action = (argv[0] || "").toLowerCase();
  const newArgs = args.slice();
  if (action === "x" || action === "e") {
    const has = newArgs.some(a => /^-x!/.test(a));
    if (!has) newArgs.push("-x!darwin*", "-x!linux*", "-x!openssl-ia32*");
  }
  const r = spawnSync(realBin, newArgs, { stdio: ["inherit", "inherit", "inherit"] });
  process.exit(r.status == null ? 1 : r.status);
}
// 若这个文件是被直接执行的：
if (require.main === module) runViaWrapper(process.argv.slice(2));
// ---------- Original below (paths corrected) ----------
`.replace(/^/, "") + content;
    fs.writeFileSync(idx, patched);
    // 再补丁 path7za 的值：让它指向一个 .cmd（我们放一个 cmd 代理 node）
    const cmdPath = path.join(PKG_DIR, "win", "x64", "7za.cmd");
    const cmd = `
@echo off
setlocal
set "SCRIPT=%~dp0..\\..\\index.js"
node "%SCRIPT%" %*
exit /B %ERRORLEVEL%
`.trim().replace(/^/, "") + "\r\n";
    fs.writeFileSync(cmdPath, cmd);
    // 最关键：替换 content 中 path7za = "...7za.exe" → "...7za.cmd"
    let p2 = fs.readFileSync(idx, "utf-8");
    p2 = p2.replace(/path7za\s*:\s*__dirname\s*\+\s*['"]([^'"]+)['"]/g, (m, g1) => {
      // 把路径最后一个扩展名 .exe 换成 .cmd
      const newP = g1.replace(/\.exe$/i, ".cmd");
      return "path7za: __dirname + '" + newP + "'";
    });
    p2 = p2.replace(/path7za\s*=\s*path\.join\([^)]+\)/g, (m) => {
      // 简单替换 7za.exe → 7za.cmd
      return m.replace(/7za\.exe/gi, "7za.cmd");
    });
    fs.writeFileSync(idx, p2);
    console.log("[install] ✅ (fallback) 已补丁 7zip-bin/index.js + 7za.cmd 包装");
  }

  // 我们还得同时处理直接调用 node_modules/7zip-bin/win/x64/7za.exe（不经 path7za 变量）
  // 所以：把真实 7za.exe 改名为 7za.real.exe，把 ORIG_BIN 换成一个 C 编译的小 exe 很难。
  // 折中：利用 fs.copyFileSync 把一个"node shebang exe"放到 7za.exe 位置——Windows 下 .exe 必须是 PE 文件。
  // 于是我们干脆保留 7za.real.exe，在 7za.exe 旁边放一个脚本，但 electron-builder 显式调用 .exe。
  //
  // 所以最终策略：用 node 20 SEA 创建 7za.exe 可执行文件（已在上方尝试注入）。
  // 如果上面没成功，先打印 SEA 步骤让用户知道；
  console.log("[install] ℹ️  如需强制重新生成 7za SEA，再次执行本脚本或启用 Windows 开发者模式后重试打包。");
}
