import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReportDocx, markdownToBlocks } from "./docx";
import { crc32, zipStore } from "./zip";
import type { ReportInput } from "./agentExport";

interface ZipReadEntry {
  name: string;
  method: number;
  crc: number;
  content: Uint8Array;
}

/**
 * 极简 ZIP 读取器（只为本测试存在）。
 *
 * 为什么要在测试里反向解析：docx 打不开是导出功能最致命的问题，而「文件生成了」
 * 完全不代表「文件合法」。这里逐个校验条目 CRC、方法、本地头偏移，
 * 等于自己给自己当了一次解压器。
 */
function readZip(data: Uint8Array): ZipReadEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  let eocd = -1;
  for (let i = data.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, "找不到 EOCD（文件不是合法 ZIP）");

  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const entries: ZipReadEntry[] = [];
  let p = cdOffset;

  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(p, true), 0x02014b50, `第 ${i} 个中央目录项签名错误`);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const usize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(data.subarray(p + 46, p + 46 + nameLen));

    assert.equal(view.getUint32(localOffset, true), 0x04034b50, `${name} 本地头签名错误`);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const content = data.subarray(start, start + usize);

    entries.push({ name, method, crc, content });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function text(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

const START = new Date(2026, 10, 4, 15, 30, 0).getTime();

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    goal: "看看磁盘",
    plan: "1. 查磁盘\n2. 汇总",
    summary: "## 结论摘要\n磁盘正常\n\n| 挂载点 | 使用率 |\n| --- | --- |\n| / | 49% |",
    host: "192.168.188.128",
    user: "root",
    startedAt: START,
    finishedAt: START + 5000,
    metricsLine: "LLM 3 次",
    steps: [
      {
        index: 1,
        thought: "先看磁盘",
        risk: "none",
        batched: false,
        status: "done",
        startedAt: START,
        finishedAt: START + 120,
        items: [
          {
            command: "df -h",
            risk: "none",
            status: "done",
            output: "Filesystem Size Used Avail Use%\n/dev/sda1 50G 25G 25G 50%",
            exitCode: 0,
            timedOut: false,
          },
        ],
      },
    ],
    ...over,
  };
}

describe("zipStore", () => {
  it("每个条目的 CRC 与内容自洽", () => {
    const enc = new TextEncoder();
    const a = enc.encode("hello zip");
    const b = enc.encode("第二个条目：中文内容");
    const entries = readZip(
      zipStore([
        { name: "a.txt", data: a },
        { name: "dir/b.txt", data: b },
      ])
    );

    assert.deepEqual(
      entries.map((e) => e.name),
      ["a.txt", "dir/b.txt"]
    );
    for (const e of entries) {
      assert.equal(e.method, 0, "只使用 STORE，不压缩");
      assert.equal(crc32(e.content), e.crc, `${e.name} CRC 不一致`);
    }
    assert.equal(text(entries[0].content), "hello zip");
    assert.equal(text(entries[1].content), "第二个条目：中文内容");
  });

  it("空文件也是合法条目（CRC 为 0）", () => {
    const [e] = readZip(zipStore([{ name: "empty.txt", data: new Uint8Array(0) }]));
    assert.equal(e.content.length, 0);
    assert.equal(e.crc, 0);
  });
});

describe("markdownToBlocks", () => {
  it("识别标题、列表、表格与代码块", () => {
    const blocks = markdownToBlocks(
      ["## 结论", "- 正常", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "", "```", "raw", "```"].join(
        "\n"
      )
    );
    assert.deepEqual(
      blocks.map((b) => b.type),
      ["heading", "bullet", "table", "code"]
    );
  });
});

describe("buildReportDocx", () => {
  const entries = readZip(buildReportDocx(input()));
  const byName = new Map(entries.map((e) => [e.name, e]));

  it("包含 Word 打开所需的五个部件", () => {
    assert.deepEqual(
      entries.map((e) => e.name),
      [
        "[Content_Types].xml",
        "_rels/.rels",
        "word/_rels/document.xml.rels",
        "word/document.xml",
        "word/styles.xml",
      ]
    );
  });

  it("正文含目标、结论、执行明细与命令输出", () => {
    const doc = text(byName.get("word/document.xml")!.content);
    assert.ok(doc.includes("TermAI 任务报告 - 192.168.188.128"));
    assert.ok(doc.includes("目标"));
    assert.ok(doc.includes("执行明细"));
    assert.ok(doc.includes("df -h"));
    assert.ok(doc.includes("Filesystem Size Used Avail Use%"));
    assert.ok(doc.startsWith("<?xml"));
    assert.ok(doc.includes("</w:body></w:document>"));
  });

  it("样式表里有标题与代码样式（否则全是裸文本）", () => {
    const styles = text(byName.get("word/styles.xml")!.content);
    for (const id of ["Heading1", "Heading2", "Heading3", "Code", "Bullet"]) {
      assert.ok(styles.includes(`w:styleId="${id}"`), `缺少样式 ${id}`);
    }
  });

  it("总结里的表格变成 Word 表格", () => {
    const doc = text(byName.get("word/document.xml")!.content);
    assert.ok(doc.includes("<w:tbl>"));
    assert.ok(doc.includes("<w:tc>"));
    assert.ok(doc.includes("挂载点"));
  });

  it("多行命令用 <w:br/> 换行而不是拆成多个段落", () => {
    const doc = text(
      readZip(
        buildReportDocx(
          input({
            steps: [
              {
                index: 1,
                thought: "",
                risk: "none",
                batched: false,
                status: "done",
                items: [
                  {
                    command: "cat > /tmp/a <<'EOF'\nhello\nEOF",
                    risk: "medium",
                    status: "done",
                    output: "",
                    exitCode: 0,
                    timedOut: false,
                  },
                ],
              },
            ],
          })
        )
      ).find((e) => e.name === "word/document.xml")!.content
    );
    assert.ok(doc.includes("<w:br/>"));
    assert.ok(doc.includes("hello"));
  });

  it("XML 特殊字符转义、控制符被剔除（否则 Word 报文件损坏）", () => {
    const doc = text(
      readZip(
        buildReportDocx(
          input({
            goal: '<script>alert("x")</script>',
            summary: "输出里有控制符：\u0001\u0007 结束",
            steps: [],
          })
        )
      ).find((e) => e.name === "word/document.xml")!.content
    );
    assert.ok(doc.includes("&lt;script&gt;"));
    assert.ok(doc.includes("&quot;x&quot;"));
    assert.ok(!doc.includes("\u0001"), "控制符必须剔除");
    assert.ok(!doc.includes("<script>"), "不能出现未转义标签");
  });

  it("没有命令时给出「未执行任何命令」而不是空白文档", () => {
    const doc = text(
      readZip(buildReportDocx(input({ steps: [], summary: "" }))).find(
        (e) => e.name === "word/document.xml"
      )!.content
    );
    assert.ok(doc.includes("（本次没有生成总结）"));
    assert.ok(doc.includes("（本次没有执行任何命令）"));
  });
});
