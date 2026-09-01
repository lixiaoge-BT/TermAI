// 使用 esbuild 编译 Electron 主进程和 preload
import { build, context } from "esbuild";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_MAIN = join(ROOT, "dist-electron/main");
const OUT_PRELOAD = join(ROOT, "dist-electron/preload");

const mode = process.argv[2] || "build"; // build | watch

function clean() {
  // 不递归删除 dist-electron（避免触发沙箱安全删除机制）；esbuild 会覆盖同名输出文件。
  if (!existsSync(OUT_MAIN)) mkdirSync(OUT_MAIN, { recursive: true });
  if (!existsSync(OUT_PRELOAD)) mkdirSync(OUT_PRELOAD, { recursive: true });
}

// 主进程：ESM 格式
const mainOpts = {
  bundle: true,
  sourcemap: mode === "watch" ? "inline" : false,
  platform: "node",
  target: "node20",
  format: "esm",
  legalComments: "none",
  logLevel: "info",
  external: ["electron", "ssh2", "cpu-features", "encoding", "nan", "node-gyp-build"],
  entryPoints: [join(ROOT, "electron/main/index.ts")],
  outfile: join(OUT_MAIN, "index.js"),
  packages: "external",
};

// 预加载脚本：CJS 格式（Electron contextIsolation 兼容性更可靠）
const preloadOpts = {
  bundle: true,
  sourcemap: mode === "watch" ? "inline" : false,
  platform: "node",
  target: "node20",
  format: "cjs",
  legalComments: "none",
  logLevel: "info",
  external: ["electron"],
  entryPoints: [join(ROOT, "electron/preload/index.ts")],
  outfile: join(OUT_PRELOAD, "index.cjs"),  // .cjs 确保被当作 CJS
};

async function main() {
  clean();

  if (mode === "watch") {
    console.log("[electron] 启用 watch 模式...");
    const mainCtx = await context(mainOpts);
    const preCtx = await context(preloadOpts);
    await Promise.all([mainCtx.watch(), preCtx.watch()]);
    console.log("[electron] 首次编译完成，等待文件变更...");
    process.on("SIGINT", async () => {
      await Promise.all([mainCtx.dispose(), preCtx.dispose()]);
      process.exit(0);
    });
  } else {
    await build(mainOpts);
    await build(preloadOpts);
    console.log("[electron] 编译完成 → dist-electron/");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
