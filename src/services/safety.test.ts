import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reviewCommand, parseCommandsFromMarkdown } from "./safety";

describe("reviewCommand", () => {
  it("根目录删除为致命且需确认", () => {
    const r = reviewCommand("rm -rf /");
    assert.equal(r.riskLevel, "critical");
    assert.equal(r.requireConfirmation, true);
  });

  it("只读命令判定为 none", () => {
    const r = reviewCommand("ls -la");
    assert.equal(r.riskLevel, "none");
    assert.equal(r.requireConfirmation, false);
  });

  it("含重定向写判定为 medium", () => {
    const r = reviewCommand("cat a > b.txt");
    assert.equal(r.riskLevel, "medium");
  });

  it("关机/重启为 high", () => {
    const r = reviewCommand("reboot");
    assert.equal(r.riskLevel, "high");
    assert.equal(r.requireConfirmation, true);
  });

  it("生产环境写操作默认需确认", () => {
    const r = reviewCommand("cat a > b.txt", { isProduction: true });
    assert.equal(r.requireConfirmation, true);
  });

  it("空命令", () => {
    assert.equal(reviewCommand("").riskLevel, "none");
  });
});

describe("parseCommandsFromMarkdown", () => {
  it("提取命令并保留风险标注", () => {
    const cmds = parseCommandsFromMarkdown("```bash:risk=high\nrm -rf /\n```");
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].command, "rm -rf /");
    assert.equal(cmds[0].riskLevel, "high");
  });

  it("无风险标注时按内容推断", () => {
    const cmds = parseCommandsFromMarkdown("```sh\necho hello\n```");
    assert.equal(cmds[0].riskLevel, "none");
  });

  it("忽略无内容代码块", () => {
    assert.equal(parseCommandsFromMarkdown("```bash\n\n```").length, 0);
  });
});
