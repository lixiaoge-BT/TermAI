import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractManualSection, findDeferrableCommands } from "./manualPush";

describe("extractManualSection", () => {
  it("取到 ## 段落，并在下一个标题处截断", () => {
    const md = [
      "## 结论摘要",
      "装不上，包冲突。",
      "## 需要手动执行的操作",
      "- 卸载冲突包：`yum remove -y zabbix-get`",
      "- 重装：`yum install -y zabbix-server`",
      "## 优化建议",
      "- 换源",
    ].join("\n");
    const s = extractManualSection(md);
    assert.ok(s?.includes("yum remove -y zabbix-get"));
    assert.ok(!s?.includes("换源"), "下一个标题之后的内容不算本段");
  });

  it("兼容加粗小标题写法", () => {
    const md = ["**需要手动执行的操作**", "- `systemctl restart nginx`"].join("\n");
    assert.match(extractManualSection(md) ?? "", /systemctl restart nginx/);
  });

  it("没有该段落返回 null", () => {
    assert.equal(extractManualSection("## 结论摘要\n一切正常。"), null);
  });
});

describe("findDeferrableCommands", () => {
  it("挑出包管理/服务管理这类「引擎自己能下发」的变更命令", () => {
    const md = [
      "## 需要手动执行的操作",
      "- 卸载冲突包：`yum remove -y zabbix-get`",
      "- 重新安装：`yum install -y zabbix-server zabbix-web`",
      "- 启动服务：`systemctl enable --now zabbix-server`",
    ].join("\n");
    const got = findDeferrableCommands(md);
    assert.equal(got.length, 3);
    assert.ok(got[0].includes("yum remove"));
  });

  it("只读确认命令不算推卸（留在手动清单是合理的）", () => {
    const md = [
      "## 需要手动执行的操作",
      "- 用 `ls -l /usr/bin/zabbix_get` 确认属主",
      "- 用 `rpm -qf /usr/bin/zabbix_get` 查冲突来源",
    ].join("\n");
    assert.deepEqual(findDeferrableCommands(md), []);
  });

  it("写「无」时返回空", () => {
    assert.deepEqual(findDeferrableCommands("## 需要手动执行的操作\n无"), []);
  });

  it("段落之外出现的命令不算（避免误伤正文里的交代）", () => {
    const md = ["## 关键发现", "已执行 `yum install -y zabbix-get`，失败。", "## 需要手动执行的操作", "无"].join(
      "\n"
    );
    assert.deepEqual(findDeferrableCommands(md), []);
  });

  it("至少拦住本次事故里那两条原样重跑的命令", () => {
    const md = [
      "## 需要手动执行的操作",
      "- **卸载冲突包**：`yum remove -y zabbix-get`",
      "- **重新尝试安装**：`yum install -y zabbix-server zabbix-web zabbix-agent zabbix-sqlite3`",
    ].join("\n");
    const got = findDeferrableCommands(md);
    assert.equal(got.length, 2, "两条都必须被挑出来（行首有加粗也要命中）");
  });
});
