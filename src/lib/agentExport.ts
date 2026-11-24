// =====================================================
// Agent 任务导出：把一次接管的结果转成「可交付的文件内容」
// -----------------------------------------------------
// 全部是纯函数（不进 store、不碰 fs、不依赖 DOM），这样：
//  · 导出格式可以单测到字节级，不用起 Electron；
//  · 主进程只负责「把字符串写到用户选的路径」，逻辑不重复。
//
// 为什么不用 @/lib/markdown 的渲染器：它输出的是 Tailwind 类名，
// 而导出的 HTML 文件是独立文档、没有项目 CSS —— 拿过去会掉成裸样式。
// 所以这里自带一套极简的内联样式渲染。
// =====================================================

/** 导出所需的最小结构：AgentStep 结构兼容，避免 lib 反向依赖 store */
export interface ExportableCommand {
  command: string;
  risk: string;
  status: string;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
  /**
   * output 已经是「完整输出」而不是界面里被 capOutput 砍过的片段。
   *
   * 导出只有 html / md / docx 三种文件，不再附带 outputs/*.log，
   * 所以完整输出必须内联进正文 —— 由调用方先从运行记录里取回全文再替换。
   */
  fullOutput?: boolean;
}

export interface ExportableStep {
  index: number;
  thought: string;
  items: ExportableCommand[];
  risk: string;
  batched: boolean;
  status: string;
  startedAt?: number;
  finishedAt?: number;
}

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 按未转义的竖线切分表格行（`\|` 表示单元格内的竖线） */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);

  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      buf += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push(buf);
  return cells.map((c) => c.trim());
}

export function isAlignRow(line: string): boolean {
  const s = line.trim();
  if (!s || !s.includes("-")) return false;
  if (!/^[|\-:\s]+$/.test(s)) return false;
  const cells = splitRow(s);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

// ==================================================================
// 时间格式
// ==================================================================

function fmtTime(ms?: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ==================================================================
// 报告 HTML（独立文档，自带样式）
// ==================================================================

export interface ReportInput {
  goal: string;
  plan?: string;
  summary: string;
  steps: ExportableStep[];
  host?: string;
  user?: string;
  startedAt?: number;
  finishedAt?: number;
  /** 由调用方给出，避免 lib 依赖 store 的 metrics 类型 */
  metricsLine?: string;
}

const STYLE = `
*{box-sizing:border-box}
body{margin:0;padding:24px;background:#f6f7f9;color:#1f2328;
  font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1000px;margin:0 auto}
h1{font-size:18px;margin:0 0 4px}
.meta{color:#6b7280;font-size:12px;margin-bottom:18px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:14px}
.card h2{font-size:14px;margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid #eee}
pre{margin:8px 0 0;padding:10px;background:#f6f8fa;border:1px solid #e5e7eb;border-radius:6px;
  overflow:auto;font:11px/1.5 Consolas,"Courier New",monospace;white-space:pre-wrap;word-break:break-all;max-height:420px}
code{background:#f0f1f3;padding:1px 4px;border-radius:3px;font-family:Consolas,monospace;font-size:0.92em}
table{border-collapse:collapse;width:100%;font-size:12px;margin:10px 0}
th,td{border:1px solid #dcdfe4;padding:5px 8px;text-align:left;vertical-align:top}
th{background:#f3f4f6;font-weight:600}
details{margin:6px 0;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden}
details>summary{cursor:pointer;padding:8px 10px;background:#fafbfc;font:12px Consolas,monospace;
  white-space:pre-wrap;word-break:break-all;list-style:none}
details>summary::-webkit-details-marker{display:none}
details[open]>summary{border-bottom:1px solid #e5e7eb}
.badge{display:inline-block;padding:0 6px;border-radius:10px;font-size:11px;margin-left:6px}
.ok{background:#e6f4ea;color:#1a7f37}.fail{background:#fde8e8;color:#b42318}
.skip{background:#f3f4f6;color:#6b7280}
ul{margin:6px 0;padding-left:20px}
.li{margin:2px 0}
hr{border:0;border-top:1px solid #e5e7eb;margin:12px 0}
`;

/** 极简 Markdown → HTML（只覆盖总结里会出现的：标题/列表/分隔线/表格/代码块/行内） */
function mdToHtml(md: string): string {
  const lines = String(md ?? "").split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  let inList = false;

  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (/^\s*```/.test(line)) {
      closeList();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(`<pre>${escapeHtml(body.join("\n"))}</pre>`);
      continue;
    }

    // 表格
    if (line.includes("|") && i + 1 < lines.length && isAlignRow(lines[i + 1])) {
      closeList();
      const headers = splitRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes("|") && !isAlignRow(lines[j])) {
        const cells = splitRow(lines[j]);
        rows.push(headers.map((_, k) => cells[k] ?? ""));
        j += 1;
      }
      out.push(
        "<table><thead><tr>" +
          headers.map((h) => `<th>${inline(h)}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") +
          "</tbody></table>"
      );
      i = j;
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      closeList();
      const level = Math.min(h[1].length + 1, 6);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // 分隔线
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      closeList();
      out.push("<hr>");
      i += 1;
      continue;
    }

    // 列表
    const li = line.match(/^\s*[-*+]\s+(.*)$/);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li class="li">${inline(li[1])}</li>`);
      i += 1;
      continue;
    }

    if (!line.trim()) {
      closeList();
      i += 1;
      continue;
    }

    closeList();
    out.push(`<div>${inline(line)}</div>`);
    i += 1;
  }
  closeList();
  return out.join("\n");
}

/** 行内：转义后处理 `code` / **粗体** / 链接 */
function inline(raw: string): string {
  let s = escapeHtml(raw);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(
    /(https?:\/\/[^\s<)"']+)/g,
    '<a href="$1" target="_blank" rel="noreferrer">$1</a>'
  );
  return s;
}

function statusBadge(it: ExportableCommand): string {
  if (it.status === "skipped") return `<span class="badge skip">跳过</span>`;
  if (it.timedOut) return `<span class="badge fail">超时</span>`;
  if (it.status === "failed" || (it.exitCode !== null && it.exitCode !== 0)) {
    return `<span class="badge fail">失败${it.exitCode !== null && it.exitCode !== 0 ? ` · exit ${it.exitCode}` : ""}</span>`;
  }
  return `<span class="badge ok">成功</span>`;
}

/** 步骤/命令统计（HTML 与 Markdown 共用，避免两边口径不一样） */
function reportCounts(input: ReportInput): { total: number; failed: number } {
  const total = input.steps.reduce((n, s) => n + s.items.length, 0);
  const failed = input.steps.reduce(
    (n, s) =>
      n +
      s.items.filter((it) => it.status === "failed" || (it.exitCode !== null && it.exitCode !== 0))
        .length,
    0
  );
  return { total, failed };
}

/** 报告元信息（主机 / 用户 / 时间 / 统计 / LLM 用量） */
function reportMetaParts(input: ReportInput): string[] {
  const started = fmtTime(input.startedAt);
  const ended = fmtTime(input.finishedAt);
  const { total, failed } = reportCounts(input);
  return [
    input.host ? `主机 ${input.host}` : "",
    input.user ? `用户 ${input.user}` : "",
    started ? `开始 ${started}` : "",
    ended ? `结束 ${ended}` : "",
    `共 ${input.steps.length} 步 / ${total} 条命令${failed ? ` / ${failed} 条失败` : ""}`,
    input.metricsLine ?? "",
  ].filter(Boolean);
}

/**
 * 纯文本状态：Markdown / Word 里没有徽章，只能写文字。
 *
 * 超时优先于退出码：超时的命令常常「exit 0 但没跑完」，只写 exit 0 会误导。
 */
export function statusText(it: ExportableCommand): string {
  if (it.status === "skipped") return "跳过";
  if (it.timedOut) return "超时";
  if (it.status === "failed" || (it.exitCode !== null && it.exitCode !== 0)) {
    return it.exitCode !== null && it.exitCode !== 0 ? `失败 · exit ${it.exitCode}` : "失败";
  }
  return "成功";
}

/**
 * 生成单文件 HTML 报告。
 *
 * 为什么是 HTML 而不是 md：完整输出动辄几十 MB，md 里只能贴成巨型代码块，
 * 阅读体验崩溃；HTML 用 `<details>` 折叠，默认只看到命令与结论，点开才是全量输出。
 * 单文件、无外部依赖，直接发同事就能看。
 */
export function buildReportHtml(input: ReportInput): string {
  const metaParts = reportMetaParts(input);

  const stepBlocks = input.steps
    .map((step) => {
      const items = step.items
        .map((it) => {
          const dur =
            step.startedAt && step.finishedAt
              ? `${Math.max(0, step.finishedAt - step.startedAt)} ms`
              : "";
          // 正文里出现这句就说明它被 capOutput 截过。导出不再附带 outputs/*.log，
          // 所以「是否完整」只能如实标注：拿到全文写「完整输出」，拿不到就说明是片段，
          // 不能让人误以为文件里已经是全部内容。
          const truncated = /输出过长，已省略/.test(it.output || "");
          const note = it.fullOutput
            ? `<div class="meta">完整输出（${(it.output || "").length.toLocaleString("en-US")} 字符）</div>`
            : truncated
              ? `<div class="meta">已截断：以下只是界面保留的片段（前 1.6k / 后 1.6k 字符）。` +
                `完整输出未落到运行记录（超限或任务未结束时导出），可在终端回滚里查看。</div>`
              : "";
          return (
            `<details>` +
            `<summary>$ ${escapeHtml(it.command)}${statusBadge(it)}${
              dur ? `<span class="badge skip">${dur}</span>` : ""
            }</summary>` +
            `<pre>${escapeHtml(it.output || it.error || "（无输出）")}</pre>` +
            note +
            `</details>`
          );
        })
        .join("\n");

      return (
        `<div class="card">` +
        `<h2>步骤 ${step.index}${step.risk ? ` · 风险 ${escapeHtml(step.risk)}` : ""}${
          step.batched ? " · 批量" : ""
        }</h2>` +
        (step.thought ? `<div class="meta">${inline(step.thought)}</div>` : "") +
        items +
        `</div>`
      );
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TermAI 任务报告${input.host ? ` - ${escapeHtml(input.host)}` : ""}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <h1>TermAI 任务报告</h1>
  <div class="meta">${escapeHtml(metaParts.join("\u3000|\u3000"))}</div>

  <div class="card">
    <h2>目标</h2>
    <div>${inline(input.goal || "（未记录）")}</div>
  </div>

  ${input.plan ? `<div class="card"><h2>执行计划</h2>${mdToHtml(input.plan)}</div>` : ""}

  <div class="card">
    <h2>结论</h2>
    ${input.summary ? mdToHtml(input.summary) : '<div class="meta">（本次没有生成总结）</div>'}
  </div>

  <div class="card">
    <h2>执行明细（点开看完整输出）</h2>
    ${stepBlocks || '<div class="meta">（本次没有执行任何命令）</div>'}
  </div>
</div>
</body>
</html>`;
}

// ==================================================================
// 报告 Markdown
// ==================================================================

/**
 * 选一个能包住内容的围栏长度。
 *
 * 命令本身可能是 heredoc、输出里可能带 ```（脚本、Markdown 文档）—— 固定用三个
 * 反引号会被内容里的围栏提前闭合，导出的文件从那一行往后全乱。CommonMark 允许
 * 更长的围栏，所以取「内容里最长的连续反引号 + 1」。
 */
export function fenceFor(text: string): string {
  const runs = String(text ?? "").match(/`{3,}/g);
  const longest = runs ? Math.max(...runs.map((s) => s.length)) : 0;
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * 把 Markdown 里的标题整体降级。
 *
 * 结论本身用的是 `## 结论摘要` 这种层级，直接嵌进 `## 结论` 之下会和父级同级，
 * 阅读时看不出从属关系（Word 里也会压平）。降一级就对齐了。
 * 只处理围栏外的标题行 —— 输出里的 `# 注释` 不能被当成文档结构。
 */
export function demoteHeadings(md: string, by = 1): string {
  const lines = String(md ?? "").split(/\r?\n/);
  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const m = line.match(/^(#{1,6})(\s+.*)$/);
      if (!m) return line;
      return "#".repeat(Math.min(6, m[1].length + by)) + m[2];
    })
    .join("\n");
}

/**
 * 生成 Markdown 报告。
 *
 * 结论（summary）本身就要求是 Markdown，所以原样嵌入，表格也保持表格；
 * 命令与输出各自放进代码围栏，避免输出里的 `#` / `-` / `|` 被当成文档结构。
 */
export function buildReportMarkdown(input: ReportInput): string {
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);

  push(`# TermAI 任务报告${input.host ? ` - ${input.host}` : ""}`, "");
  const meta = reportMetaParts(input);
  if (meta.length) push(`> ${meta.join("\u3000|\u3000")}`, "");

  push("## 目标", "", input.goal?.trim() || "（未记录）", "");

  if (input.plan?.trim()) push("## 执行计划", "", demoteHeadings(input.plan.trim()), "");

  push("## 结论", "", input.summary ? demoteHeadings(input.summary).trim() : "（本次没有生成总结）", "");
  push("---", "", "## 执行明细", "");

  if (input.steps.length === 0) push("（本次没有执行任何命令）", "");

  for (const step of input.steps) {
    const head = [`### 步骤 ${step.index}`];
    if (step.risk && step.risk !== "none") head.push(`风险 ${step.risk}`);
    if (step.batched) head.push("批量");
    push(head.join(" · "), "");

    if (step.thought?.trim()) push(`> ${step.thought.trim().replace(/\n/g, "\n> ")}`, "");

    step.items.forEach((it, k) => {
      push(`#### ${step.index}-${k + 1}`, "");
      const cmdFence = fenceFor(it.command);
      push(`${cmdFence}bash`, it.command, cmdFence, "");

      const dur =
        step.startedAt && step.finishedAt
          ? `${Math.max(0, step.finishedAt - step.startedAt)} ms`
          : "";
      push(`- 状态：${statusText(it)}${dur ? ` · 耗时 ${dur}` : ""}`, "");

      const body = it.output || it.error || "";
      if (!body.trim()) {
        push("（无输出）", "");
        return;
      }
      if (it.fullOutput) push("完整输出：", "");
      else if (/输出过长，已省略/.test(body)) {
        push("已截断：以下只是界面保留的片段，完整输出未落到运行记录。", "");
      }
      const outFence = fenceFor(body);
      push(`${outFence}text`, body.replace(/\s+$/, ""), outFence, "");
    });
  }

  return out.join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n";
}
