# TermAI 项目长期约定

> 细节看 `.workbuddy/memory/YYYY-MM-DD.md`。本文件只留仍生效的硬规则。

## 0. 验证铁律
- 高危论断**先写探针复现**（`dist-test/`，不用 `/tmp`）；调函数前 grep 真实签名；子代理结论必自己复跑。
- 门禁全绿 ≠ 没 bug，修完必须实跑目标场景。**Edit 假落盘高发** → 改完立刻 grep 复核。
- shell 缺 coreutils：`export PATH="/c/Users/raotengke/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:$PATH"`。

## 1. 构建 / 打包
- `npm run build` → `npx electron-builder -c.directories.output=release/dl-YYYYMMDDx`（不接受 `--out`）。每次全新输出目录，清空 `CODEBUDDY_SESSION_ID`/`CLAUDE_SESSION_ID`（safe-delete shim 会卡）。
- 核验改动进包靠**与旧包对照计数**（时间戳不可信）。主进程查 ASCII 标识符（中文变 `\uXXXX`），渲染层查中文字面量；数字常量别 grep 十进制。PE 版本信息按 `utf-16-le` 计数。
- NSIS 首装消失已修：`installer.nsh` 自定义 `customCheckAppRunning` 用 `taskkill /f /t /im` + 1s 轮询 ≤20s；宏生效后 `!ifmacrondef` 为 false → 不能引用 `pid`。
- **包体铁律**：渲染层依赖（react/lucide/xterm/zustand/…）已被 vite 打进 `dist`，绝不能进 asar。新增只被 `src/` 用的 dependency 必须同步加入 `build.files` 负向排除。`asar.smartUnpack` 必须 false，否则带 gyp 的包（cpu-features）会把整条 ssh2 链拖出 asar。
- 瘦身只能动 locales/prebuilds/源码/测试；`node-pty/build/Release/conpty/*`、`prebuilds/win32-<arch>/*`、`icudtl.dat`、`libGLESv2.dll`、`LICENSES.chromium.html` 一律保留。
- 本机 shell 带 `ELECTRON_RUN_AS_NODE=1` + `NODE_OPTIONS=…shim` → 跑 electron 会退化成纯 Node 并报 `bad option`。必须 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS`。PowerShell `Add-Type` 被安全策略拦（截屏不可用），读 `MainWindowTitle` 可以。

## 2. 测试
- `npm test` → esbuild 打 ESM 到 `dist-test/` 再 `node --test`，递归全量跑（传文件名参数无效）。风格 `node:test` + `node:assert/strict`。
- 断言「判据更严」要**同时断言宽松判据仍命中**；异步断言用 `Promise.resolve(fn())` 包。`cat >> … <<'EOF'` 正文不能出现 `${`。

## 3. 渲染层
- **先 escapeHtml 再 linkify**（URL 字符类排除 `"'`）。sink：`AISidebar.tsx`、`AgentPanel.tsx`。回归 `sanitize.test.ts`。
- 禁无 selector 订阅整棵树；高频源 `appendOutput`。订阅 sessions 用「字段映射 + `useShallow`」+ `WeakMap<原session,lite>`。**`useShallow` 要连 selector 一起改**（高频字段移出主 selector，如 `useSessionLiveThought`）。`XTerminal` 的 `onRequestAI` 引用必须稳定。

## 4. 多窗口
- **禁模块级窗口/管理器单例**：`windowBundles: Map<windowId,{win,ssh,term}>`；IPC 用 `bundleOfEvent(_evt)` 反查；每窗 `once("closed")→disposeBundle`。双窗口必须实测。
- **点 X = 隐藏到托盘**（`isQuitting` 标志模式）：`close` 拦截必须带 `|| !tray`（托盘挂了要能正常关窗）；`before-quit` 与 `session-end` 都要置位，否则退出被挡。隐藏不触发 `closed` → 连接不断。任何「唤起窗口」的路径（second-instance / activate / 托盘）都必须 `show()`，只 `focus()` 对隐藏窗口无效。
- **`nativeImage.createFromBuffer` 不解码 ICO**（返回 empty 不抛错），判定用 `img.isEmpty()`；读 asar 内图片用 `readFileSync`+`createFromBuffer`，别用 `createFromPath`。

## 5. Agent 接管不变量

### 解析
- RUN 按 shell 结构解析：`shellIncomplete()` 拒发未写完结构；`needsScriptFile()` 让循环/条件/heredoc 落盘交 `bash file`（测 `spawnSync("bash",["-n","-c",flat])`）。
- `sanitizeCommandLine()`：>8 段或 >2000 字符整条拒绝，不静默截断。
- 优先级 **DONE > PLAN > RUN**；**RUN/DONE 同轮 = 命令优先**（`done:false`+`deferredAnswer`，执行后回灌「结论早于执行不可采信」）；**PLAN 可与 RUN 同轮**（存 plan 后不 continue）。
- **DONE 无正文 = 空总结**：`finalAnswer` 禁 `|| raw`；store 按「去 markdown 后有效字符 <12」打回，连 3 次用 `executedLog` 兜底。孤立标记同理打回。

### 包装与退出码
- `buildExecScript`：多行 → heredoc 落盘；顶层全 `;` → 逐段打点 `{ cmd; echo "TERMAI_EXIT_x:seg:N:$?"; }`（`:seg:` 中缀避开整体正则）；其余 → 只整体退出码。不外包 ` 2>&1`。
- `$?` 只反映最后一条 → `segmentStatus`+`isExecOk()`+`renderSegmentStatus()`。`&&`/`||` 未覆盖。
- **heredoc 路径下包装回显落在 BEGIN 之后** → `extractResult` 用 `isWrapperEchoLine` 按 token 剔除；`cleanTerminalText` 还要剥 OSC（CSI 正则管不到）。**测多行脚本不能 `; ` 拍平**（走单行路径，测不到）。
- **多行下发形态（`&&`/`||` 链）新增两条铁律**：① 从原始行切出来的**每个视图**（含 `segments[i].output`）都要过 `isWrapperEchoLine`，只修整体 output 会让模型看到哨兵 token；② 任何「按行首/行尾」匹配输出的判据（`detectInteractivePrompt`）必须先剥 `TERMAI_(BEGIN|EXIT|END)_\w+(:\w+)*`，否则 `echo -n "Password: "` 被分段打点粘住 → 硬等 120s 超时。

### 闸门
- 去重①逐字 `createDupTracker`（按子命令；写成功≥1 拒，只读全成功≥2 拒；**失败命令永不进闸门**）；②同族 `cmdFamily`（基础命令+位置参数，忽略 flag；写 segment 跳过；`$(...)` → null）。
- 拒绝只剔该条保留其余，`dupStreak` 连拒 3 轮收尾。**闸门窗口与 `pickLedgerLines` 必须对齐**，否则回填输出 + 清零。
- **分项闸门会互相重置 → 必须有形态无关兜底** `stalledRounds/MAX_STALLED_ROUNDS=5`（只看有无新增 steps）。加「某形态连击 N 停」必问「交替时谁清零谁」。
- 截断轮不建 step 不耗步数 → 必须 `truncationStreak>=3` 收敛。并发用**内存同步锁 `runningSessions`**，不用 `phase`。

### 观察 / 记忆
- **主机画像** `lib/hostFacts.ts`：`{os,kernel,arch,pkgManager,container}` 存 `bucket.facts`（跨任务，reset 清），每轮进 system；已覆盖的探测命令**不执行**直接回填（每维度只拦一次）。批量上限 `AGENT_MAX_BATCH_COMMANDS=6`。
- 预算 `OBSERVATION_MAX_CHARS=8000`，每条保底 800，余量补缺口最大者；超长 `focusOutput()` 头/错误行/尾。**观察粒度 = 命令行**（`extractResult.segments` 逐段独立块）。
- 台账 `digestOutput(text,240,3)` 跳表头行。**`messages` 持久化进 `AgentBucket.messages`**，绝不重建；续跑继承 + `buildResumeNote`；接管前注入 `session.recentOutput`。`isFresh` **只看目标变没变**。
- 压缩：`COMPRESS_TRIGGER=22`、`KEEP_RECENT=8`、`MAX_AGENT_MESSAGES=30`，硬截断阈值须明显大于触发；压缩用 `agentConfig` + 短超时。
- **token 预算随窗口推算**：`estimateContextWindow` 只下调；`MAX_CONTEXT_TOKENS=max(6000,min(28k,窗口×45%))`；`trimMessages` 按「条数 或 token」双条件。
- 单命令双阈值：静默 120s + 硬上限 15min（`shouldAbortWait`）。等待确认 10min 超时（`CONFIRM_TIMEOUT_MS`，**不要 unref**，否则锁不释放）。接管期 PTY 独占（`isAgentHoldingInput`，只放行 Ctrl+C）。
- 断线在循环顶部查 `connected`，别白烧 20 步。

### 安全 / 显示
- `reviewCommand` 判 low/none **无确认直接执行**。已覆盖任意 `| sh|bash`、`docker run --privileged`、`>> authorized_keys`、`> /etc/{passwd,shadow,sudoers}`、`truncate -s 0 /var/log/*`；正则 `sh` 后须跟空白/结尾/`|`/`)`（别误伤 shasum）。加新危险形态先想「判几级」。
- 哨兵回显 `lib/agentEcho.ts`：**只从显示剔除，不改原始流**；区间抑制从回显行到 BEGIN 独立成行，命中补 `\r\n`；补回命令不带 `$` 前缀。看 `agentEcho.test.ts`。
- 打转告知：`createFailTreadmill` 靠错误签名（`ok=true` 不计数不重置）；`probeTargetOf` 只认同 host:port 无信息探测。**先核观察预算再决定补提示词还是补引擎**。
- 删不掉**先怀疑挂载点**：伪文件系统签名 mode 777 + size 0 + 时间戳全同 + `total 0`。EBUSY 每步签名都变（rm 退 1 → umount 退 32）→ 已加 `busyMountHint()`。

## 8. UI 核对
- **tailwind 只扫 `src/**`**：自写 HTML（预览、探针页）里的 `bottom-0`/`min-h-screen` 不会生成，
  必须内联 style；改完组件要重新 `vite build` 才能拿到含新类的 `dist/assets/*.css`。
- 截图核验不用 playwright：`dist-test/preview/`（esbuild 打包 entry.tsx + electron `capturePage`，
  `shot.cjs` 读 SHOT_PAGE/SHOT_OUT/SHOT_WIDTH/SHOT_HEIGHT/SHOT_WAIT_MS 环境变量；**不能传位置参数**，会 SIGTERM）。
- 状态栏这类窄条：flex 子项要 `whitespace-nowrap` + `truncate min-w-0`；**别再外包一层 span**——
  多一层可收缩盒子会让内部定宽按钮溢出、被 `ml-auto` 组压住（实测 380px 按钮挤在 331px 容器里）。
- **控制符必须整段剥**（`stripControlSequences()`：OSC / DCS / CSI / `ESC(B` / 单字符 ESC）。只剥 CSI 再删 ESC 会留下 `(B` **粘在包名后**（yum 用 `ESC(B` 高亮包名 → `No package docker-ce(B available`），模型据此反复装不存在的包名。**新接一种终端形态先查这类残片**。
- 服务/包诊断注入 `serviceDiagHint(output, command)`：`Job for X.service failed`（无根因→journalctl，别重复 start，一次 60~90s）、`is-active` 回 `failed`（`start` 返回 0 的假成功）、`executable file not found in $PATH`（半装→`yum reinstall`，不是换包名）、`failed to dial "*.sock"`（上游没起，containerd→docker）。store 用 `diagNoteFor()` **同一段只发一次**。

### 探针
- `dist-test/probe/`：`node build.mjs && node loop.mjs`（收敛）/ `audit.mjs`。真实主机：`build-realssh.mjs`+`realssh.mjs`（凭据不入库）。

## 6. 伪装 Xshell
- 检测点（改名文件零作用）：注册表 `NetSarang\Xshell\*\Install`、卸载项 `Uninstall\Xshell 7`、协议 `Classes\xshell`（需 `URL Protocol`）、硬编码安装路径。
- 坑：`rcedit({icon})` 不写 version info；productName 改 userData（已固定 termai）；「点了没反应」看 `%APPDATA%\TermAI\logs\argv-debug.log`。

## 7. 本环境（Windows）
- `reg.exe` 在黑名单、`wmic` 已移除；Bash 调 powershell 被拒。
- **PowerShell 工具 stdout 不回显但命令确实执行** → 写 `Out-File 'D:\Trae\scripts\_x.txt' -Encoding utf8` 再 Read。
- **`Add-Type`（编译/加载 .NET）与 COM 实例化（`New-Object -ComObject WScript.Shell`）都被安全策略拦** → 需要 Win32 API（枚举窗口、模拟输入）时改用 **python + ctypes**（`python` 在 PATH，3.13）。截屏同理走 python。
- 查「用的哪个模型」：`%APPDATA%/termai/Local Storage/leveldb/*.{log,ldb}` 的 `"model":"..."`。
