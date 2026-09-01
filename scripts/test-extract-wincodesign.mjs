import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const p7z = path.join(process.cwd(), "node_modules", "7zip-bin", "win", "x64", "7za.exe");
const arc = "C:\\Users\\raotengke\\AppData\\Local\\electron-builder\\Cache\\winCodeSign\\096189675.7z";
const out = "C:\\Users\\raotengke\\AppData\\Local\\electron-builder\\Cache\\winCodeSign\\test-sea-extract";
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const r = spawnSync(p7z, ["x", arc, `-o${out}`, "-y"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
console.log("exit:", r.status);
const so = String(r.stdout || ""); const se = String(r.stderr || "");
console.log("stdout tail 1500:\n", so.slice(-1500));
console.log("stderr tail 1500:\n", se.slice(-1500));
const all = so + se;
console.log("has symbolic/符号链接:", /symbolic|符号链接/i.test(all));
// 看一下是否生成了 darwin 目录
const walk = (p) => {
  for (const x of fs.readdirSync(p)) {
    const fp = path.join(p, x);
    if (x.toLowerCase().includes("darwin") || x.toLowerCase().includes("openssl") || /10\.(12|14|15|16)/.test(x)) {
      console.log("  found filter-dirs :", fp);
    }
    try { if (fs.statSync(fp).isDirectory()) walk(fp); } catch {}
  }
};
walk(out);
fs.rmSync(out, { recursive: true, force: true });
