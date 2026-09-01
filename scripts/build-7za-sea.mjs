// 制作 SEA 7za.exe 包装器
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const binDir = path.join(process.cwd(), "node_modules", "7zip-bin", "win", "x64");
const nodeExe = process.execPath;
const seaBuild = path.join(process.cwd(), ".sea-build-7za");
const srcWrapper = path.join(binDir, "7za-wrapper.js");
const targetExe = path.join(binDir, "7za.exe");   // 最终：覆盖原 7za.exe 为 SEA
const realExe = path.join(binDir, "7za.real.exe"); // 真实 7za 已备份在此

console.log("node exe:", nodeExe);
console.log("wrapper :", srcWrapper, fs.existsSync(srcWrapper));
console.log("real exe:", realExe, fs.existsSync(realExe));

if (!fs.existsSync(realExe)) {
  console.error("FATAL: 7za.real.exe not found, abort SEA build");
  process.exit(1);
}

// 准备 SEA 构建目录
fs.rmSync(seaBuild, { recursive: true, force: true });
fs.mkdirSync(seaBuild, { recursive: true });
const wrapperDst = path.join(seaBuild, "7za-wrapper.js");
fs.copyFileSync(srcWrapper, wrapperDst);

const seaConfig = path.join(seaBuild, "sea.json");
fs.writeFileSync(seaConfig, JSON.stringify({
  main: "7za-wrapper.js",
  output: "sea-prep.blob",
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}, null, 2));

// 1) 生成 blob
console.log("1/3: generate sea-prep.blob...");
const r1 = spawnSync(nodeExe, ["--experimental-sea-config", seaConfig], {
  stdio: ["ignore", "inherit", "inherit"], cwd: seaBuild,
});
if (r1.status !== 0) {
  console.log("SEA blob failed, abort → 切换为补丁 spawnSync 策略（.cmd + patch builder-util 强制用 shell:true）");
  patchBuilderUtilExec();
  process.exit(0);
}
const blob = path.join(seaBuild, "sea-prep.blob");
if (!fs.existsSync(blob)) { patchBuilderUtilExec(); process.exit(0); }

// 2) 复制 node.exe 为 7za (temp)
const tmpExe = path.join(seaBuild, "7za.tmp.exe");
fs.copyFileSync(nodeExe, tmpExe);

// 3) postject 注入
let injected = false;
try {
  // 优先使用项目内的 postject（若已安装），否则 npx
  const postjectCandidates = [
    path.join(process.cwd(), "node_modules", ".bin", "postject.cmd"),
    path.join(process.cwd(), "node_modules", "postject", "dist", "cli.js"),
  ];
  for (const c of postjectCandidates) {
    if (!fs.existsSync(c)) continue;
    const args = [tmpExe, "NODE_SEA_BLOB", blob,
      "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
    let r;
    if (c.endsWith(".js")) r = spawnSync(nodeExe, [c, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    else r = spawnSync(c, args, { stdio: ["ignore", "pipe", "pipe"] });
    if (r.status === 0) { injected = true; break; }
  }
  if (!injected) {
    // 尝试 npx postject
    const r2 = spawnSync("npx.cmd", ["-y", "postject",
      tmpExe, "NODE_SEA_BLOB", blob,
      "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"], {
      stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
    });
    if (r2.status === 0) injected = true;
    else { console.log("npx postject failed:", String(r2.stderr || r2.stdout || "").slice(-500)); }
  }
} catch (e) { console.log("postject exception:", e.message); }

if (injected) {
  // 覆盖项目内的 7za.exe（真实 exe 已在 real 备份）
  fs.copyFileSync(tmpExe, targetExe);
  // 也在 index.js 里把路径切回 .exe（现在 .exe 是 SEA wrapper）
  const idx = path.join(process.cwd(), "node_modules", "7zip-bin", "index.js");
  let c = fs.readFileSync(idx, "utf-8");
  c = c.replace('return path.join(__dirname, "win", process.arch, "7za.cmd")',
                'return path.join(__dirname, "win", process.arch, "7za.exe")');
  fs.writeFileSync(idx, c);
  console.log("✅ SEA 注入完成！path7za 现在指向包装好的 7za.exe（内部会 -x!darwin* 排除）");
} else {
  console.log("⚠️  SEA 注入失败，回退为补丁 builder-util exec 使其对 .cmd 用 shell:true");
  patchBuilderUtilExec();
}

function patchBuilderUtilExec() {
  // 把 index.js 保留为 .cmd 输出（此时 spawnSync(shell:false) 失败，所以需要补丁 builder-util 的 exec）
  // 搜索 builder-util 中调用 spawn 的代码，强制 shell:true，使 .cmd 能被 cmd.exe /c 加载
  const buCandidates = [
    path.join(process.cwd(), "node_modules", "builder-util", "out", "util", "util.js"),
    path.join(process.cwd(), "node_modules", "builder-util", "out", "index.js"),
    path.join(process.cwd(), "node_modules", "builder-util-runtime", "out", "httpExecutor.js"),
  ];
  // 找到 util.js：doSpawn 函数
  let patched = false;
  for (const p of buCandidates) {
    if (!fs.existsSync(p)) continue;
    let s = fs.readFileSync(p, "utf-8");
    // spawn 默认 options 插入 shell:true
    const before = s.length;
    s = s.replace(/(spawn\([^,]+,[^,]+,\s*options\s*=\s*\{)/g, (m) => `${m} shell:true, `);
    s = s.replace(/(spawn\([^,]+,[^,]+,\s*\{)(?!\s*shell)/g, (m) => `${m} shell:true, `);
    if (s.length !== before) {
      fs.writeFileSync(p, s);
      console.log("✅ 已补丁", path.relative(process.cwd(), p), "→ spawn 默认加 shell:true (.cmd 可运行)");
      patched = true;
    }
  }
  // 同样在 app-builder-lib 里
  const libP = path.join(process.cwd(), "node_modules", "app-builder-lib", "out", "targets", "archive.js");
  if (fs.existsSync(libP)) {
    let s = fs.readFileSync(libP, "utf-8");
    const before = s.length;
    s = s.replace(/(await\s*\(0,\s*builder_util_1\.exec\)\([^)]+\))/g, (m) => m); // 已通过 builder-util
    s = s.replace(/(\(0,\s*builder_util_2\.getPath7za\)\(\))/g, "$1");
    s = s.replace(/(spawnSync?\([^,]+,[^,]+,\s*\{)(?!\s*shell)/g, (m) => `${m} shell:true, `);
    if (s.length !== before) {
      fs.writeFileSync(libP, s);
      console.log("✅ 已补丁 app-builder-lib/targets/archive.js");
      patched = true;
    }
  }
  if (!patched) {
    console.log("⚠️  未找到可补丁的 spawn 位置，打包时 .cmd 可能失败。建议直接启用 Windows 开发者模式。");
  }
}
