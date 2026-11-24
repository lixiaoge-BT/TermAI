// =====================================================
// 报告 → .docx（纯函数，无第三方依赖）
// -----------------------------------------------------
// .docx 就是一个 ZIP 里装几个 XML。这里只生成 Word 打开必需的四件套：
//   [Content_Types].xml          声明各部件的类型
//   _rels/.rels                  包级关系 → 指向正文
//   word/_rels/document.xml.rels 正文关系 → 指向样式
//   word/document.xml            正文
//   word/styles.xml              标题/代码样式（否则 Word 里全是一个字号的裸文本）
//
// 不生成 numbering.xml：列表用「• 」前缀 + 缩进表达，少一个部件就少一处能坏的地方。
// =====================================================

import { isAlignRow, splitRow, statusText, type ReportInput } from "./agentExport";
import { zipStore, type ZipEntry } from "./zip";

type DocBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "para"; text: string }
  | { type: "bullet"; text: string }
  | { type: "quote"; text: string }
  | { type: "code"; text: string }
  | { type: "table"; headers: string[]; rows: string[][] };

/**
 * XML 文本转义 + 控制符清理。
 *
 * 终端输出里可能带 \x01、\x0b 这类非法 XML 字符，Word 会直接报「内容有问题」
 * 打不开文件。所以**不只要转义，还要把这些字符删掉** —— 这是最容易漏、
 * 也最难排查的一种「文件生成了但打不开」。
 */
function esc(s: string): string {
  return String(s ?? "")
    // 非法 XML 1.0 字符（含 C0 控制符，保留 \t \n；\r 统一成 \n 由上层处理）
    // eslint-disable-next-line no-control-regex -- 这里就是要匹配并剔除控制符，不是正则写错
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 去掉 Markdown 行内标记，Word 里按纯文本呈现（不做富文本，避免半吊子渲染） */
function plainInline(raw: string): string {
  return String(raw ?? "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function run(text: string, opts: { bold?: boolean; mono?: boolean } = {}): string {
  const rPr =
    (opts.bold ? "<w:b/>" : "") +
    (opts.mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/>' : "");
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function para(text: string, style?: string): string {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${pPr}${text ? run(text) : ""}</w:p>`;
}

/** 代码块：一个段落内用 <w:br/> 换行，保留空行；每行单独转义 */
function codePara(text: string): string {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n");
  const body = lines
    .map((line, i) => (i === 0 ? "" : "<w:br/>") + (line ? run(line, { mono: true }) : ""))
    .join("");
  return `<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr>${body || run(" ", { mono: true })}</w:p>`;
}

function cell(text: string, header: boolean): string {
  const pPr = '<w:pPr><w:pStyle w:val="TableText"/></w:pPr>';
  const rPr = header ? "<w:rPr><w:b/></w:rPr>" : "";
  const content = text ? `<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>` : "";
  return (
    `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>` +
    (header ? '<w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/>' : "") +
    `</w:tcPr><w:p>${pPr}${content}</w:p></w:tc>`
  );
}

function tableXml(headers: string[], rows: string[][]): string {
  const width = Math.max(headers.length, 1);
  const border = (side: string) =>
    `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D0D4DA"/>`;
  const tblPr =
    "<w:tblPr>" +
    '<w:tblW w:w="5000" w:type="pct"/>' +
    `<w:tblBorders>${border("top")}${border("left")}${border("bottom")}${border("right")}` +
    `${border("insideH")}${border("insideV")}</w:tblBorders>` +
    "<w:tblLayout w:type=\"autofit\"/>" +
    "</w:tblPr>";

  const tr = (cells: string[], header: boolean) =>
    "<w:tr>" +
    Array.from({ length: width }, (_, i) => cell(cells[i] ?? "", header)).join("") +
    "</w:tr>";

  return (
    "<w:tbl>" +
    tblPr +
    tr(headers, true) +
    rows.map((r) => tr(r, false)).join("") +
    "</w:tbl>" +
    // Word 要求表格后必须有段落，否则表格会和下一段粘在一起
    '<w:p><w:pPr><w:pStyle w:val="TableGap"/></w:pPr></w:p>'
  );
}

/** 极简 Markdown → 文档块（只覆盖总结/计划里会出现的结构） */
export function markdownToBlocks(md: string): DocBlock[] {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: DocBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isAlignRow(lines[i + 1])) {
      const headers = splitRow(line).map(plainInline);
      const rows: string[][] = [];
      let j = i + 2;
      while (
        j < lines.length &&
        lines[j].trim() &&
        lines[j].includes("|") &&
        !isAlignRow(lines[j])
      ) {
        const cells = splitRow(lines[j]).map(plainInline);
        rows.push(headers.map((_, k) => cells[k] ?? ""));
        j += 1;
      }
      blocks.push({ type: "table", headers, rows });
      i = j;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      blocks.push({ type: "heading", level: Math.min(h[1].length, 3), text: plainInline(h[2]) });
      i += 1;
      continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      i += 1;
      continue;
    }

    const li = line.match(/^\s*[-*+]\s+(.*)$/);
    if (li) {
      blocks.push({ type: "bullet", text: plainInline(li[1]) });
      i += 1;
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      blocks.push({ type: "quote", text: plainInline(quote[1]) });
      i += 1;
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 连续非空行合成一段（原样保留换行，否则「每行一个段落」会拉得极长）
    const buf: string[] = [line.trim()];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(#{1,6}\s|[-*+]\s|>|\||```|---|\*\*\*)/.test(lines[i])
    ) {
      buf.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: "para", text: plainInline(buf.join("\n")) });
  }

  return blocks;
}

/**
 * 把块渲染成 XML。
 *
 * `baseLevel` 是这批块的「起点层级」：结论里的 `##` 属于「结论（H1）」的下一级，
 * 应该是 H2 而不是 H3。所以按「最小标题层级对齐到 baseLevel」来归一化，
 * 而不是简单地整体 +1 —— 后者会让 `##` 变成 H3、`###` 变成 H3（被 clamp 掉），
 * 层级看起来就塌了。
 */
function blocksToXml(blocks: DocBlock[], baseLevel = 2): string {
  const levels = blocks.filter((b) => b.type === "heading").map((b) => (b as { level: number }).level);
  const minLevel = levels.length ? Math.min(...levels) : 1;

  return blocks
    .map((b) => {
      switch (b.type) {
        case "heading": {
          const level = Math.min(3, Math.max(1, baseLevel + (b.level - minLevel)));
          return para(b.text, `Heading${level}`);
        }
        case "bullet":
          return para(`• ${b.text}`, "Bullet");
        case "quote":
          return para(b.text, "Quote");
        case "code":
          return codePara(b.text);
        case "table":
          return tableXml(b.headers, b.rows);
        default:
          return para(b.text);
      }
    })
    .join("");
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Segoe UI" w:eastAsia="Microsoft YaHei" w:hAnsi="Segoe UI"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="160"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="180" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Bullet"><w:name w:val="Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:ind w:left="360"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="C9CDD4"/></w:pBdr></w:pPr><w:rPr><w:color w:val="57606A"/><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/><w:spacing w:before="60" w:after="60" w:line="252" w:lineRule="auto"/><w:ind w:left="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TableGap"><w:name w:val="Table Gap"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:rPr><w:sz w:val="8"/><w:szCs w:val="8"/></w:rPr></w:style>
</w:styles>`;

/**
 * 生成报告 .docx。
 *
 * 结构刻意与 HTML 报告保持一致（目标 / 计划 / 结论 / 执行明细），
 * 这样用户拿到哪种格式看到的都是同一份内容，不会出现「Word 里少一段」的困惑。
 */
export function buildReportDocx(input: ReportInput): Uint8Array {
  const body: string[] = [];

  body.push(para(`TermAI 任务报告${input.host ? ` - ${input.host}` : ""}`, "Title"));

  const meta: string[] = [];
  if (input.host) meta.push(`主机 ${input.host}`);
  if (input.user) meta.push(`用户 ${input.user}`);
  if (input.startedAt) meta.push(`开始 ${new Date(input.startedAt).toLocaleString("zh-CN")}`);
  if (input.finishedAt) meta.push(`结束 ${new Date(input.finishedAt).toLocaleString("zh-CN")}`);
  const total = input.steps.reduce((n, s) => n + s.items.length, 0);
  const failed = input.steps.reduce(
    (n, s) =>
      n +
      s.items.filter(
        (it) => it.status === "failed" || (it.exitCode !== null && it.exitCode !== 0)
      ).length,
    0
  );
  meta.push(`共 ${input.steps.length} 步 / ${total} 条命令${failed ? ` / ${failed} 条失败` : ""}`);
  if (input.metricsLine) meta.push(input.metricsLine);
  body.push(para(meta.join("\u3000|\u3000"), "Quote"));

  body.push(para("目标", "Heading1"));
  body.push(para(input.goal?.trim() || "（未记录）"));

  if (input.plan?.trim()) {
    body.push(para("执行计划", "Heading1"));
    body.push(blocksToXml(markdownToBlocks(input.plan)));
  }

  body.push(para("结论", "Heading1"));
  body.push(
    input.summary?.trim()
      ? blocksToXml(markdownToBlocks(input.summary))
      : para("（本次没有生成总结）")
  );

  body.push(para("执行明细", "Heading1"));
  if (input.steps.length === 0) body.push(para("（本次没有执行任何命令）"));

  for (const step of input.steps) {
    const head = [`步骤 ${step.index}`];
    if (step.risk && step.risk !== "none") head.push(`风险 ${step.risk}`);
    if (step.batched) head.push("批量");
    body.push(para(head.join(" · "), "Heading2"));
    if (step.thought?.trim()) body.push(para(step.thought.trim(), "Quote"));

    step.items.forEach((it, k) => {
      body.push(para(`${step.index}-${k + 1} 命令`, "Heading3"));
      body.push(codePara(it.command));

      const dur =
        step.startedAt && step.finishedAt
          ? `${Math.max(0, step.finishedAt - step.startedAt)} ms`
          : "";
      body.push(para(`状态：${statusText(it)}${dur ? `\u3000耗时 ${dur}` : ""}`, "Quote"));

      const out = it.output || it.error || "";
      if (!out.trim()) {
        body.push(para("（无输出）", "Quote"));
        return;
      }
      if (it.fullOutput) body.push(para("完整输出", "Quote"));
      else if (/输出过长，已省略/.test(out)) {
        body.push(para("已截断：以下只是界面保留的片段，完整输出未落到运行记录。", "Quote"));
      }
      body.push(codePara(out));
    });
  }

  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body.join("")}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="851" w:footer="992" w:gutter="0"/>` +
    `</w:sectPr></w:body></w:document>`;

  const enc = new TextEncoder();
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: enc.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: enc.encode(ROOT_RELS) },
    { name: "word/_rels/document.xml.rels", data: enc.encode(DOC_RELS) },
    { name: "word/document.xml", data: enc.encode(document) },
    { name: "word/styles.xml", data: enc.encode(STYLES) },
  ];

  return zipStore(entries, new Date(input.startedAt || Date.now()));
}
