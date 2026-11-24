// =====================================================
// 极简 Markdown → HTML 渲染（仅覆盖 AI 总结常用语法）
// 只用于渲染我们自己请求回来的内容，输出前统一做 HTML 转义。
// =====================================================

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 行内语法（粗体 / 斜体 / 行内代码 / 链接）。
 *
 * 入参必须是**已经 escapeHtml 过**的串 —— 本函数的替换结果是直接拼进 HTML 的。
 * 抽成独立函数是为了让表格单元格也能复用同一套行内渲染。
 */
function applyInline(h: string): string {
  let s = h;
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(
    /`([^`]+)`/g,
    '<code class="px-1 py-0.5 rounded bg-bg-hover border border-border-primary font-mono text-[0.88em]">$1</code>'
  );
  // 链接
  // 注意不变量：本函数只能吃 escapeHtml 之后的串。字符类里显式排除引号，
  // 保证即使将来有人漏掉/挪动 escapeHtml，也无法用引号闭合 href 注入属性。
  s = s.replace(
    /(https?:\/\/[^\s<)"']+)/g,
    '<a href="$1" target="_blank" rel="noreferrer" class="text-text-link underline underline-offset-2">$1</a>'
  );
  return s;
}

/** 渲染一行普通文本（行级语法 + 行内语法） */
function renderLine(raw: string): string {
  let h = escapeHtml(raw);

  // 标题
  h = h.replace(/^######\s+(.*)$/, '<div class="font-semibold text-text-primary mt-2 mb-1">$1</div>');
  h = h.replace(/^#####\s+(.*)$/, '<div class="font-semibold text-text-primary mt-2 mb-1">$1</div>');
  h = h.replace(/^####\s+(.*)$/, '<div class="font-semibold text-text-primary mt-2 mb-1">$1</div>');
  h = h.replace(/^###\s+(.*)$/, '<div class="font-semibold text-[13px] text-text-primary mt-2.5 mb-1">$1</div>');
  h = h.replace(/^##\s+(.*)$/, '<div class="font-bold text-[13px] text-text-primary mt-3 mb-1">$1</div>');
  h = h.replace(/^#\s+(.*)$/, '<div class="font-bold text-sm text-text-primary mt-3 mb-1">$1</div>');

  // 分隔线
  h = h.replace(/^\s*(---|\*\*\*)\s*$/, '<div class="border-t border-border-primary my-2"></div>');

  // 列表符号
  h = h.replace(/^(\s*)[-*+]\s+/, "$1• ");

  h = applyInline(h);

  return h.trim() ? `<div class="leading-relaxed">${h}</div>` : `<div class="h-2"></div>`;
}

/**
 * 按**未转义**的竖线切分表格行。
 *
 * `\|` 是单元格里表示竖线的写法（例如 `grep 'a\|b'`），不能当列分隔符。
 * 首尾的竖线可有可无 —— 模型两种写法都常见。
 */
function splitTableRow(line: string): string[] {
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

/**
 * 是否是表格的对齐行（`| --- | :--- |`）。
 *
 * 判据收紧到「整行只由 | - : 空格组成，且每个单元格都是 `:?-+:?`」：
 * 放宽会把 `- 项目符号 | 说明` 这种正文误判成分隔行。
 */
function isAlignRow(line: string): boolean {
  const s = line.trim();
  if (!s || !s.includes("-")) return false;
  if (!/^[|\-:\s]+$/.test(s)) return false;
  const cells = splitTableRow(s);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/** 渲染一张表：rows[0] 是表头，rows[1] 是对齐行，其余是数据 */
function renderTable(rows: string[]): string {
  const header = splitTableRow(rows[0] ?? "");
  const body = rows.slice(2).map(splitTableRow);

  const cellHtml = (tag: "th" | "td", raw: string): string => {
    const cls =
      tag === "th"
        ? "border border-border-primary px-1.5 py-1 text-left font-semibold text-text-primary bg-bg-secondary"
        : "border border-border-primary px-1.5 py-1 align-top text-text-primary";
    return `<${tag} class="${cls}">${applyInline(escapeHtml(raw))}</${tag}>`;
  };

  const head = `<thead><tr>${header.map((c) => cellHtml("th", c)).join("")}</tr></thead>`;
  const rowsHtml = body
    .map((cells) => {
      // 数据行列数与表头不一致时补空单元格，避免表格塌成锯齿
      const padded = header.map((_, i) => cells[i] ?? "");
      return `<tr>${padded.map((c) => cellHtml("td", c)).join("")}</tr>`;
    })
    .join("");

  return (
    `<div class="my-2 overflow-x-auto rounded border border-border-primary">` +
    `<table class="w-full border-collapse text-[11px]">${head}<tbody>${rowsHtml}</tbody></table>` +
    `</div>`
  );
}

function renderInline(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // 表格：表头行 + 对齐行才算，光有竖线不算（`a | b` 在正文里很常见）
    if (lines[i].includes("|") && i + 1 < lines.length && isAlignRow(lines[i + 1])) {
      let end = i + 2;
      while (end < lines.length && lines[end].includes("|") && !isAlignRow(lines[end])) {
        // 空行必须断开，否则会把后文整段吞进表格
        if (!lines[end].trim()) break;
        end += 1;
      }
      out.push(renderTable(lines.slice(i, end)));
      i = end;
      continue;
    }

    out.push(renderLine(lines[i]));
    i += 1;
  }

  return out.join("");
}

export function renderMarkdownToHtml(md: string): string {
  const text = md ?? "";
  const parts: string[] = [];
  const fence = /```([A-Za-z0-9_+-]*)\s*\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = fence.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parts.push(renderInline(text.slice(lastIndex, m.index)));
    }
    const body = m[2].replace(/\n$/, "");
    parts.push(
      `<pre class="my-2 p-2.5 rounded bg-bg-secondary border border-border-primary overflow-x-auto"><code class="font-mono text-[11px] text-text-primary whitespace-pre">${escapeHtml(
        body
      )}</code></pre>`
    );
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(renderInline(text.slice(lastIndex)));
  }
  return parts.join("");
}
