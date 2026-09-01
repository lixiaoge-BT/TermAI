import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const cwd = process.cwd();
const binDir = path.join(cwd, "node_modules", "7zip-bin", "win", "x64");
const target = path.join(binDir, "7za.exe");
const src = path.join(cwd, ".sea-build-7za", "7za.tmp.exe");
if (!fs.existsSync(src)) { console.error("sea build not found"); process.exit(1); }
fs.copyFileSync(src, target);
console.log("✅ 7za.exe replaced with SEA wrapper");
// 改回 .exe
const idx = path.join(cwd, "node_modules", "7zip-bin", "index.js");
let c = fs.readFileSync(idx, "utf-8");
c = c.replace('return path.join(__dirname, "win", process.arch, "7za.cmd")',
              'return path.join(__dirname, "win", process.arch, "7za.exe")');
fs.writeFileSync(idx, c);
console.log("✅ 7zip-bin/index.js path7za = .exe (SEA)");

// 跑一次测试：原生 CreateProcess (shell:false) 直接调用 exe
const p7z = target;
const r = spawnSync(p7z, [], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
console.log("exit:", r.status, "stdout head 200:", String(r.stdout || "").slice(0, 200));
console.log("stderr head 200:", String(r.stderr || "").slice(0, 200));
// 再测试解压 winCodeSign 缓存
const cacheRoot = path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "winCodeSign");
console.log("\ncache root:", cacheRoot, "exists:", fs.existsSync(cacheRoot));
if (fs.existsSync(cacheRoot)) {
  const vers = fs.readdirSync(cacheRoot);
  for (const v of vers) {
    const dir = path.join(cacheRoot, v);
    if (!fs.statSync(dir).isDirectory()) continue;
    const files = fs.readdirSync(dir);
    const zs = files.filter((f) => f.endsWith(".7z") || f.endsWith(".tar.7z"));
    for (const z of zs) {
      const t = path.join(dir, z);
      console.log("  -> extract test:", z);
      const out = path.join(dir, z + ".test-sea");
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      const r2 = spawnSync(p7z, ["x", t, `-o${out}`, "-y", "-bso0", "-bsp0"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
      console.log("      exit:", r2.status, "stderr:", String(r2.stderr || "").slice(0, 300));
      // 确认是否有 symlink 报错
      const hasSymErr = String(r2.stdout + r2.stderr).includes("symbolic") || String(r2.stdout + r2.stderr).includes("符号链接");
      console.log("      has symlink err:", hasSymErr);
      fs.rmSync(out, { recursive: true, force: true });
      if (r2.status !== 0) {
        console.log("      ❌ 解压失败（非符号链接问题）");
      } else if (hasSymErr) {
        console.log("      ⚠️  仍有符号链接信息（但 exit=0 代表已处理或不阻断）");
      } else {
        console.log("      ✅ 成功！");
      }
    }
  }
}
