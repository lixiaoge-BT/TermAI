# Jump Connect（堡垒机外部唤起）交接文档

> 用途：新会话接手本功能时，**只需读这一个文件 + `git diff`**，无需重读源码。
> 最后更新：2026-09-04

## 一、任务背景

Brett 把堡垒机 H5 的「外部 SSH 客户端」路径从 Xshell 改成了 TermAI.exe。
点堡垒机里的 Xshell 图标后 TermAI 能弹出，但**只连到本地终端**（`host=local`），
不会自动连堡垒机指定的目标主机 + wsupport 账号。

**根因**：TermAI 原本完全没有「接收外部唤起参数」的能力。
堡垒机按 Xshell 约定 spawn `TermAI.exe -url ssh://user:pw@host:port`，
参数其实已经在 `process.argv` 里了，只是没人解析。

## 二、改动清单（git 视角）

| 文件 | 性质 | 说明 |
|---|---|---|
| `electron/main/deepLink.ts` | 新增 475 行 | argv/URL 解析器，纯函数 |
| `electron/main/deepLink.test.ts` | 新增 343 行 | 21 个单元测试 |
| `electron/main/argvDebug.ts` | 新增 130 行 | 取证日志（密码脱敏） |
| `electron/main/index.ts` | 改 +132/−12 | 协议注册 + 三个入口解析 + IPC 推送 |
| `electron/preload/index.ts` | 改 | 新增 `__jump.onJumpConnect` 桥 + 类型 |
| `src/lib/jumpConnect.ts` | 新增 170 行 | 渲染层收到参数 → 建 tab → 连接 |
| `src/App.tsx` | 改 | `initJumpConnect()` 挂在 `initTerminalBridge()` 之后 |
| `src/types/index.ts` | 改 | re-export 类型 + `window.__jump` 声明 |
| `package.json` | 改 | `build.win.protocols` 注册 `termai`（**只注册 termai，不劫持 ssh://**）|
| `scripts/run-tests.mjs` | 改 | 测试清单加 `deepLink.test.ts` |

## 三、支持的调用形态（21 个测试覆盖）

| 形态 | 示例 |
|---|---|
| `-url` | `TermAI.exe -url "ssh://user:pw@host:22"` |
| `-newtab -url` | `TermAI.exe -newtab -url "ssh://..."` |
| `-ssh` | `TermAI.exe -ssh user@host -pw pw -p 22` |
| `-ssh` 端口内联 | `TermAI.exe -ssh user@host:2222 -pw pw` |
| `-t`（OpenSSH 风）| `TermAI.exe -t user@host -pw pw -p 22` |
| 长 flag | `TermAI.exe -l user -h host -p 22 -w pw` |
| 长 KV | `TermAI.exe --server=host --user=u --password=p --port=22` |
| 裸 target | `TermAI.exe user@host -pw pw -p 22` |
| `.xsh` 会话文件 | `TermAI.exe "C:\...\session.xsh"` |
| 裸 URL | `TermAI.exe "ssh://user:pw@host:22"` |
| `termai://` 协议 | `TermAI.exe termai://connect?host=X&user=Y&password=Z` |

**散装 argv 兜底**：Electron 会重排 `second-instance` 的 argv（开关提前、值拆到末尾），
已加按位置补 port/password 的兜底。详见第五节坑 #2。

## 四、数据流

```
堡垒机 H5 spawn TermAI.exe -url ssh://...
   ↓ argv
main: parseJumpArgs() 解析
   ↓ （首次启动）pendingJumpRequest 缓存 → did-finish-load 后推送
   ↓ （二次唤起）second-instance 事件直接推送
   ↓ IPC 'jump:connect'
preload: window.__jump.onJumpConnect(cb)
   ↓
renderer jumpConnect.ts:
   1. ensureJumpHost()  → 写入 useAppConfig.hosts（按 host+port+user 三元组去重）
   2. createSession()   → 建 SSH tab，绑 hostId
   3. ensureVisible()   → 在当前面板显示
   4. __termai_connect() → 走 ssh:connect 发起连接（8 次重试兜底桥未 ready）
```

## 五、踩过的坑（**改动本功能前必读**）

### 1. `did-finish-load` 必须在 `loadURL/loadFile` **之前**注册

```typescript
await win.loadURL(url);                       // ❌ await 返回时事件已触发完
win.webContents.on("did-finish-load", flush); // ❌ 永远收不到
```

首次唤起的参数会永远卡在 `pendingJumpRequest` 里，**静默失效**（不报错、不打日志）。
顺带修掉了一个潜在的 5 秒白屏（原实现靠 5s 兜底定时器显示窗口）。

### 2. Electron 会重排 `second-instance` 的 argv

原始 `-ssh wsupport@10.0.0.5 -pw secret123 -p 2222`，事件回调实际收到：

```
[..., "-ssh", "-pw", "-p", "--allow-file-access-from-files", ".",
 "wsupport@10.0.0.5", "secret123", "2222"]
```

开关被提到前面、值拆成末尾位置参数 → 端口掉回 22、密码丢失。
已加散装兜底；**必须真跑双实例才能发现，单测测不出来**。

### 3. 密码脱敏要按「值」而不是按「flag 位置」

argv 重排后 `secret123` 不再紧跟 `-pw`，按位置脱敏会**明文落盘**。
改为用解析出的 password 反查 argv token 打码。

### 4. 日志路径用 package.json 的 `name`（小写）

`%APPDATA%\termai\logs\argv-debug.log` —— 不是 `TermAI`。

### 5. 打包前先确认运行的是哪个 exe

旧安装 `AppData\Local\Programs\TermAI\TermAI.exe` 会照常启动、吞掉所有唤起请求，
但里面一行新代码都没有。检查：

```powershell
Get-CimInstance Win32_Process -Filter "Name='TermAI.exe'" | Select-Object ProcessId, ExecutablePath
```

## 六、验证

- 单元：`node scripts/run-tests.mjs` → **106/106 通过**
- 类型：`npx tsc -b --noEmit` → 零错误
- 构建：`node scripts/build-electron.mjs build`
- 冒烟：`npm start -- -url "ssh://wsupport:testpass@1.2.3.4:22"`
  再起第二个实例 `npm start -- -ssh wsupport@10.0.0.5 -pw secret123 -p 2222`
  期望 port=2222 正确、密码带上、日志两处密码均脱敏
- 打包产物校验：
  ```bash
  grep -ao "onJumpConnect\|parseXshFile\|parseBareTarget\|setAsDefaultProtocolClient\|argv-debug.log" \
    release/win-unpacked/resources/app.asar | sort | uniq -c
  ```

## 七、生产排查手册

用户从堡垒机点一次后看 `%APPDATA%\termai\logs\argv-debug.log`：

| 日志表现 | 结论 | 处理 |
|---|---|---|
| `argv.length=1`（只剩 exe） | 堡垒机压根没传参 | 去堡垒机配命令行模板 `-url ssh://{user}:{password}@{host}:{port}` |
| `parsed = null` 但 argv 有东西 | 新格式未覆盖 | 照格式补 `deepLink.ts` 的 parser |
| `parsed` 有值但没连上 | SSH 握手问题 | 看连接日志 |

## 八、待办

- [ ] `argvDebug.ts` 日志无轮转、每次启动写 3 行（~350B），约 1.2MB/年。
      对接稳定后：加 `TERMAI_ARGV_DEBUG` 开关 / 超 1MB 轮转 / 直接删调用，三选一。
- [ ] 等 Brett 从真实堡垒机点一次，用取证日志确认实际命令行格式。

## 九、相关资源

- 可复用 skill：`~/.workbuddy/skills/electron-xshell-deep-link/`
  （含 parser 源码、21 个测试、e2e 脚本，Common Pitfalls 已收录上述 5 个坑）
