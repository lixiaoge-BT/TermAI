import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildReportHtml,
  buildReportMarkdown,
  demoteHeadings,
  fenceFor,
  statusText,
  type ExportableStep,
} from "./agentExport";

const steps: ExportableStep[] = [
  {
    index: 1,
    thought: "先看磁盘",
    risk: "none",
    batched: false,
    status: "done",
    startedAt: new Date("2026-11-04T10:00:00").getTime(),
    finishedAt: new Date("2026-11-04T10:00:02").getTime(),
    items: [
      {
        command: "df -h",
        risk: "none",
        status: "done",
        output: "Filesystem Size Used Avail Use%\n/dev/sda1 50G 24G 24G 49%",
        exitCode: 0,
        timedOut: false,
      },
    ],
  },
  {
    index: 2,
    thought: "",
    risk: "medium",
    batched: true,
    status: "failed",
    startedAt: new Date("2026-11-04T10:00:03").getTime(),
    finishedAt: new Date("2026-11-04T10:00:04").getTime(),
    items: [
      {
        command: "systemctl restart nginx",
        risk: "medium",
        status: "failed",
        output: "",
        exitCode: 1,
        timedOut: false,
        error: "Job for nginx.service failed",
      },
      {
        command: "ps aux | head -5",
        risk: "none",
        status: "done",
        output: "",
        exitCode: 0,
        timedOut: true,
      },
    ],
  },
];

describe("buildReportHtml", () => {
  const html = buildReportHtml({
    goal: "看看磁盘",
    plan: "1. 查磁盘",
    summary: "## 结论摘要\n磁盘正常\n| 挂载点 | 使用率 |\n| --- | --- |\n| / | 49% |",
    steps,
    host: "192.168.188.128",
    user: "root",
    startedAt: new Date("2026-11-04T10:00:00").getTime(),
  });

  it("包含目标、计划、结论与执行明细", () => {
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.includes("看看磁盘"));
    assert.ok(html.includes("执行计划"));
    assert.ok(html.includes("执行明细"));
  });

  it("总结里的表格渲染成真表格", () => {
    assert.ok(html.includes("<table>"));
    assert.ok(html.includes("<th>挂载点</th>"));
  });

  it("命令用 details 折叠，输出原样保留", () => {
    assert.ok(html.includes("<details>"));
    assert.ok(html.includes("df -h"));
    assert.ok(html.includes("Filesystem Size Used Avail Use%"));
  });

  it("所有动态内容都转义（防注入）", () => {
    const evil = buildReportHtml({
      goal: "<script>alert(1)</script>",
      summary: "| a | b |\n| --- | --- |\n| <img src=x onerror=1> | 1 |",
      steps: [
        {
          index: 1,
          thought: "",
          risk: "none",
          batched: false,
          status: "done",
          items: [
            {
              command: "echo <b>x</b>",
              risk: "none",
              status: "done",
              output: "</pre><script>bad()</script>",
              exitCode: 0,
              timedOut: false,
            },
          ],
        },
      ],
    });
    assert.ok(!evil.includes("<script>"), "不得出现可执行脚本");
    assert.ok(!evil.includes("<img"), "表格单元格必须转义");
    assert.ok(evil.includes("&lt;script&gt;"));
  });

  it("不引用任何外部资源（单文件可分享）", () => {
    assert.ok(!/<link[^>]+href=/.test(html));
    assert.ok(!/<script/.test(html));
  });
});

describe("fenceFor", () => {
  it("内容里没有围栏时用三个反引号", () => {
    assert.equal(fenceFor("hello"), "```");
  });

  it("内容里已有围栏时自动加长，避免提前闭合", () => {
    // 输出里贴的是一段 Markdown 文档时，三个反引号会被内容里的围栏提前闭合，
    // 导出的文件从那一行往后全乱 —— 这是必须自适应的原因。
    assert.equal(fenceFor("a\n```js\nb\n```\n"), "````");
    assert.equal(fenceFor("`````"), "``````");
  });
});

describe("buildReportMarkdown", () => {
  const md = buildReportMarkdown({
    goal: "看看磁盘",
    plan: "1. 查磁盘",
    summary: "## 结论摘要\n磁盘正常\n| 挂载点 | 使用率 |\n| --- | --- |\n| / | 49% |",
    steps,
    host: "192.168.188.128",
    user: "root",
    startedAt: new Date("2026-11-04T10:00:00").getTime(),
    finishedAt: new Date("2026-11-04T10:00:05").getTime(),
  });

  it("四段结构齐全（目标 / 计划 / 结论 / 执行明细）", () => {
    assert.ok(md.startsWith("# TermAI 任务报告 - 192.168.188.128"));
    assert.ok(md.includes("## 目标"));
    assert.ok(md.includes("## 执行计划"));
    assert.ok(md.includes("## 结论"));
    assert.ok(md.includes("## 执行明细"));
  });

  it("结论原样嵌入，表格仍是 Markdown 表格", () => {
    assert.ok(md.includes("| 挂载点 | 使用率 |"));
    assert.ok(md.includes("| / | 49% |"));
  });

  it("命令与输出各用独立围栏，不会被当成文档结构", () => {
    assert.ok(md.includes("```bash"));
    assert.ok(md.includes("df -h"));
    assert.ok(md.includes("Filesystem Size Used Avail Use%"));
    assert.ok(md.includes("- 状态：成功"));
  });

  it("截断片段如实标注（不带死链）", () => {
    const trunc = buildReportMarkdown({
      goal: "g",
      summary: "",
      steps: [
        {
          index: 1,
          thought: "",
          risk: "none",
          batched: false,
          status: "done",
          items: [
            {
              command: "journalctl -u docker",
              risk: "none",
              status: "done",
              output: "头\n……（输出过长，已省略 90000 字符，完整输出请见终端）\n尾",
              exitCode: 0,
              timedOut: false,
            },
          ],
        },
      ],
    });
    assert.ok(trunc.includes("已截断"));
    assert.ok(!trunc.includes("outputs/"), "导出不再附带 log 文件，不能留死链");
  });

  it("拿到完整输出时标记为完整，而不是已截断", () => {
    const full = buildReportMarkdown({
      goal: "g",
      summary: "",
      steps: [
        {
          index: 1,
          thought: "",
          risk: "none",
          batched: false,
          status: "done",
          items: [
            {
              command: "journalctl -u docker",
              risk: "none",
              status: "done",
              output: "完整的一整段输出",
              exitCode: 0,
              timedOut: false,
              fullOutput: true,
            },
          ],
        },
      ],
    });
    assert.ok(full.includes("完整输出："));
    assert.ok(!full.includes("已截断"));
  });
});

describe("statusText", () => {
  const base = {
    command: "x",
    risk: "none",
    output: "",
    exitCode: 0,
    timedOut: false,
  };

  it("按状态与退出码给中文结果", () => {
    assert.equal(statusText({ ...base, status: "done" }), "成功");
    assert.equal(statusText({ ...base, status: "failed", exitCode: 2 }), "失败 · exit 2");
    assert.equal(statusText({ ...base, status: "skipped" }), "跳过");
    // 超时优先于退出码：超时的命令常常「exit 0 但没跑完」，只写 exit 0 会误导
    assert.equal(statusText({ ...base, status: "failed", timedOut: true }), "超时");
  });
});

describe("demoteHeadings", () => {
  it("标题整体降一级（结论嵌进「结论」章节后层级正确）", () => {
    const md = "## 结论摘要\ntext\n### 细节\nmore";
    const out = demoteHeadings(md);
    assert.ok(out.startsWith("### 结论摘要"));
    assert.ok(out.includes("#### 细节"));
  });

  it("代码围栏里的 # 不动（那是输出内容，不是文档结构）", () => {
    const md = "```bash\n# 安装依赖\nyum install -y x\n```";
    assert.equal(demoteHeadings(md), md);
  });

  it("最多降到 6 级，不会产出 ####### ", () => {
    assert.equal(demoteHeadings("###### x"), "###### x");
  });
});
