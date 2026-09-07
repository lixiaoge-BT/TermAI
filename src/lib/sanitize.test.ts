// =====================================================
// 渲染层 HTML 注入防护回归测试
//
// 背景：AI 回复 / 终端输出会经 renderMarkdownToHtml 走 dangerouslySetInnerHTML。
// 安全不变量是「先 escapeHtml 再 linkify」：escapeHtml 把 " 转成 &quot;，
// 而 HTML 属性解析是先按裸引号结束属性值、之后才解码实体，因此 &quot; 无法
// 闭合 href。这里把该不变量钉死，防止后人调整顺序或改动正则时悄悄引入 XSS。
// =====================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdownToHtml } from "./markdown";

/** 试图通过 URL 里的引号闭合 href、再注入事件处理器的载荷 */
const PAYLOADS = [
  'https://e.com?x=" onmouseover=alert(1)',
  "https://e.com?x=' onmouseover=alert(1)",
  'https://e.com?x="onmouseover=alert(1)',
  'https://e.com?x=" onmouseover="alert(1)',
  'https://e.com?x="><img src=x onerror=alert(1)>',
  'click https://e.com?a=" onfocus=alert(1) x="',
  'https://e.com?a=" autofocus onfocus=alert(1)',
  "[x](https://e.com?a=\" onmouseover=alert(1))",
];

/** 标签里允许出现的属性白名单 */
const ALLOWED_ATTRS = new Set(["href", "target", "rel", "class"]);

test("renderMarkdownToHtml：URL 载荷无法注入事件处理器属性", () => {
  for (const payload of PAYLOADS) {
    const html = renderMarkdownToHtml(payload);

    for (const tag of html.match(/<[a-z]+\b[^>]*>/gi) ?? []) {
      const attrs = [...tag.matchAll(/([a-zA-Z-]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/g)].map(
        (m) => m[1].toLowerCase()
      );
      for (const a of attrs) {
        assert.ok(
          !a.startsWith("on"),
          `载荷 ${JSON.stringify(payload)} 注入了事件属性 ${a}：${tag}`
        );
        assert.ok(
          ALLOWED_ATTRS.has(a),
          `载荷 ${JSON.stringify(payload)} 产生了非白名单属性 ${a}：${tag}`
        );
      }
    }
  }
});

test("renderMarkdownToHtml：载荷不会逃逸出裸标签", () => {
  for (const payload of PAYLOADS) {
    const html = renderMarkdownToHtml(payload);
    // 移除本文件自己生成的合法标签后，不应剩下任何其它标签
    const stripped = html.replace(
      /<\/?(a|strong|code|div|pre|em|br|span)\b[^>]*>/gi,
      ""
    );
    assert.doesNotMatch(
      stripped,
      /<[a-z/!]/i,
      `载荷 ${JSON.stringify(payload)} 逃逸出了裸标签：${html}`
    );
  }
});

test("renderMarkdownToHtml：正常链接仍被正确渲染", () => {
  const html = renderMarkdownToHtml("见 https://example.com/a?b=1 这里");
  assert.match(html, /href="https:\/\/example\.com\/a\?b=1"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer"/);
});

test("renderMarkdownToHtml：普通文本里的尖括号被转义", () => {
  const html = renderMarkdownToHtml("<script>alert(1)</script>");
  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;/);
});
