import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdownToHtml } from "./markdown";

describe("renderMarkdownToHtml 表格", () => {
  it("表头 + 对齐行 + 数据行渲染成 table", () => {
    const html = renderMarkdownToHtml(
      ["| 挂载点 | 容量 | 使用率 |", "| --- | --- | --- |", "| / | 50G | 49% |", "| /data | 200G | 12% |"].join("\n")
    );
    assert.ok(html.includes("<table"), "应当渲染出 table");
    assert.ok(html.includes("<thead"));
    assert.ok(html.includes("<th"), "表头应用 th");
    assert.ok(html.includes("挂载点"));
    assert.ok(html.includes("49%"));
    assert.equal((html.match(/<td/g) ?? []).length, 6, "两行三列应有 6 个 td");
  });

  it("对齐行本身不会变成数据行", () => {
    const html = renderMarkdownToHtml("| a | b |\n| --- | --- |\n| 1 | 2 |");
    assert.equal((html.match(/<td/g) ?? []).length, 2, "对齐行不能被当成一条数据");
    assert.ok(!html.includes("---"), "对齐行的横线不应出现在输出里");
  });

  it("首尾没有竖线的表格也能识别", () => {
    const html = renderMarkdownToHtml("名称 | 值\n--- | ---\ncpu | 8");
    assert.ok(html.includes("<table"));
    assert.ok(html.includes("cpu"));
  });

  it("单元格内转义的竖线当成内容，不切列", () => {
    const html = renderMarkdownToHtml("| 命令 | 说明 |\n| --- | --- |\n| `grep a\\|b` | 匹配 a 或 b |");
    assert.equal((html.match(/<td/g) ?? []).length, 2, "转义竖线不能多切一列");
    assert.ok(html.includes("a|b"), "内容里的竖线要还原");
  });

  it("单元格支持粗体与行内代码", () => {
    const html = renderMarkdownToHtml("| **名称** | 值 |\n| --- | --- |\n| `df -h` | 1 |");
    assert.ok(html.includes("<strong>名称</strong>"));
    assert.ok(html.includes("<code"));
  });

  it("列数不齐时补空单元格，不塌成锯齿", () => {
    const html = renderMarkdownToHtml("| a | b | c |\n| --- | --- | --- |\n| 1 |");
    assert.equal((html.match(/<td/g) ?? []).length, 3, "缺的列要补空 td");
  });

  it("代码块里的表格不渲染（fence 优先）", () => {
    const html = renderMarkdownToHtml("```bash\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```");
    assert.ok(!html.includes("<table"), "代码块内的竖线是内容");
    assert.ok(html.includes("<pre"));
  });

  it("正文里带一条竖线不会被误判成表格", () => {
    const html = renderMarkdownToHtml("这条命令 a | b 只是举例说明");
    assert.ok(!html.includes("<table"));
    assert.ok(html.includes("a | b"));
  });

  it("表格单元格内容做 HTML 转义（防注入）", () => {
    const html = renderMarkdownToHtml(
      "| 名称 | 值 |\n| --- | --- |\n| <img src=x onerror=alert(1)> | 1 |"
    );
    assert.ok(html.includes("&lt;img"), "尖括号必须转义");
    assert.ok(!html.includes("<img"), "不得输出未转义标签");
  });

  it("表格结束后紧跟的正文不被吞进表格", () => {
    const html = renderMarkdownToHtml("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n## 结论摘要\n完成");
    assert.ok(html.includes("<table"));
    assert.ok(html.includes("结论摘要"), "表格后的正文必须照常渲染");
  });
});

describe("renderMarkdownToHtml 既有语法不回退", () => {
  it("标题 / 列表 / 分隔线仍然正常", () => {
    const html = renderMarkdownToHtml("## 结论\n---\n- 第一项\n- 第二项");
    assert.ok(html.includes("font-bold"));
    assert.ok(html.includes("border-t"));
    assert.ok(html.includes("• 第一项"));
  });

  it("代码块内容整体转义", () => {
    const html = renderMarkdownToHtml("```bash\nif [ 1 -lt 2 ]; then echo '<x>'; fi\n```");
    assert.ok(html.includes("&lt;x&gt;"));
  });
});
