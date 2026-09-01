# TermAI

TermAI 是一款 AI 增强的终端 / SSH 客户端（类 Xshell），基于 Electron + React + TypeScript 构建。
它把「传统终端」和「AI 助手」放在同一界面：既能像普通 SSH 客户端一样操作服务器，也能让 AI
直接接管终端、真实下发命令并读回输出，还能通过本地规则对命令做安全审查，降低误操作风险。

## 功能特性

- **SSH 终端**：多标签、会话管理，支持主机分组、标签（tag）标注，可标记「生产环境」等。
- **本地终端**：除了 SSH，也可直接在本地打开 PTY 终端。
- **AI 问答（侧边栏）**：针对当前会话上下文向 AI 提问，获取解释、排障建议、命令示例。
- **Agent 接管终端**：AI 可把决策真正下发到终端执行，并用哨兵协议（BEGIN/END/EXIT）精确切分
  每条命令的输出与退出码，再基于真实输出决定下一步，而非「凭空编命令」。
- **命令安全审查**：本地规则对命令做风险分级（none / low / medium / high / critical），
  只读命令放行，危险命令（如 `rm -rf /`、格式化、DROP DATABASE）强制二次确认，生产环境写操作默认需确认。
- **文件传输**：基于 SFTP 的远程文件浏览、上传 / 下载、新建目录、删除。
- **凭据加密存储**：SSH 密码 / 私钥口令等敏感信息通过 Electron `safeStorage` 静态加密落盘，
  不写明文（加密失败自动降级为明文并提示）。
- **AI 上下文预算**：Agent 多步任务的上下文有上限与超时兜底，避免 token 线性膨胀或任务无限空跑。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面壳 | Electron 31 |
| 前端 | React 18 + TypeScript + Vite 6 |
| 状态管理 | zustand（`persist` + 自定义加密 storage） |
| 终端 | xterm + node-pty（本地 PTY）/ ssh2（SSH） |
| 构建 / 打包 | electron-builder（nsis + portable） |

## 快速开始

```bash
npm install        # 安装依赖
npm run dev        # 开发模式（同时启动渲染进程、Electron、应用）
npm run build      # 生产构建（渲染 + 主进程）
npm run dist       # 打包为安装包（输出到 release/<version>/）
```

> 首次在本地终端使用 `node-pty` 相关功能时，可能需要原生模块重建：
> `npx @electron/rebuild -f -m .`（CI 与打包脚本已处理）。

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发模式（热更新） |
| `npm run build` | 生产构建：`build:renderer` + `build:electron` |
| `npm run build:renderer` | 仅构建渲染进程（tsc + vite build） |
| `npm run check` | TypeScript 类型检查（`tsc -b --noEmit`） |
| `npm run lint` | ESLint 检查 |
| `npm test` | 运行单元测试（Node 内置 `node:test`，经 esbuild 打包，无需联网） |
| `npm run setup:hooks` | 启用 git pre-commit 钩子（见下方「代码质量」） |
| `npm run dist` / `npm run pack` | 打包 / 免安装目录 |

## 代码质量

项目已接入三层质量门禁：

1. **ESLint**（`npm run lint`）—— 类型感知的 TS/React 规则。
2. **类型检查**（`npm run check`）—— 提交前保证 `tsc` 零错误。
3. **单元测试**（`npm test`）—— 覆盖 Agent 协议解析、命令安全审查等核心纯逻辑。
   测试不依赖 vitest，使用项目已有的 esbuild 打包后用 Node 内置 `node:test` 运行，适配离线环境。

**提交前自动检查**：运行一次 `npm run setup:hooks` 即可把 git 的 hooks 目录指向仓库内的
`.githooks`（无需 husky、无需联网）。此后每次 `git commit` 会自动执行 ESLint、类型检查与单元测试。

**CI**：`.github/workflows/ci.yml` 在 push / PR 时自动跑 lint、check、test 与渲染进程构建。

## 安全说明

- 凭据采用 Electron `safeStorage` 静态加密（密文以 `ENC:` 前缀 + base64 形式存储）。
- 命令在执行前会经过本地风险分级；高危命令强制人工确认，生产环境写操作默认需确认。
- Agent 下发命令前会校验终端在线状态，避免命令「石沉大海」。

## 目录结构（精简）

```
src/
  components/   UI 组件（终端、Agent 面板、文件管理器、主机面板等）
  services/     AI 调用、Agent 执行引擎、命令安全审查
  store/        zustand 状态（配置 / 终端会话 / Agent 会话）
  lib/          终端桥接、加密存储等基础设施
  electron/     Electron 主进程 / 预加载脚本
scripts/        构建与测试运行脚本
```
