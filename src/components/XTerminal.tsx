import { useEffect, useRef, useMemo, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "xterm/css/xterm.css";
import { useTerminalStore } from "@/store/terminal";
import { useAppConfig } from "@/store/config";
import { useForwardStore } from "@/store/forward";
import { emitTerminalOutput } from "@/lib/terminalBus";
import { recordOutput, commitOperation } from "@/lib/recorder";
import { registerTerminalInstance, unregisterTerminalInstance } from "@/lib/terminalBridge";
import type { HostConfig } from "@/types";

/* eslint-disable no-control-regex */
// ANSI 转义码正则，用于清理终端输出给 AI 上下文
const ANSI_REGEX = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[=>]/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

// 连接建立后，自动恢复该主机 enabled 的端口转发（避免重复启动：先刷新实际状态）
async function restoreForwards(sessionId: string) {
  const session = useTerminalStore.getState().sessions.find((s) => s.id === sessionId);
  if (!session?.hostId) return;
  const host = useAppConfig.getState().getHost(session.hostId);
  const forwards = host?.forwards ?? [];
  if (!forwards.some((f) => f.enabled)) return;
  const fw = useForwardStore.getState();
  fw.init();
  await fw.refresh(sessionId);
  const current = useForwardStore.getState().statuses[sessionId] ?? [];
  if (current.length === 0) await fw.restore(sessionId, forwards);
}

// 终端报错关键词：命中即认为可能出现了错误/异常，用于「自动分析终端报错」
const ERROR_PATTERN = /\b(error|errors|failed|failure|fatal|exception|denied|refused|not found|no such file|command not found|no such command|permission denied|segmentation fault|segfault|panic|traceback|stack ?trace|could not|cannot|can'?t|invalid|undefined|timed ?out|abort|critical|unable to|unreachable)\b/i;

// 光标闪烁策略：关闭 xterm 原生 blink（原生 blink 在聚焦/失焦时会整行重绘，
// 导致光标所在行邻字忽明忽暗），改为由 CSS 动画（termai-cursor-blink）驱动闪烁。
// CSS 动画只走合成层（.xterm-cursor 已 will-change:opacity），不会重绘邻字，
// 配合终端灰度抗锯齿，闪烁稳定且邻字不闪。这与 Canvas 渲染器互斥（canvas 光标无
// 对应 .xterm-cursor DOM 节点，CSS 动画无效），故本项目使用 DOM 渲染器。
function assertBlinking(term: Terminal) {
  term.options.cursorBlink = false;
  term.options.cursorStyle = "bar";
  term.options.cursorWidth = 2;
}

// 深色主题（GitHub Dark 风格）
const DARK_THEME = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#58a6ff",
  cursorAccent: "#0d1117",
  selectionBackground: "#264f78",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

// 浅色主题（Light 风格，白底黑字）
const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#24292f",
  cursor: "#0969da",
  cursorAccent: "#ffffff",
  selectionBackground: "#b6e3ff",
  black: "#24292f",
  red: "#cf222e",
  green: "#1a7f37",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#116329",
  brightYellow: "#7d4e00",
  brightBlue: "#0550ae",
  brightMagenta: "#6639ba",
  brightCyan: "#0c6b72",
  brightWhite: "#8c959f",
};

interface Props {
  sessionId: string;
  hostConfig?: HostConfig | null;
  onRequestAI?: (prompt: string) => void;
  mode?: "ssh" | "local";
}

export function XTerminal({ sessionId, hostConfig: _hostConfig, onRequestAI, mode = "ssh" }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const currentLineRef = useRef<string>("");
  // 终端内查找浮层状态（Ctrl+F 唤起）
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCase, setSearchCase] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // 把真实 cols/rows 同步给后端 PTY/远端 shell 的函数。
  // 由终端初始化时写入，供「SSH 连接成功 / 本地 PTY 就绪」回调主动调用 ——
  // 这两个时刻之前后端还没就绪，早先的同步都是空转的。
  const pushSizeRef = useRef<(() => void) | null>(null);
  // 离线/AI 提示模式下使用的命令历史（PTY 已连接的 shell 由 shell 自身提供历史）
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef<number>(-1);
  // 终端字号（Ctrl+滚轮缩放）
  const fontSizeRef = useRef<number>(14);
  // AI 配置（用于自动分析开关），需在 refs 之前声明以免 TDZ
  const aiConfig = useAppConfig((c) => c.aiConfig);
  // AI 自动分析：缓存最新配置与防抖时间戳（用 ref 避免 effect 因配置变化而重建终端）
  const aiConfigRef = useRef(aiConfig);
  const lastAutoAnalyzeRef = useRef(0);
  useEffect(() => { aiConfigRef.current = aiConfig; }, [aiConfig]);

  // 命中报错关键词且开启自动分析时，唤起 AI 分析（带 20s 防抖，避免输出风暴）
  const tryAutoAnalyze = (text: string) => {
    const cfg = aiConfigRef.current;
    if (!cfg?.autoAnalyze || !cfg?.apiKey) return;
    if (!ERROR_PATTERN.test(text)) return;
    const now = Date.now();
    if (now - lastAutoAnalyzeRef.current < 20000) return;
    lastAutoAnalyzeRef.current = now;
    window.dispatchEvent(
      new CustomEvent("termai:quick-ask", {
        detail:
          "⚠️ 我终端刚刚输出了错误/异常信息。请立刻分析以上终端上下文中的报错：指出错误原因，并按优先级给出可直接执行的修复命令（高风险操作需提示确认）。",
      })
    );
  };
  const session = useTerminalStore((s) => s.sessions.find((x) => x.id === sessionId));
  const updateSession = useTerminalStore((s) => s.updateSession);
  const appendOutput = useTerminalStore((s) => s.appendOutput);
  const appendCommand = useTerminalStore((s) => s.appendCommand);
  const appTheme = useAppConfig((c) => c.theme);

  // 响应式计算当前实际主题
  const resolvedTheme = useMemo<"dark" | "light">(() => {
    if (appTheme === "system") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return appTheme;
  }, [appTheme]);

  const termTheme = resolvedTheme === "light" ? LIGHT_THEME : DARK_THEME;

  // 监听主题变化，动态切换 xterm 主题
  useEffect(() => {
    const term = termRef.current;
    if (term) {
      term.options.theme = termTheme;
      // 主题切换后保持光标闪烁配置
      assertBlinking(term);
      // 强制刷新视图
      term.refresh(0, term.rows - 1);
    }
  }, [termTheme]);

  // 1. 初始化 xterm
  useEffect(() => {
    let disposed = false;
    let handleResize: (() => void) | null = null;
    let focusHandler: (() => void) | null = null;
    let selectionDisposable: { dispose: () => void } | null = null;
    let resizeDisposable: { dispose: () => void } | null = null;
    let onContextMenu: ((e: MouseEvent) => void) | null = null;
    let onWheel: ((e: WheelEvent) => void) | null = null;
    let onViewportScroll: ((e: Event) => void) | null = null;
    let scrollHideTimer: number | null = null;
    let ro: ResizeObserver | null = null;
    const container = containerRef.current;

    const createTerminal = () => {
      if (disposed || !containerRef.current || termRef.current) return;
      if (containerRef.current.clientWidth === 0 || containerRef.current.clientHeight === 0) {
        setTimeout(createTerminal, 50);
        return;
      }

      try {
        const term = new Terminal({
          fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, "Courier New", monospace',
          fontSize: fontSizeRef.current,
          lineHeight: 1.2,
          cursorBlink: false,
          cursorStyle: "bar",
          cursorWidth: 2,
          scrollback: 5000,
          convertEol: false,
          allowProposedApi: true,
          theme: termTheme,
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        const searchAddon = new SearchAddon();
        term.loadAddon(searchAddon);
        searchAddonRef.current = searchAddon;
        term.open(containerRef.current);
        // 使用 DOM 渲染器（xterm 默认）：光标为真实 .xterm-cursor DOM 节点，
        // 可被 CSS 动画驱动稳定闪烁；原生 blink 已关闭（options.cursorBlink=false），
        // 由 src/index.css 的 termai-cursor-blink 接管，邻字不闪。

        // 把 xterm 的真实 cols/rows 推给后端 PTY / 远端 shell。
        // 后端建 shell 时如果停留在默认 80x24，而屏幕实际更宽，shell 会在第 80 列
        // 就换行、光标定位也算错 —— 表现就是长命令错行、按 ↑ 翻历史越翻越乱。
        const pushSize = () => {
          if (mode === "local") window.localTerminal?.resize(sessionId, term.cols, term.rows);
          else window.ssh?.resize(sessionId, term.cols, term.rows);
        };
        // 挂到 ref：连接成功 / PTY 就绪的回调里要能主动调一次
        pushSizeRef.current = pushSize;

        // fit + 无条件同步。不能只依赖 term.onResize —— fit() 在尺寸没变化时
        // 不会触发 onResize，错过初始同步后就再也没机会纠正了。
        const fitAndSync = () => {
          try { fitAddon.fit(); } catch { /* render service not ready */ }
          pushSize();
        };

        resizeDisposable = term.onResize(() => pushSize());

        // 本地终端：用「fit 之后」的真实尺寸启动 PTY，而不是让它先跑在 80x24 再纠正
        const startLocalBackend = () => {
          if (mode !== "local") return;
          term.writeln("正在启动本地终端...");
          if (window.localTerminal) {
            window.localTerminal
              .create(sessionId, undefined, term.cols, term.rows)
              .then((ok) => {
                if (!ok) {
                  term.writeln("\x1b[1;31m本地终端启动失败\x1b[0m");
                }
                // 双保险：PTY 就绪后再同步一次（create 期间可能又有尺寸变化）
                pushSizeRef.current?.();
              })
              .catch((e) => {
                term.writeln(`\x1b[1;31m本地终端启动失败：${(e as Error).message}\x1b[0m`);
              });
          } else {
            term.writeln("\x1b[1;31m⚠️ 本地终端桥接未加载\x1b[0m");
          }
        };

        requestAnimationFrame(() => {
          if (disposed) return;
          fitAndSync();
          // 初始化后立即聚焦终端，并强制光标闪烁（聚焦才会闪烁）
          assertBlinking(term);
          term.focus();
          // 尺寸已就位，此时再启动本地 PTY
          startLocalBackend();
        });

        // 监听容器尺寸变化（切换标签页 display:none、AI 侧栏开合、窗口缩放等），
        // 自动重新计算 cols/rows 并同步给后端。
        try {
          ro = new ResizeObserver(() => {
            if (disposed || !containerRef.current) return;
            const el = containerRef.current;
            // 隐藏状态下尺寸为 0，跳过，待再次显示时由 RO 触发重算
            if (el.clientWidth === 0 || el.clientHeight === 0) return;
            fitAndSync();
          });
          ro.observe(containerRef.current);
        } catch {
          /* 老环境不支持 ResizeObserver 时回退到 window resize 监听 */
        }

        termRef.current = term;
        fitAddonRef.current = fitAddon;
        // 注册到全局终端表，供 AI 命令执行 / SSH 连接回调写入正确的终端
        registerTerminalInstance(sessionId, () => termRef.current);

        if (mode !== "local") {
          if (!window.ssh) {
            term.writeln("\x1b[1;31m⚠️ SSH 桥接未加载！window.ssh 未定义。\x1b[0m");
            term.writeln("请检查 preload 脚本是否正确编译。");
          }
        }
        term.writeln("");

        // 点击终端区域时聚焦（并确保光标闪烁）
        focusHandler = () => {
          const t = termRef.current;
          if (t) {
            assertBlinking(t);
            t.focus();
          }
        };
        containerRef.current.addEventListener("click", focusHandler);
        containerRef.current.addEventListener("mousedown", focusHandler);

        // 左键选中文本即复制到剪贴板（终端常见行为：选中即复制）
        selectionDisposable = term.onSelectionChange(() => {
          const sel = term.getSelection();
          if (sel && sel.length > 0) {
            try {
              window.clipboard.writeText(sel);
            } catch {
              /* 剪贴板不可用时忽略 */
            }
          }
        });

        // 右键点击终端即粘贴剪贴板内容
        onContextMenu = (e: MouseEvent) => {
          e.preventDefault();
          try {
            const text = window.clipboard.readText();
            if (text) term.paste(text);
          } catch {
            /* 剪贴板不可用时忽略 */
          }
        };
        containerRef.current.addEventListener("contextmenu", onContextMenu);

        // Ctrl+滚轮调整字号（仅 Ctrl 组合，避免干扰普通滚动）
        onWheel = (e: WheelEvent) => {
          if (!e.ctrlKey) return;
          e.preventDefault();
          const delta = e.deltaY < 0 ? 1 : -1;
          const next = Math.max(8, Math.min(32, fontSizeRef.current + delta));
          if (next === fontSizeRef.current) return;
          fontSizeRef.current = next;
          term.options.fontSize = next;
          try { fitAddon.fit(); } catch { /* ignore */ }
        };
        containerRef.current.addEventListener("wheel", onWheel, { passive: false });

        // 滚动条自动隐藏：滚动时给 viewport 加 .is-scrolling 让 CSS 显示滚动条，
        // 停止滚动 700ms 后移除，恢复隐藏。需要 wheel / 键盘翻页 / 拖滑块都生效，
        // 因此挂到 viewport 的 scroll 事件而不是仅 wheel。
        const viewport = containerRef.current.querySelector(
          ".xterm-viewport"
        ) as HTMLElement | null;
        if (viewport) {
          onViewportScroll = () => {
            viewport.classList.add("is-scrolling");
            if (scrollHideTimer != null) window.clearTimeout(scrollHideTimer);
            scrollHideTimer = window.setTimeout(() => {
              viewport.classList.remove("is-scrolling");
              scrollHideTimer = null;
            }, 700);
          };
          viewport.addEventListener("scroll", onViewportScroll);
        }

        handleResize = () => { fitAndSync(); };
        window.addEventListener("resize", handleResize);
      } catch (e) {
        console.error("[XTerminal] 初始化失败，将在下一帧重试:", e);
        requestAnimationFrame(createTerminal);
      }
    };

    // 延迟初始化确保容器已渲染
    const initTimer = setTimeout(createTerminal, 100);

    return () => {
      disposed = true;
      unregisterTerminalInstance(sessionId);
      pushSizeRef.current = null;
      clearTimeout(initTimer);
      ro?.disconnect();
      if (handleResize) window.removeEventListener("resize", handleResize);
      if (focusHandler && container) {
        container.removeEventListener("click", focusHandler);
        container.removeEventListener("mousedown", focusHandler);
      }
      if (onContextMenu && container) {
        container.removeEventListener("contextmenu", onContextMenu);
      }
      if (onWheel && container) {
        container.removeEventListener("wheel", onWheel);
      }
      if (onViewportScroll && container) {
        const vp = container.querySelector(".xterm-viewport");
        vp?.removeEventListener("scroll", onViewportScroll);
      }
      if (scrollHideTimer != null) {
        window.clearTimeout(scrollHideTimer);
        scrollHideTimer = null;
      }
      selectionDisposable?.dispose();
      resizeDisposable?.dispose();
      termRef.current?.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
    // 仅在挂载时初始化一次；mode/sessionId 由父级 key 保证实例唯一，termTheme 由单独的 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1.5 维持光标闪烁：仅在窗口重新获得焦点、或页面重新可见时才把焦点交还终端，
  //     不再每秒轮询 term.focus()（旧实现会反复抢占焦点、浪费且脆弱）。
  useEffect(() => {
    const focusTerm = () => {
      const term = termRef.current;
      const el = containerRef.current;
      // 仅当终端区域实际可见时才聚焦，避免隐藏标签页被强行抢焦点
      if (term && el && el.clientWidth > 0 && el.clientHeight > 0) {
        term.focus();
      }
    };
    document.addEventListener("visibilitychange", focusTerm);
    window.addEventListener("focus", focusTerm);
    return () => {
      document.removeEventListener("visibilitychange", focusTerm);
      window.removeEventListener("focus", focusTerm);
    };
  }, [sessionId]);

  // 1.6 Ctrl+F / Cmd+F 唤起终端内查找浮层
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 查找浮层打开时自动聚焦输入框
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // 执行一次查找（next/prev）
  const runSearch = (direction: "next" | "prev") => {
    const addon = searchAddonRef.current;
    const q = searchQuery.trim();
    if (!addon || !q) return;
    if (direction === "next") addon.findNext(q, { caseSensitive: searchCase, incremental: true });
    else addon.findPrevious(q, { caseSensitive: searchCase });
  };

  // 2. 监听 SSH / 本地终端事件
  useEffect(() => {
    if (mode === "local") {
      if (!window.localTerminal) return;

      const unsubData = window.localTerminal.onData((sid, data) => {
        if (sid !== sessionId) return;
        termRef.current?.write(data);
        // 录制：必须在 stripAnsi 之前采集原始数据，回放才能还原颜色与光标
        recordOutput(sessionId, data);
        const cleaned = stripAnsi(data);
        // 广播增量输出：供 Agent 模式实时捕获命令回显（不受 recentOutput 200 行裁剪影响）
        if (cleaned) emitTerminalOutput(sessionId, cleaned);
        if (cleaned.trim()) {
          appendOutput(sessionId, cleaned, 200);
          tryAutoAnalyze(cleaned);
        }
      });

      const unsubReady = window.localTerminal.onReady((sid) => {
        if (sid !== sessionId) return;
        updateSession(sessionId, { status: "connected", connected: true, startTime: Date.now() });
        // PTY 真正就绪的这一刻才能把尺寸推成功，之前的调用全是空转
        pushSizeRef.current?.();
        termRef.current?.writeln("\x1b[1;32m✅ 本地终端已就绪\x1b[0m");
        setTimeout(() => {
          const t = termRef.current;
          if (t) { assertBlinking(t); t.focus(); }
          pushSizeRef.current?.();
        }, 150);
      });

      const unsubExit = window.localTerminal.onExit((sid, code) => {
        if (sid !== sessionId) return;
        updateSession(sessionId, { status: "disconnected", connected: false });
        termRef.current?.writeln("");
        termRef.current?.writeln(`\x1b[1;33m本地终端已退出 (code=${code})\x1b[0m`);
      });

      const unsubError = window.localTerminal.onError((sid, err) => {
        if (sid !== sessionId) return;
        updateSession(sessionId, { status: "error", connected: false, errorMsg: err });
        termRef.current?.writeln(`\x1b[1;31m错误：${err}\x1b[0m`);
      });

      return () => {
        unsubData?.();
        unsubReady?.();
        unsubExit?.();
        unsubError?.();
      };
    }

    // SSH mode
    if (!window.ssh) return;

    const unsubscribe = window.ssh.onData((sid, data) => {
      if (sid !== sessionId) return;
      termRef.current?.write(data);
      // 录制：必须在 stripAnsi 之前采集原始数据，回放才能还原颜色与光标
      recordOutput(sessionId, data);
      const cleaned = stripAnsi(data);
      // 广播增量输出：供 Agent 模式实时捕获命令回显（不受 recentOutput 200 行裁剪影响）
      if (cleaned) emitTerminalOutput(sessionId, cleaned);
      if (cleaned.trim()) {
        appendOutput(sessionId, cleaned, 200);
        tryAutoAnalyze(cleaned);
      }
    });

    const unsubscribeStatus = window.ssh.onStatus((sid, status, extra) => {
      if (sid !== sessionId) return;
      const term = termRef.current;
      switch (status) {
        case "connected":
          updateSession(sessionId, { status: "connected", connected: true, startTime: Date.now() });
          // 远端 shell 刚建好，此刻把真实尺寸推过去（建立 shell 时若未带上，
          // 这里就是唯一的补救机会，否则 PTY 会一直停在 80x24）
          pushSizeRef.current?.();
          setTimeout(() => {
            if (term) { assertBlinking(term); term.focus(); }
            pushSizeRef.current?.();
          }, 150);
          // 连接建立后自动恢复该主机 enabled 的端口转发
          void restoreForwards(sessionId);
          break;
        case "error":
          updateSession(sessionId, {
            status: "error",
            connected: false,
            errorMsg: String(extra ?? "未知错误"),
          });
          term?.writeln("");
          term?.writeln(`\x1b[1;31m连接失败：${String(extra ?? "未知错误")}\x1b[0m`);
          break;
        case "reconnecting": {
          const info = extra as { attempt?: number; max?: number; delay?: number } | undefined;
          updateSession(sessionId, { status: "reconnecting", connected: false });
          term?.writeln("");
          term?.writeln(
            `\x1b[1;33m连接断开，正在重连（第 ${info?.attempt ?? "?"}/${info?.max ?? "?"} 次，${Math.round((info?.delay ?? 0) / 1000)}s 后重试）…\x1b[0m`
          );
          break;
        }
        case "reconnected":
          updateSession(sessionId, { status: "connected", connected: true, startTime: Date.now() });
          term?.writeln("");
          term?.writeln("\x1b[1;32m✅ 已自动重连\x1b[0m");
          pushSizeRef.current?.();
          setTimeout(() => {
            if (term) { assertBlinking(term); term.focus(); }
            pushSizeRef.current?.();
          }, 150);
          // 重连成功后自动恢复端口转发
          void restoreForwards(sessionId);
          break;
        case "closed":
        case "close":
        case "end":
        case "exit":
          updateSession(sessionId, { status: "disconnected", connected: false });
          term?.writeln("");
          term?.writeln("\x1b[1;33m连接已关闭\x1b[0m");
          break;
      }
    });

    return () => {
      unsubscribe?.();
      unsubscribeStatus?.();
    };
  }, [sessionId, updateSession, appendOutput, mode]);

  // 3. 处理用户输入
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const disposable = term.onData((data) => {
      if (mode === "local") {
        // 本地终端模式：直接发送到本地 PTY
        if (session?.status === "connected") {
          window.localTerminal?.write(sessionId, data);
        }
        // 仅在未连接或本地 echo 关闭场景下维护输入行，便于记录命令历史
        if (data === "\r") {
          const line = currentLineRef.current.trim();
          if (line && !line.startsWith(" ")) {
            appendCommand(sessionId, line);
            // 操作记录：每次提交命令即一个操作节点（命令 + 后续输出）
            commitOperation(sessionId, line);
          }
          currentLineRef.current = "";
        } else if (data === "\u007f" || data === "\b") {
          currentLineRef.current = currentLineRef.current.slice(0, -1);
        } else if (data.charCodeAt(0) >= 32) {
          currentLineRef.current += data;
        }
        return;
      }

      if (session?.status !== "connected") {
        // 离线/AI 提示模式：上下方向键回放历史（已连接时由 shell 自身提供历史）
        if (data === "\x1b[A" || data === "\x1bOA") {
          recallHistory(-1);
          return;
        }
        if (data === "\x1b[B" || data === "\x1bOB") {
          recallHistory(1);
          return;
        }
        if (data === "\r") {
          term.writeln("");
          const line = currentLineRef.current.trim();
          if (line) {
            pushHistory(line);
            if (onRequestAI && line.startsWith("?")) {
              onRequestAI(line.slice(1).trim());
            } else {
              term.writeln("\x1b[33m[未连接 SSH] 输入 ?<问题> 可直接问 AI。\x1b[0m");
            }
          }
          currentLineRef.current = "";
        } else if (data === "\u007f" || data === "\b") {
          // Backspace
          if (currentLineRef.current.length > 0) {
            currentLineRef.current = currentLineRef.current.slice(0, -1);
            term.write("\b \b");
          }
        } else if (data === "\t") {
          // Tab - 发送空格或tab
          term.write("\t");
        } else if (data.charCodeAt(0) >= 32) {
          // 可打印字符（包括空格 charCode 32）
          currentLineRef.current += data;
          term.write(data);
        }
        return;
      }
      // SSH 已连接：发送到远程
      window.ssh?.write(sessionId, data);
      if (data === "\r") {
        const line = currentLineRef.current.trim();
        if (line && !line.startsWith(" ")) {
          appendCommand(sessionId, line);
          // 操作记录：每次提交命令即一个操作节点（命令 + 后续输出）
          commitOperation(sessionId, line);
        }
        currentLineRef.current = "";
      } else if (data === "\u007f" || data === "\b") {
        currentLineRef.current = currentLineRef.current.slice(0, -1);
      } else if (data.charCodeAt(0) >= 32) {
        currentLineRef.current += data;
      }
    });

    const pushHistory = (cmd: string) => {
      const h = historyRef.current;
      if (h[h.length - 1] !== cmd) {
        h.push(cmd);
        if (h.length > 100) h.shift();
      }
      historyIdxRef.current = h.length;
    };

    // 清除当前输入：输入过长会自动换行占多个物理行，只清一行会留下残字
    const clearInput = (len: number) => {
      const cols = term.cols || 80;
      const lines = Math.floor(len / cols) + 1;
      for (let i = 0; i < lines; i++) {
        term.write("\x1b[2K"); // 清除整行（光标不动）
        if (i < lines - 1) term.write("\x1b[A"); // 上移一行
      }
      term.write("\r"); // 回到行首
    };

    const recallHistory = (dir: number) => {
      const h = historyRef.current;
      if (h.length === 0) return;
      const idx = Math.max(0, Math.min(h.length, historyIdxRef.current + dir));
      historyIdxRef.current = idx;
      // 清掉当前输入（含换行占的行），再回显历史命令
      clearInput(currentLineRef.current.length);
      if (idx < h.length) {
        term.write(h[idx]);
        currentLineRef.current = h[idx];
      } else {
        currentLineRef.current = "";
      }
    };

    return () => disposable.dispose();
  }, [sessionId, session?.status, appendCommand, onRequestAI, mode]);

  return (
    <div
      className="relative w-full h-full bg-terminal-bg"
      onClick={() => termRef.current?.focus()}
    >
      <div
        ref={containerRef}
        className="absolute inset-0"
      />
      {searchOpen && (
        <div
          className="absolute top-2 right-2 z-20 flex items-center gap-1.5 rounded-md border border-border-primary bg-bg-secondary px-2 py-1 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (e.target.value.trim()) runSearch("next");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                runSearch(e.shiftKey ? "prev" : "next");
              } else if (e.key === "Escape") {
                setSearchOpen(false);
                setSearchQuery("");
              }
            }}
            placeholder="查找…"
            className="w-40 bg-transparent text-xs outline-none text-text-primary placeholder:text-text-secondary"
          />
          <button
            onClick={() => runSearch("prev")}
            className="px-1 rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            title="上一个 (Shift+Enter)"
          >
            ↑
          </button>
          <button
            onClick={() => runSearch("next")}
            className="px-1 rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            title="下一个 (Enter)"
          >
            ↓
          </button>
          <label className="flex items-center gap-1 text-[10px] text-text-secondary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={searchCase}
              onChange={(e) => {
                setSearchCase(e.target.checked);
                if (searchQuery.trim()) runSearch("next");
              }}
            />
            Aa
          </label>
          <button
            onClick={() => {
              setSearchOpen(false);
              setSearchQuery("");
            }}
            className="px-1 rounded text-text-secondary hover:text-danger-text hover:bg-bg-hover"
            title="关闭 (Esc)"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
