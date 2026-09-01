// 修复 winCodeSign 缓存：对找到的所有 .7z 排除 darwin/linux 目录后解压
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CACHE_ROOT = path.join(process.cwd(), ".electron-builder-cache");
const CACHE_LOCAL = path.join(process.env.LOCALAPPDATA || process.env.LocalAppData || "", "electron-builder", "Cache");
const SEVEN_ZA = path.join(process.cwd(), "node_modules", "7zip-bin", "win", "x64", "7za.exe");

const dirs = [];
if (fs.existsSync(CACHE_ROOT)) dirs.push(path.join(CACHE_ROOT, "winCodeSign"));
if (fs.existsSync(CACHE_LOCAL)) dirs.push(path.join(CACHE_LOCAL, "winCodeSign"));

// 排除 darwin（符号链接）、linux、openssl-ia32（加密加速不需要）
const EXCLUDE = ["-x!darwin*", "-x!linux*", "-x!openssl-ia32*"];

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src)) {
    const s = path.join(src, e);
    const d = path.join(dst, e);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

for (const CACHE_DIR of dirs) {
  console.log("\n[fix] 处理:", CACHE_DIR);
  if (!fs.existsSync(CACHE_DIR)) continue;

  // 清掉所有半成品目录
  for (const entry of fs.readdirSync(CACHE_DIR)) {
    const p = path.join(CACHE_DIR, entry);
    try { if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }

  for (const sevenZ of fs.readdirSync(CACHE_DIR).filter((n) => n.endsWith(".7z"))) {
    const archive = path.join(CACHE_DIR, sevenZ);
    const hashName = path.basename(sevenZ, ".7z");
    const targetDir = path.join(CACHE_DIR, hashName);
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });

    const args = ["x", "-bd", "-aoa", ...EXCLUDE, archive, `-o${targetDir}`];
    console.log("  ↳ 7za " + args.join(" "));
    const r = spawnSync(SEVEN_ZA, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });

    const win10x64 = path.join(targetDir, "windows-10", "x64");
    const signtool = path.join(win10x64, "signtool.exe");
    console.log("    exit code    :", r.status);
    console.log("    windows-10/x64:", fs.existsSync(win10x64) ? "✅" : "❌");
    console.log("    signtool.exe :", fs.existsSync(signtool) ? "✅" : "❌");

    if (!fs.existsSync(win10x64)) {
      console.log("    ⚠️  解压未成功（跳过兼容层创建）");
      continue;
    }

    // 补 vendor-anchor
    const va = path.join(targetDir, "vendor-anchor");
    if (!fs.existsSync(va)) {
      fs.writeFileSync(va, JSON.stringify({ source: "electron-builder-binaries", fixed: true }));
      console.log("    ✍️  补建 vendor-anchor");
    }

    // 建兼容目录：windows-10/x64 → windows/10.0/x64；windows-6 → windows/6
    const compatDir = path.join(targetDir, "windows", "10.0");
    if (!fs.existsSync(path.join(compatDir, "x64", "signtool.exe"))) {
      console.log("    🧱 建立 windows/10.0/x64 兼容目录副本");
      copyDir(path.join(targetDir, "windows-10"), path.join(targetDir, "windows", "10.0"));
    }
    const w6src = path.join(targetDir, "windows-6");
    if (fs.existsSync(w6src) && !fs.existsSync(path.join(targetDir, "windows", "6", "signtool.exe"))) {
      copyDir(w6src, path.join(targetDir, "windows", "6"));
    }

    // 再验证
    const compatSign = path.join(targetDir, "windows", "10.0", "x64", "signtool.exe");
    console.log("    compat sign   :", fs.existsSync(compatSign) ? "✅" : "❌");
  }
}

console.log("\n[fix] 全部完成 ✅");
