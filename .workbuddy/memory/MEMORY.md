# TermAI 项目长期约定

## 代码审计结论的处理原则
- **审计 agent / 报告给出的高危论断（尤其 XSS、竞态）必须自己写探针复现后才能转述或动手修。**
  2026-09-07 一次全项目审计里，5 条结论有 2 条是误报：
  - "escapeHtml 后 `&quot;` 能闭合 href 注入属性" → 错。HTML 属性解析先按**裸引号**结束属性值，
    之后才解码实体，实体无法闭合属性。
  - "async 函数里 guard 与占位之间无 await 所以不原子" → 错。要确认**首个 await 的实际行号**，
    若在占位之后，同步执行下 guard 就是原子的。
- 修之前先证伪，能省掉对不存在的问题改代码，也避免向用户误报风险等级。

## 渲染层 HTML 安全不变量
- 所有 `dangerouslySetInnerHTML` 的 sink：`AISidebar.tsx`（`escapeHtml` → `linkify`）、
  `AgentPanel.tsx`（走 `renderMarkdownToHtml`，内部 escapeHtml）。
- 不变量：**必须先 escapeHtml 再 linkify**，linkify 的 URL 字符类排除 `"'`。
  回归测试在 `src/lib/sanitize.test.ts`。改动这两个函数时必须跑。

## React / zustand 性能约定
- 禁止 `useXxxStore()` 无 selector 订阅整棵 store（zustand 每次 set 换新 state 对象 → 任何变更都重渲染）。
- 传给 `XTerminal` 的 `onRequestAI` 必须引用稳定：它是终端 `onData` 订阅 effect 的依赖，
  身份一变就 dispose + 重注册。XTerminal 内部已用 ref 兜底，Home 侧仍用 `useCallback`。

## 构建 / 打包
- `npx electron-builder` 不构建渲染层，必须先 `npm run build`。
- electron-builder **不接受 `--out`**，只能用 `-c.directories.output=`。
- Windows 上 safe-delete shim 会卡住删除 `win-unpacked`：用全新输出目录
  （`release/dl-YYYYMMDDx`）+ 清空 `CODEBUDDY_SESSION_ID` / `CLAUDE_SESSION_ID` env。
- 验证改动是否真的进包：`grep -ao "标志性中文串" release/<dir>/win-unpacked/resources/app.asar | wc -l`，
  与旧包对照（时间戳不可信）。
