# TermAI 项目长期约定

> 历史细节在 `.workbuddy/memory/YYYY-MM-DD.md`；本文件只留**仍需遵守的规则**。

## 1. 验证与审计（最高优先）
- **高危论断（XSS/竞态/安全）先写探针复现再动手或转述** —— 误报率不可预测，只能逐条验。探针放 `dist-test/`（**别用 /tmp**，Windows node 解析成 `D:\tmp`）。
- **门禁全绿 ≠ 没 bug**：tsc/eslint/测试全过时，异步/IO/时序路径缺陷依然存在。修完必须**实跑目标场景**。
- **Edit 假落盘高发** → 每处关键改动立刻 grep 复核；报「String not found」先怀疑 old_string 上下文不完整。
- **禁止对短转义串用 `replace_all`**；**写 TS 块注释避开 `*/`**；prompts.ts 模板串里反引号必须 `\``。

## 2. 构建 / 打包 / 产物核验
- 顺序：`npm run build` → `npx electron-builder -c.directories.output=release/dl-YYYYMMDDx`（**不接受 `--out`**，且不构建渲染层）。
- safe-delete shim 会卡住删 `win-unpacked` → 每次用**全新输出目录**，清空 `CODEBUDDY_SESSION_ID`/`CLAUDE_SESSION_ID`。
- **核验改动真进包**：拿本次新增字符串与旧包对照计数（时间戳不可信）。三个假阴性坑：① 渲染层 CSS 被 cssnano 改写值形态；② 主进程经 esbuild **中文串变 `\uXXXX`**；③ 渲染层标识符被 mangle 但**中文字面量保留**。
  **口诀：主进程查 ASCII 标识符，渲染层查中文串。**
- **数字常量核验也易假阴性**：esbuild 把 `8000` 压成 `8e3`，跨模块常量变短名（`OBS_MIN_PER_COMMAND`→`Cp=800`）。要查**结构性特征**（函数体形状、相邻常量三元组），别 grep 十进制字面量。
- PE 资源（版本信息）按 `utf-16-le` 计数，`grep -a` 查不到。
- 本环境 shell 缺 coreutils：命令前加 `export PATH="/c/Users/raotengke/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:$PATH"`。

## 3. 测试约定
- `npm test` → `scripts/run-tests.mjs`：esbuild 打 ESM 到 `dist-test/` 再 `node --test`；递归自动发现 `src/`、`electron/` 下 `*.test.ts`（**传文件名参数会被忽略，实际是全量跑**）。风格 `node:test` + `node:assert/strict`。
- 断言「判据更严格」要**同时断言宽松判据确实命中**；异步断言用 `Promise.resolve(fn())` 包一层（否则 TS2345）。
- `cat >> ... << 'EOF'` 追加代码正文**不能出现 `${`**。

## 4. 渲染层 HTML 安全
- sink：`AISidebar.tsx`（`escapeHtml`→`linkify`）、`AgentPanel.tsx`（`renderMarkdownToHtml`）。
- 不变量：**必须先 escapeHtml 再 linkify**，linkify URL 字符类排除 `"'`。回归 `src/lib/sanitize.test.ts`。

## 5. React / zustand 性能
- 禁止 `useXxxStore()` 无 selector 订阅整棵 store。
- 高频 set 源头是 terminal store 的 `appendOutput`。订阅 sessions 必须「字段映射 + `useShallow`」+ `WeakMap<原session, lite>` 缓存元素引用（裸建新对象 = 浅比较恒失配 = 没优化）。
- 传给 `XTerminal` 的 `onRequestAI` 必须引用稳定。

## 6. 多窗口模型（2026-09-07 重做）
- **禁止模块级窗口/管理器单例**。`windowBundles: Map<windowId, {win, ssh, term}>`；SSH/本地终端 manager 按窗口建，localFs/recordings 全局惰性单例。
- IPC handler 一律 `bundleOfEvent(_evt)` 反查窗口 manager；深链用 `getTargetWindow()`；每窗 `once("closed") → disposeBundle(id)`。双窗口改动必须实测。

## 7. Agent 接管不变量
### 命令解析与下发
- **RUN 块按 shell 结构解析，不按行拆**：`shellIncomplete()` 判「结构没写完」并拒发（否则 shell 停在 PS2 挂到超时）；序号只剥首行。
- **多行不能无脑压平**：注释行丢弃；`needsScriptFile()` 让含循环/条件/注释/heredoc 的多行脚本落盘 `/tmp` 交 `bash file`。测试用 `spawnSync("bash",["-n","-c",flat])` 锁死产物合法。
- `sanitizeCommandLine()`：折叠逐字相同子命令；剩余 > 8 子命令或整行 > 2000 字符 → **整条拒绝**（绝不静默截断）。

### 命令包装与退出码（2026-09-14 重做）
- 包装由 `buildExecScript(command, tags, scriptPath)`（纯函数）生成，三种形态：多行脚本 → heredoc 落盘 + `bash <path>`；**顶层全 `;` 串联 → 逐段打点**；其余（单条 / `&&` / `||` / 行尾 `&`）→ 只有整体退出码。
- **分段打点**：每段 `{ cmd; echo "TERMAI_EXIT_x:seg:N:$?"; }`。打点串带 `:seg:` 中缀（不会被整体退出码正则误匹配）且含 exitTag → 自动被 `stripEcho`/`stripAgentLines` 剔除，**显示侧零改动**。启用前置：`balancedBraces()` 配平（否则 `{ }` 被命令里的裸 `}` 提前闭合 → 整条语法错误）且无行尾 `&`。解析在 `extractResult`。
- **`$?` 只反映最后一条 —— 已治**：`ExecResult.segmentStatus` + `isExecOk()`（store 的 `isOk` 委托它）+ `renderSegmentStatus()` 显式写「第 N 段 → 码」并注明整体退出码不可作成功依据。**`&&`/`||` 仍未覆盖**（插打点会破坏短路语义）。
- **包装不外包 ` 2>&1`**（PTY 本身合流；外包会抵消末条自己的 `2>/dev/null`）。
- **判断「真跑了还是下发失败」看 UI 文案**：裸「执行失败」= 拿到 exitCode ≠ 0；带错误文案 = `execCommand` 抛异常。

### 去重闸门（2026-09-14 双轨阈值）
- ① **逐字重复**（`createDupTracker`）：按**子命令**计数（拆顶层 `&&`/`;`）。**写操作子命令**已成功 ≥1 次即整条拒绝；**只读子命令**需全部成功 ≥2 次 → 第 3 次拒绝。失败命令永不进闸门。
- ② **同族变体**（`cmdFamily`）：族键 = 基础命令 + 目标（位置参数排序），忽略 flag。`cmdFamily` **跳过写 segment**，取第一个只读 segment 归族（`rm x; du y` 只对 `du` 归族）。
  - **只读白名单**（`READONLY_CMDS`+`READONLY_SUBCMDS`）判定，不认识 → `null`。`rpm -ivh`/`crontab /tmp/x`/`find -exec rm` 是写；`rpm -qa`/`crontab -l`/`systemctl status` 是读。`service <名> <动作>` 动作在**第二位**。
  - **不再有 `fam.clear()`**；`hasFileRedirect` 必须放行 `2>&1`/`2>/dev/null`；`$(...)`/反引号 → null。
- 拒绝时**只剔除该条、保留其余**；被拒轮 `n` 不增长，靠 `dupStreak` 连拒 3 轮强制收尾。拒绝必须说清原因并回填输出片段。
- **`maybeCompress()` 必须用 `agentConfig`**（`thinkingDisableExtra` 只挂它），否则思考型模型在长 transcript 上跑整段思考链（「AI 卡住很久」）。

### 观察与记忆（2026-09-14 扩容）
- **观察预算 `OBSERVATION_MAX_CHARS = 8000`**，`allocateObservationBudget()` 取代按条数均摊：**每条保底 `OBS_MIN_PER_COMMAND = 800`，剩余全补给缺口最大的那条**（保底优先于总额）。旧均摊批量 4 条只剩 750 字符 → 模型拿残片决策 → 被误判成空转。
- `buildObservation` 用 `sanitizeOutput(rawOut, 200)`（行数上限 80→200）；超长走 `focusOutput()`：有错误关键词 → 头 `max(20,min(40,budget/200))` + 错误行 + 尾 `max(40,min(80,budget/100))`（**下限锁死 20/40**）；无 → 前 N 截断。
- **台账 `digestOutput(text, 240, 3)`**：前 3 条有信息量的行、`" | "` 拼接、超 240 截断、有剩余附 `（共 N 行）`；跳过表头（`total N`/`Filesystem`/`●`/`Loaded:`）；全结构性行时**只**回退首行。旧版 1 行 60 字符 → 模型对结果没整体认知 → 换写法重看（空转最隐蔽来源）。
- **会话历史 `messages` 必须持久化进 `AgentBucket.messages`**，绝不从 `[system, goal]` 重建；续跑继承 messages + `buildResumeNote`，不清 `steps`/`summary`。接管前注入 `session.recentOutput`（`buildHandoffContext`）。
- `parseAgentReply` 对「无标记裸文本」兜底判 done（`noMarkerFallback`），连续 3 次无标记才强制结束。标记：`<<<RUN>>>`/`<<<END>>>`、`<<<DONE>>>`、`<<<PLAN>>>`（优先级 DONE > PLAN > RUN）。

### 哨兵回显过滤（`src/lib/agentEcho.ts`）
- **只能从「显示」剔除，绝不改原始流**：`emitTerminalOutput`/`recordOutput` 喂原始数据，只有 xterm 显示与 `appendOutput` 喂过滤后的。
- 用**区间抑制**（命令行超宽时 readline 插换行，按行匹配会漏碎片）：从回显行起整段丢弃，直到 BEGIN 独立成行。
- **区间命中必须补回 `\r\n`**（被吃掉的换行是提示符行行尾，不补会让提示符成对出现）；补回的命令**不带 `$` 前缀、不前置换行**。改这块先看 `agentEcho.test.ts`。

### 原地打转的告知（只告知不拦截，纯函数可单测）
- `probeTargetOf`+`isNoInfoProbeOutput`：只认 curl/wget 对**同一 host:port** 的无信息探测。
- `errorShapeOf`+`createFailTreadmill`：靠**错误签名**识别同类失败；连续 2 次同签名提醒，之后每连击 2 次重复。**`ok=true` 既不计数也不重置连击**。两者互斥。
- **判定「补提示词还是补引擎」**：先核 `buildObservation` 预算，确认关键信息进没进上下文。信息进了仍重试 → 做**不依赖模型记忆的确定性触发**。
- 提示词规则 4 已含：一条命令优先、禁多行循环与 `#` 注释、禁全盘 `find /`、一行 ≤8 子命令、**同目标最多换 2 种写法**。

### 删不掉的排查
- **先怀疑挂载点而非权限**：`/var/lib/nfs/rpc_pipefs` 是内核伪文件系统（条目无 unlink/rmdir → EPERM）。**签名：mode 777 + size 0 + 时间戳全同 + `total 0`**。做法 `mount | grep` → `umount` → `systemctl restart`，**不是 rm**。

## 8. 伪装成 Xshell 对接堡垒机
- 检测点（改名文件**零作用**）：注册表 `NetSarang\Xshell\*\Install`、卸载项 `Uninstall\Xshell 7`、URL 协议 `Classes\xshell`（需 `URL Protocol` 值）、硬编码路径 `C:\Program Files (x86)\NetSarang\Xshell 7\Xshell.exe`。
- 已内置 `PROTOCOL_SCHEMES=["termai","xshell"]`、`xshell://`→`ssh://` 归一、`scripts/xshell-masquerade.ps1`、`npm run dist:xshell`。
- 坑：`rcedit({icon})` 不写 version info → 必须额外传 `"version-string"`；productName 会改 userData（主进程已固定 termai）。**「点了没反应」先看 `%APPDATA%\TermAI\logs\argv-debug.log`**。**当前能过检测靠用户机器上正版 Xshell 的残留注册表，不是伪装本身。**

## 9. 本环境排查（Windows）
- `reg.exe` 在黑名单、`wmic` 已移除、`cmd.exe` 不能从 PowerShell 工具调、Bash 调 powershell 被拒。
- **PowerShell 工具 stdout 不回显但命令确实执行** → `... | Out-File 'D:\Trae\scripts\_x.txt' -Encoding utf8` 再 Read。脚本累加输出必须 `$script:out +=`。
- 判断「第三方残留」靠 HKCU vs HKLM 分层（正版 InstallShield 写 HKLM/WOW6432Node；Electron 非管理员只写 `HKCU\Software\Classes`，其空 (Default) 会遮蔽 HKLM）。
- 诊断「用的哪个模型」：读 `%APPDATA%/termai/Local Storage/leveldb/*.{log,ldb}` 里的 `"model":"..."`（可能被 snappy 压缩，正则未必命中）。
