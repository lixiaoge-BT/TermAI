// 彻底解决 winCodeSign 缓存：用 -x!darwin* 解出的目录重新 7z 打包回 .7z（无符号链接），覆盖原 .7z
// electron-builder 之后会"解压成功"——因为归档里根本没有 darwin symlink 了
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";

const CACHE_ROOT = path.join(process.cwd(), ".electron-builder-cache");
const CACHE_LOCAL = path.join(process.env.LOCALAPPDATA || process.env.LocalAppData || "", "electron-builder", "Cache");
const SEVEN_ZA = path.join(process.cwd(), "node_modules", "7zip-bin", "win", "x64", "7za.exe");

const dirs = [];
if (fs.existsSync(CACHE_ROOT)) dirs.push(path.join(CACHE_ROOT, "winCodeSign"));
if (fs.existsSync(CACHE_LOCAL)) dirs.push(path.join(CACHE_LOCAL, "winCodeSign"));

const EXCLUDE_EXTRACT = ["-x!darwin*", "-x!linux*", "-x!openssl-ia32*"];

for (const CACHE_DIR of dirs) {
  console.log("\n[repack] 处理:", CACHE_DIR);
  if (!fs.existsSync(CACHE_DIR)) continue;

  const archives = fs.readdirSync(CACHE_DIR).filter((n) => n.endsWith(".7z"));
  for (const sevenZ of archives) {
    const archive = path.join(CACHE_DIR, sevenZ);
    const hash = path.basename(sevenZ, ".7z");
    const extracted = path.join(CACHE_DIR, hash + ".extract");
    const newArchiveTmp = path.join(CACHE_DIR, hash + ".new.7z");

    // 清旧提取
    if (fs.existsSync(extracted)) fs.rmSync(extracted, { recursive: true, force: true });
    fs.mkdirSync(extracted, { recursive: true });

    // 1. 排除符号链接源目录解压
    console.log(`  1/3 解压(排除 darwin/linux/openssl-ia32): ${sevenZ}`);
    const r1 = spawnSync(SEVEN_ZA, ["x", "-bd", "-aoa", ...EXCLUDE_EXTRACT, archive, `-o${extracted}`], {
      stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    });

    const win10x64 = path.join(extracted, "windows-10", "x64");
    if (!fs.existsSync(win10x64)) {
      console.log("    ❌ 解压失败（windows-10/x64 不存在）。跳过此 7z。");
      continue;
    }

    // 2. 重新 7z 打包（不含符号链接源文件，solid block 解压就不会失败了）
    // 把 vendor-anchor 放回去
    const va = path.join(extracted, "vendor-anchor");
    if (!fs.existsSync(va)) fs.writeFileSync(va, "");
    // 建兼容目录副本（electron-builder 24.x 可能查找 windows/10.0/x64）
    if (!fs.existsSync(path.join(extracted, "windows", "10.0"))) {
      function copyDir(src, dst) {
        if (!fs.existsSync(src)) return;
        fs.mkdirSync(dst, { recursive: true });
        for (const e of fs.readdirSync(src)) {
          const s = path.join(src, e), d = path.join(dst, e);
          const st = fs.statSync(s);
          if (st.isDirectory()) copyDir(s, d);
          else fs.copyFileSync(s, d);
        }
      }
      copyDir(path.join(extracted, "windows-10"), path.join(extracted, "windows", "10.0"));
      copyDir(path.join(extracted, "windows-6"), path.join(extracted, "windows", "6"));
    }

    console.log(`  2/3 重新打包（LZMA2 压缩，无符号链接）`);
    if (fs.existsSync(newArchiveTmp)) fs.unlinkSync(newArchiveTmp);
    // a = add；-t7z = 7z 格式；-m0=LZMA2 用 LZMA2；-mx=5 中等压缩
    const r2 = spawnSync(SEVEN_ZA, ["a", "-t7z", "-mx=5", newArchiveTmp, path.join(extracted, "*")], {
      stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (r2.status !== 0 || !fs.existsSync(newArchiveTmp)) {
      console.log(`    ❌ 重新打包失败 exit=${r2.status}`);
      if (r2.stderr) console.log(String(r2.stderr).slice(-500));
      continue;
    }

    // 3. 原子替换原 .7z
    const backup = archive + ".bak";
    try {
      if (fs.existsSync(backup)) fs.unlinkSync(backup);
      fs.renameSync(archive, backup);
      fs.renameSync(newArchiveTmp, archive);
      const newSz = fs.statSync(archive).size;
      const oldSz = fs.statSync(backup).size;
      console.log(`  3/3 ✅ 已替换：${sevenZ}  (${oldSz} → ${newSz} bytes)`);
    } catch (e) {
      console.log(`    ❌ 替换失败:`, e.message);
      // 回滚
      try { if (fs.existsSync(backup) && !fs.existsSync(archive)) fs.renameSync(backup, archive); } catch {}
    }

    // 清临时提取
    try { fs.rmSync(extracted, { recursive: true, force: true }); } catch {}
    try { if (fs.existsSync(backup)) fs.unlinkSync(backup); } catch {}
  }
}

console.log("\n[repack] 全部完成 ✅\n");
console.log("下一步：清掉所有 .extract 半成品目录后再运行 electron-builder。");
