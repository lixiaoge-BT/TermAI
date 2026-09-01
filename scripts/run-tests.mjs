// 测试运行器：用项目已有的 esbuild 把 TS 测试（含 @ 别名）打包成 ESM，
// 再用 Node 内置的 node:test 运行器执行（node:test 只在 `node --test` 下
// 自动注册并执行，动态 import 不会触发，因此这里显式起一个 --test 子进程）。
// 全程不联网装包、不依赖 vitest，适配受限沙箱环境。
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tests = [
  "src/services/agent.test.ts",
  "src/services/safety.test.ts",
  "src/services/ai.stream.test.ts",
  "electron/main/socks5.test.ts",
  "src/store/configImport.test.ts",
  "src/lib/splitLayout.test.ts",
  "src/lib/contextCompression.test.ts",
];

const bundled = [];
for (const t of tests) {
  const out = resolve(root, "dist-test", t.replace(/\.ts$/, ".mjs"));
  console.log(`\n=== bundling ${t} ===`);
  buildSync({
    entryPoints: [resolve(root, t)],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: out,
    alias: { "@": resolve(root, "src") },
    logLevel: "warning",
  });
  bundled.push(out);
}

console.log("\n=== running node --test ===");
const res = spawnSync(process.execPath, ["--test", ...bundled], {
  stdio: "inherit",
});
process.exit(res.status ?? 1);
