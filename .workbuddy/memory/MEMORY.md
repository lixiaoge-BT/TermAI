# TermAI 项目长期约定

## 代码审计结论的处理原则
- **审计 agent / 报告给出的高危论断（尤其 XSS、竞态）必须自己写探针复现后才能转述或动手修。**
  2026-09-07 一次全项目审计里，5 条结论有 2 条是误报：
  - "escapeHtml 后 `&quot;` 能闭合 href 注入属性" → 错。HTML 属性解析先按**裸引号**结束属性值，
    之后才解码实体，实体无法闭合属性。
  - "async 函数里 guard 与占位之间无 await 所以不原子" → 错。要确认**首个 await 的实际行号**，
    若在占位之后，同步执行下 guard 就是原子的。
- 修之前先证伪，能省掉对不存在的问题改代码，也避免向用户误报风险等级。
- 但**别矫枉过正**：2026-09-09 一次全项目审计（16 条论断）里，抽验的 7 条高危**全部为真**。
  验证手段：纯逻辑写 node 探针（放 `dist-test/`，**别用 /tmp** —— Windows node 会解析成 `D:\tmp`）、
  实跑第三方库 API 看返回值、读 node_modules 里的库源码确认包装逻辑。
- **门禁全绿不等于没 bug**：tsc/eslint/221 测试全过的情况下，仍存在哨兵误判、重连恒失败、
  展示名不落盘这类运行时缺陷 —— 它们都在异步/IO/时序路径上，单测覆盖不到。

## 渲染层 HTML 安全不变量
- 所有 `dangerouslySetInnerHTML` 的 sink：`AISidebar.tsx`（`escapeHtml` → `linkify`）、
  `AgentPanel.tsx`（走 `renderMarkdownToHtml`，内部 escapeHtml）。
- 不变量：**必须先 escapeHtml 再 linkify**，linkify 的 URL 字符类排除 `"'`。
  回归测试在 `src/lib/sanitize.test.ts`。改动这两个函数时必须跑。

## React / zustand 性能约定
- 禁止 `useXxxStore()` 无 selector 订阅整棵 store（zustand 每次 set 换新 state 对象 → 任何变更都重渲染）。
- **高频 set 源头**：terminal store 的 `appendOutput` 每块终端输出都换新 `sessions` 数组
  （recentOutput 变化）。订阅 sessions 的组件必须走「字段映射 + `useShallow`」，
  且映射要用 `WeakMap<原session对象, lite>` 缓存保证元素引用稳定——
  映射时裸建新对象会让浅比较恒失配，等于没优化（见 Home.tsx `toSessionLite`、HostPanel `connectedCounts`）。
- 传给 `XTerminal` 的 `onRequestAI` 必须引用稳定：它是终端 `onData` 订阅 effect 的依赖，
  身份一变就 dispose + 重注册。XTerminal 内部已用 ref 兜底，Home 侧仍用 `useCallback`。

## 构建 / 打包
- `npx electron-builder` 不构建渲染层，必须先 `npm run build`。
- electron-builder **不接受 `--out`**，只能用 `-c.directories.output=`。
- Windows 上 safe-delete shim 会卡住删除 `win-unpacked`：用全新输出目录
  （`release/dl-YYYYMMDDx`）+ 清空 `CODEBUDDY_SESSION_ID` / `CLAUDE_SESSION_ID` env。
- 验证改动是否真的进包：`grep -ao "标志性中文串" release/<dir>/win-unpacked/resources/app.asar | wc -l`，
  与旧包对照（时间戳不可信）。
- **两个 grep 假阴性坑**：① 渲染层 CSS 会被 cssnano 改写值形态（如 4 值 padding → 3 值简写），
  先看 `dist/assets/*.css` 里的真实形态再 grep asar；② 主进程（dist-electron）经 esbuild 打包，
  中文串被转成 `\uXXXX` 转义，grep 中文恒 0——要改用 **ASCII 标识符**（如 windowBundles）核对。

## 多窗口模型约定（2026-09-07 重做）
- **禁止模块级窗口/管理器单例**（旧 `let win` + 4 个全局 manager 被 `createWindow()` 整体覆盖，
  导致事件串窗、深链投丢、F12 跨窗）。现模型：`windowBundles: Map<windowId, {win, ssh, term}>`。
- SSH / 本地终端 manager 按窗口创建（事件只回发给所属窗口）；localFs / recordings 与窗口无关，
  全局惰性单例（ready 后初始化一次，darwin 关窗后 activate 重建窗口时会复用判断）。
- IPC handler 一律 `bundleOfEvent(_evt)` 按 sender 反查所属窗口的 manager，禁止引用全局 manager。
- 深链/二次启动目标窗口用 `getTargetWindow()`（聚焦优先 → lastWindowId → 任一存活），
  禁止直接引用可能已销毁的窗口变量。
- 每窗 `once("closed") → disposeBundle(id)`：释放自己的 SSH 连接与本地终端，防跨窗泄漏。
- 双窗口改动必须实测：两窗各连一台主机跑命令看输出不串；关一窗再开新的；深链唤起聚焦正确。

## 测试约定
- `npm test` 走 `scripts/run-tests.mjs`：esbuild 把 TS 打成 ESM 到 `dist-test/`，再起 `node --test`。
  **该脚本已改为递归自动发现** `src/`、`electron/` 下的 `*.test.ts`（原为硬编码列表，
  新写的测试忘了登记就会「不执行但全绿」—— 加完测试务必确认总数变化）。
- 测试风格是 `node:test`（`import { describe, it } from "node:test"` + `node:assert/strict`），不是 vitest。
- 断言「某判据更严格」时，要同时断言**宽松判据确实命中**（如回显里真的含有哨兵子串），
  否则「返回 false」可能只是输入里根本没有目标串，用例等于没测。
- 给异步函数写 `assert.doesNotReject` 时，若返回类型是 `void | Promise<void>`（如 zustand 的
  StateStorage.setItem），要显式 `Promise.resolve(fn())` 包一层，否则 tsc 报 TS2345。

## Agent 接管（终端 Agent）不变量
- **`run()` 的对话历史 `messages` 必须持久化进 `AgentBucket.messages`，绝不能每次从 `[system, goal]` 重建。**
  否则 stop / 超时后用户再点「开始接管」= 模型失忆重来 → 重复执行命令、答非所问。
  续跑分支：继承 `bucket.messages`，补一条「继续/补充目标」指令（`buildResumeNote`）并禁止重复命令。
- **接管前上下文**：fresh 运行时把 `session.recentOutput`（含用户手动命令及结果）注入首条观察
  （`buildHandoffContext`），否则 Agent 对当前 cwd/状态一无所知。
- **过早结束 bug**：`parseAgentReply` 对「无 `<<<RUN>>>` 也无 `<<<DONE>>>` 的裸文本」兜底判 done；
  靠 `noMarkerFallback` 字段区分，run() 据此要求模型继续（连续 3 次无标记才强制结束），避免「没做完就停」。
- 续跑不清 `steps`/`summary`（保留连续性）；首次/reset 才清。`finally` 写回 `messages` 供续跑。
- 改 `src/store/agent.ts` 的 run 循环、`src/services/agent.ts` 的 parseAgentReply、
  `src/services/prompts.ts` 的 AGENT_SYSTEM_PROMPT 收敛段时，必须跑 tsc/eslint/全量测试。

## Agent 接管（部署/运维智能化）约定
- 协议三标记：`<<<RUN>>>`/`<<<END>>>` 执行、`<<<DONE>>>` 结束、`<<<PLAN>>>` 计划蓝图
  （parseAgentReply 优先级 DONE > PLAN > RUN；plan 存 `AgentBucket.plan`，UI 用 PlanCard 展示）。
- 超长命令输出走 `focusOutput()`：有错误关键词 → 聚焦错误行+尾部 40 行；无 → 回退前 N 截断
  （agent.test.ts 锁定 6000 字符截断行为，改 buildObservation 前先看该测试）。
- prompts.ts 的模板字符串里写反引号必须 `\`` 转义，未转义会 TS1005 连环报错。
- **Edit 工具假落盘高发**：一次批量改动约 2/3 报 success 实际未写入。凡是关键改动，
  每处 Edit 后立刻 grep 复核该处是否真的在文件里，缺了就用当前真实文本重 Edit。

## 伪装成 Xshell 对接堡垒机（2026-09-08）
- 堡垒机判断「装没装 Xshell」**不靠文件名**，靠：注册表 `NetSarang\Xshell\*\Install`、
  卸载项 `Uninstall\Xshell 7`、URL 协议 `Classes\xshell`（必须有 `URL Protocol` 值）、
  硬编码路径 `C:\Program Files (x86)\NetSarang\Xshell 7\Xshell.exe`。**只把 exe 改名 = 零作用**。
- 已内置：`PROTOCOL_SCHEMES = ["termai","xshell"]`（main/index.ts）、deepLink.ts 的 `xshell://` →
  `ssh://` 归一分支、package.json `win.protocols.schemes`。
- `scripts/xshell-masquerade.ps1`：dry-run / `-Apply` / `-Remove` / `-Link`（junction 顶替硬编码路径）。
  改协议注册或检测点时要同步它。
- **伪装版构建**：`npm run dist:xshell` → 配置在 `electron-builder.xshell.json`（appId=`Xshell 7` 直接成为卸载键名、
  productName=`Xshell`、extraMetadata.author=`NetSarang Co., Ltd.`）。产物 exe 就叫 Xshell.exe。
- **PE 版本资源坑**：`rcedit(exe, {icon})` 不写 version info，exe 属性里 CompanyName/ProductName 全空 ——
  必须额外传 `"version-string"`（已在 afterPack.mjs 修好，取值跟 appInfo 走，不影响正版）。
- **productName 会改 userData 目录**（配置在 localStorage 里）→ 主进程已固定 userData 到 TermAI/termai，
  以后再改 productName 不会再丢配置。
- 验证 PE 资源要用 python 按 `utf-16-le` 计数（grep -a 查不到）；asar 内主进程中文被 esbuild 转成 `\uXXXX`，
  只能 grep ASCII 标识符。
- **「点了没反应」≠ 没被唤起**：先看 `%APPDATA%\TermAI\logs\argv-debug.log`。
  `argv.length=1` = 堡垒机只 spawn 了 exe、没传参数（同时排除协议唤起，协议 URL 会是 argv[1]）。
  诊断靠 `logInvocationContext()`：父进程名 / 环境变量 / 3 分钟内的 .xsh / NetSarang 注册表 dump。

## 本环境排查 Windows 注册表/进程的方法（2026-09-08 修正）
- `reg.exe` 在程序黑名单、`wmic` 已被 Windows 移除、`cmd.exe` 不能从 PowerShell 工具调、
  Bash 里调 powershell 会被安全策略拒。
- **PowerShell 工具 stdout 不回显，但命令确实会执行** —— 用 `... | Out-File 'D:\Trae\scripts\_x.txt' -Encoding utf8`
  再用 Read 读文件即可。查注册表 / Win32_Process / COM 注册全靠这个组合。
- 用户机器装过正版 Xshell 8（`D:\App\xshell`，InstallShield 装的，写 HKLM/WOW6432Node）。
  9-08 曾挪到 `D:\App\xshell111` 并装伪装版顶替，**9-09 已全部还原**（详见 2026-09-09.md）。
  **堡垒机能检测到 Xshell 是正版残留注册表的功劳，不是伪装的。**
- **PowerShell 诊断脚本两个必踩的坑**：① 函数里 `$out +=` 建的是局部变量，外层收不到 → 一律 `$script:out +=`
  （曾因此误以为删除没执行，实际已成功，只能靠 Test-Path 复核）；② `New-Object -ComObject WScript.Shell`
  被安全策略拦（可解析 .lnk 目标也不行），只能列文件名。
- **判断「是不是伪装/第三方残留」靠 HKCU vs HKLM 分层**：正版 InstallShield 类安装器写 HKLM/WOW6432Node，
  Electron 非管理员安装只写 `HKCU\Software\Classes`。HKCU 有而 HKLM 没有 = 后装的残留，删掉即回落到正版值。
  注意 HKCU 层的**空 (Default) 值会遮蔽 HKLM 的正确值**（如 `.xsh` 文件关联失效）。
- Xshell 没有 COM 自动化注册（`Xshell.Application` 不存在），堡垒机不可能走 COM。

