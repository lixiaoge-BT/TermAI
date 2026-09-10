// 测试运行器：用项目已有的 esbuild 把 TS 测试（含 @ 别名）打包成 ESM，
// 再用 Node 内置的 node:test 运行器执行（node:test 只在 `node --test` 下
// 自动注册并执行，动态 import 不会触发，因此这里显式起一个 --test 子进程）。
// 全程不联网装包、不依赖 vitest，适配受限沙箱环境。
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 自动发现所有 *.test.ts。
 * 之前这里是硬编码列表 —— 新写的测试忘了登记就会「不执行但全绿」，
 * 属于假通过。改为递归扫描，避免再次漏掉。
 */
function findTests(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist-test") continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...findTests(rel));
    else if (e.name.endsWith(".test.ts")) out.push(rel);
  }
  return out;
}

const tests = [...findTests("src"), ...findTests("electron")].sort();

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
