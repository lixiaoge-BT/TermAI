import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildExportBundle, outputFileName, runFolderName, toBase64 } from "./exportRun";
import type { ExportableStep } from "./agentExport";

const start = new Date(2026, 10, 4, 15, 30, 0).getTime(); // 2026-11-04 15:30

function step(index: number, output: string): ExportableStep {
  return {
    index,
    thought: "",
    risk: "none",
    batched: false,
    status: "done",
    startedAt: start,
    finishedAt: start + 120,
    items: [
      {
        command: `cmd-${index}`,
        risk: "none",
        status: "done",
        output,
        exitCode: 0,
        timedOut: false,
      },
    ],
  };
}

const TRUNC = "头\n……（输出过长，已省略 90000 字符，完整输出请见终端）\n尾";

function fileOf(bundle: ReturnType<typeof buildExportBundle>, path: string): string {
  const f = bundle.files.find((x) => x.path === path);
  assert.ok(f, `缺少 ${path}`);
  assert.equal(f.encoding, undefined, `${path} 应该是 utf8 文本`);
  return f.content;
}

function bytesOf(bundle: ReturnType<typeof buildExportBundle>, path: string): Uint8Array {
  const f = bundle.files.find((x) => x.path === path);
  assert.ok(f, `缺少 ${path}`);
  assert.equal(f.encoding, "base64");
  return new Uint8Array(Buffer.from(f.content, "base64"));
}

describe("outputFileName", () => {
  it("步骤序号补零到 3 位，命令序号从 1 开始", () => {
    assert.equal(outputFileName(1, 0), "001-1.log");
    assert.equal(outputFileName(12, 2), "012-3.log");
    assert.equal(outputFileName(100, 0), "100-1.log");
  });

  it("与主进程落盘命名一致（003-2.log 形态）", () => {
    // 主进程是 `${padStart(3,"0")}-${itemIndex+1}.log`，两边必须相同，
    // 否则取回完整输出时 key 对不上，正文会一直是截断片段。
    assert.match(outputFileName(3, 1), /^003-2\.log$/);
  });
});

describe("runFolderName", () => {
  it("包含时间戳与主机地址", () => {
    assert.equal(runFolderName("192.168.188.128", start), "termai-20261104-1530-192.168.188.128");
  });

  it("主机名里的非法字符被替换", () => {
    assert.equal(runFolderName("web:prod/01", start), "termai-20261104-1530-web-prod-01");
  });

  it("没有主机名时只留时间戳", () => {
    assert.equal(runFolderName(undefined, start), "termai-20261104-1530");
    assert.equal(runFolderName("   ", start), "termai-20261104-1530");
  });
});

describe("buildExportBundle", () => {
  it("固定只产出 html / md / docx 三份，不再带 csv 与 log", () => {
    const b = buildExportBundle({
      goal: "看磁盘",
      summary: "## 结论\n一切正常",
      steps: [step(1, "ok")],
      host: "10.0.0.1",
      startedAt: start,
      runId: "run-1",
      fullOutputs: { "001-1.log": "ok" },
    });
    assert.deepEqual(
      b.files.map((f) => f.path),
      ["report.html", "report.md", "report.docx"]
    );
    assert.equal(b.defaultName, "termai-20261104-1530-10.0.0.1");
  });

  it("docx 是真 ZIP（PK\\x03\\x04 开头），且走 base64 传输", () => {
    const b = buildExportBundle({ goal: "g", summary: "", steps: [step(1, "x")], startedAt: start });
    const bytes = bytesOf(b, "report.docx");
    assert.ok(bytes.length > 500, `docx 太小，可能没写内容：${bytes.length}`);
    assert.equal(bytes[0], 0x50);
    assert.equal(bytes[1], 0x4b);
    assert.equal(bytes[2], 0x03);
    assert.equal(bytes[3], 0x04);
  });

  it("拿到完整输出时替换掉界面里的截断片段", () => {
    const full = `${"完整输出行\n".repeat(60)}`;
    const b = buildExportBundle({
      goal: "g",
      summary: "",
      steps: [step(1, TRUNC)],
      startedAt: start,
      fullOutputs: { "001-1.log": full },
    });
    const md = fileOf(b, "report.md");
    const html = fileOf(b, "report.html");
    assert.ok(md.includes("完整输出行"), "md 应含完整输出");
    assert.ok(!md.includes("已截断"), "拿到全文就不该说已截断");
    assert.ok(html.includes("完整输出（"), "html 应标注完整输出字符数");
    assert.ok(!html.includes("已截断"));
  });

  it("没有完整输出时如实标注截断，且不留死链", () => {
    const b = buildExportBundle({
      goal: "g",
      summary: "",
      steps: [step(1, TRUNC)],
      startedAt: start,
    });
    const html = fileOf(b, "report.html");
    const md = fileOf(b, "report.md");
    assert.ok(html.includes("已截断"));
    assert.ok(md.includes("已截断"));
    assert.ok(!html.includes("outputs/"));
    assert.ok(!md.includes("outputs/"));
  });

  it("日志比界面片段还短时不覆盖（任务未结束时导出）", () => {
    const b = buildExportBundle({
      goal: "g",
      summary: "",
      steps: [step(1, "界面里已经有这整段输出")],
      startedAt: start,
      fullOutputs: { "001-1.log": "半截" },
    });
    assert.ok(fileOf(b, "report.md").includes("界面里已经有这整段输出"));
  });

  it("总结里的表格在 md 与 html 里都保留成表格", () => {
    const summary = ["## 磁盘", "| 挂载点 | 使用率 |", "| --- | --- |", "| / | 50% |"].join("\n");
    const b = buildExportBundle({ goal: "g", summary, steps: [], startedAt: start });
    assert.ok(fileOf(b, "report.md").includes("| 挂载点 | 使用率 |"));
    assert.ok(fileOf(b, "report.html").includes("<th>挂载点</th>"));
  });

  it("runId 透传给主进程（用于取回完整输出）", () => {
    const b = buildExportBundle({
      goal: "g",
      summary: "",
      steps: [],
      startedAt: start,
      runId: "run-123",
    });
    assert.equal(b.runId, "run-123");
  });

  it("hostName 优先于 host 作为目录名", () => {
    const b = buildExportBundle({
      goal: "g",
      summary: "",
      steps: [],
      host: "192.168.188.128",
      hostName: "web01",
      startedAt: start,
    });
    assert.equal(b.defaultName, "termai-20261104-1530-web01");
  });
});

describe("toBase64", () => {
  it("覆盖三种填充边界", () => {
    assert.equal(toBase64(new Uint8Array([])), "");
    assert.equal(toBase64(new Uint8Array([0x66])), "Zg==");
    assert.equal(toBase64(new Uint8Array([0x66, 0x6f])), "Zm8=");
    assert.equal(toBase64(new Uint8Array([0x66, 0x6f, 0x6f])), "Zm9v");
  });

  it("与 Node 的 Buffer 结果一致（随机字节对拍）", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = new Uint8Array(Array.from({ length: n }, (_, i) => (i * 31 + n) & 0xff));
      assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"), `长度 ${n} 不一致`);
    }
  });
});
