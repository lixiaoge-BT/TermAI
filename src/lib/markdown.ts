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

function renderInline(text: string): string {
  const lines = text.split("\n");
  return lines
    .map((raw) => {
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

      // 粗体 / 斜体 / 行内代码
      h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      h = h.replace(
        /`([^`]+)`/g,
        '<code class="px-1 py-0.5 rounded bg-bg-hover border border-border-primary font-mono text-[0.88em]">$1</code>'
      );

      // 链接
      // 注意不变量：本函数只能吃 escapeHtml 之后的串。字符类里显式排除引号，
      // 保证即使将来有人漏掉/挪动 escapeHtml，也无法用引号闭合 href 注入属性。
      h = h.replace(
        /(https?:\/\/[^\s<)"']+)/g,
        '<a href="$1" target="_blank" rel="noreferrer" class="text-text-link underline underline-offset-2">$1</a>'
      );

      return h.trim() ? `<div class="leading-relaxed">${h}</div>` : `<div class="h-2"></div>`;
    })
    .join("");
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
