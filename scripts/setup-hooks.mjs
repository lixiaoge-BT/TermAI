// 一次性把本仓库的 git hooks 目录指向 .githooks（提交前自动跑 ESLint/类型检查/单测）。
// 不依赖 husky，也不需要联网。运行：npm run setup:hooks
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  execSync("git config core.hooksPath .githooks", { cwd: root, stdio: "inherit" });
  console.log("✅ git hooks 已指向 .githooks（pre-commit 钩子已生效）");
  console.log("   提交代码时会自动运行 ESLint / 类型检查 / 单元测试。");
} catch (e) {
  console.error("⚠️ 设置 git hooks 失败：", e.message);
  console.error("   请确认当前目录是一个 git 仓库（git rev-parse --show-toplevel）。");
  process.exit(1);
}
