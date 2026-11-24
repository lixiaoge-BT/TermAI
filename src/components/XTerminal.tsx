import { useEffect, useRef, useMemo, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "xterm/css/xterm.css";
import { useTerminalStore } from "@/store/terminal";
import { useAppConfig } from "@/store/config";
import { useForwardStore } from "@/store/forward";
import { useLayoutStore } from "@/store/layout";
import { useAgentStore } from "@/store/agent";
import { emitTerminalOutput } from "@/lib/terminalBus";
import { filterAgentEchoForDisplay } from "@/lib/agentEcho";
import { installTerminalInputGuard } from "@/lib/terminalInputGuard";
import { suppressAutoFocus } from "@/lib/uiFocus";
import { isAgentHoldingInput, isStopShortcut } from "@/lib/agentInputGate";
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
  // 分屏时未聚焦的窗格，xterm 默认把光标画成空心方块（cursorInactiveStyle=outline），
  // 和聚焦窗格的竖条不一致，看起来像光标「变了」。失焦也保持竖条，视觉统一。
  term.options.cursorInactiveStyle = "bar";
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

// Xshell 风格主题（纯黑底 + 亮绿提示符 + 经典 ANSI 调色板）
// 提示符的绿色来自远端 shell 的 PS1（\033[01;32m），由 brightGreen 映射；
// 蓝色略提亮，避免纯蓝在黑底上看不清目录名。
const XSHELL_THEME = {
  background: "#000000",
  foreground: "#ffffff",
  cursor: "#00ff00",
  cursorAccent: "#000000",
  selectionBackground: "#004080",
  black: "#000000",
  red: "#ff0000",
  green: "#00ff00",
  yellow: "#ffff00",
  blue: "#5c5cff",
  magenta: "#ff00ff",
  cyan: "#00ffff",
  white: "#c0c0c0",
  brightBlack: "#808080",
  brightRed: "#ff5555",
  brightGreen: "#00ff00",
  brightYellow: "#ffff55",
  brightBlue: "#8a8aff",
  brightMagenta: "#ff55ff",
  brightCyan: "#55ffff",
  brightWhite: "#ffffff",
};

const TERM_THEMES = {
  dark: DARK_THEME,
  light: LIGHT_THEME,
  xshell: XSHELL_THEME,
} as const;

interface Props {
  sessionId: string;
  hostConfig?: HostConfig | null;
  onRequestAI?: (prompt: string) => void;
  mode?: "ssh" | "local";
  /** 本实例所属面板 id；与 layout store 的 focusedPaneId 比对，匹配时主动聚焦终端 */
  paneId?: string;
}

export function XTerminal({ sessionId, hostConfig: _hostConfig, onRequestAI, mode = "ssh", paneId }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const currentLineRef = useRef<string>("");
  // 终端内查找浮层状态（Ctrl+F 唤起）
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCase, setSearchCase] = useState(false);
  // 终端实例是否就绪（term.open 完成后置 true）。用于「面板成为焦点时主动聚焦」的 effect，
  // 避免 term 还没创建就去 focus。
  const [termReady, setTermReady] = useState(false);
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
  // AI 接管期间「键盘已暂停」提示的节流时间戳（连敲十几个键不该刷一屏提示）
  const agentInputHintAtRef = useRef(0);

  // onRequestAI 走 ref：Home 每次重渲染都会换掉这个内联回调的身份，
  // 若把它放进输入订阅 effect 的依赖，onData 会被反复 dispose + 重注册。
  const onRequestAIRef = useRef(onRequestAI);
  useEffect(() => { onRequestAIRef.current = onRequestAI; }, [onRequestAI]);

  // 命中报错关键词且开启自动分析时，唤起 AI 分析（带 20s 防抖，避免输出风暴）
  const tryAutoAnalyze = (text: string) => {
    const cfg = aiConfigRef.current;
    if (!cfg?.autoAnalyze || !cfg?.apiKey) return;
    if (!ERROR_PATTERN.test(text)) return;
    const now = Date.now();
    if (now - lastAutoAnalyzeRef.current < 20000) return;
    lastAutoAnalyzeRef.current = now;
    // 自动分析是「后台行为」：先声明别抢焦点，否则 AI 侧栏会在用户敲命令的瞬间
    // 把焦点从终端拽走 —— 之后敲的字母进不了终端、空格打进 AI 框、退格改错地方。
    suppressAutoFocus(2500);
    window.dispatchEvent(
      new CustomEvent("termai:quick-ask", {
        detail:
          "⚠️ 我终端刚刚输出了错误/异常信息。请立刻分析以上终端上下文中的报错：指出错误原因，并按优先级给出可直接执行的修复命令（高风险操作需提示确认）。",
      })
    );
  };
  // 注意：这里刻意不再订阅 session 对象。会话对象在每块终端输出时都会换引用，
  // 订阅它会让本组件跟着输出流逐块重渲染（输出风暴时主线程被占满，按键回调排队，
  // 表现为「打字要等一会儿才出来」）。输入路由需要的状态改为按键发生时实时读 store。
  const updateSession = useTerminalStore((s) => s.updateSession);
  // 当前聚焦面板 id：与 paneId 比对，决定本实例是否应持有键盘焦点
  const focusedPaneId = useLayoutStore((s) => s.focusedPaneId);
  const appendOutput = useTerminalStore((s) => s.appendOutput);
  const appendCommand = useTerminalStore((s) => s.appendCommand);
  const appTheme = useAppConfig((c) => c.theme);

  // 响应式计算当前实际主题（xshell 是独立终端配色，外壳沿用深色）
  const resolvedTheme = useMemo<"dark" | "light" | "xshell">(() => {
    if (appTheme === "system") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return appTheme;
  }, [appTheme]);

  const termTheme = TERM_THEMES[resolvedTheme];

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
    let inputGuardCleanup: (() => void) | null = null;
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
          cursorInactiveStyle: "bar",
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

        // 键盘输入加固：治「偶发打不进字 / 空格无效 / 退格改不掉」——
        // 输入法组合态卡死、React 18 根级委托干扰组合输入、写入失败无痕。
        // 详见 src/lib/terminalInputGuard.ts 顶部的原因说明。必须在 open() 之后装
        // （那时 term.textarea 才存在）；装不上也不能影响终端本身可用。
        try {
          inputGuardCleanup = installTerminalInputGuard(term);
        } catch (e) {
          console.warn("[XTerminal] 输入加固未安装（不影响终端使用）:", e);
        }

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
          setTermReady(true);
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
      setTermReady(false);
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
      inputGuardCleanup?.();
      inputGuardCleanup = null;
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
        // 若用户正聚焦在任意可输入元素（AI 助手输入框、主机表单、终端内查找框…），
        // 不要把它拽回终端：抢焦点会让用户接下来的字符打进别人的输入框，
        // 主观感受就是「终端突然打不进字」。
        const ae = document.activeElement as HTMLElement | null;
        const editable =
          !!ae &&
          (ae.tagName === "TEXTAREA" ||
            ae.tagName === "INPUT" ||
            ae.isContentEditable ||
            ae.getAttribute("role") === "textbox");
        if (editable && !ae.classList.contains("xterm-helper-textarea")) {
          return;
        }
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

  // 1.5b 面板聚焦联动：当本实例所属面板成为「当前聚焦面板」时主动聚焦终端。
  // 这覆盖了三种原先 focus 不掉的场景：
  //   - 初始加载（首个面板即 focusedPane，但 connect 之前的窗口/focus 事件未必触发）
  //   - 分屏后新面板（splitWith 把新 leaf 设为 focused，新面板的 XTerminal 需主动聚焦）
  //   - 在多个面板间切换（聚焦变了但窗口本身没有重新获焦）
  // 用户手动点击终端仍走 focusHandler，两者互补，不冲突。
  useEffect(() => {
    if (!paneId || !termReady) return;
    if (focusedPaneId !== paneId) return;
    const term = termRef.current;
    const el = containerRef.current;
    if (term && el && el.clientWidth > 0 && el.clientHeight > 0) {
      term.focus();
    }
  }, [focusedPaneId, paneId, termReady]);

  // 1.6 Ctrl+F / Cmd+F 唤起终端内查找浮层
  // 只在「焦点确实落在本终端里」时才响应：否则用户在 AI 输入框 / 主机表单里打字时
  // 按到 Ctrl+F，浮层会把焦点抢走，接着敲的字符全进查找框 —— 表现同样是
  // 「终端打不进字」。多面板时也只有持有焦点的那个实例会响应。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key !== "f" && e.key !== "F") return;
      const el = containerRef.current;
      const ae = document.activeElement;
      if (!el || !ae || !el.contains(ae)) return;
      e.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 关闭查找浮层后必须把焦点还给终端：否则键盘焦点会停在 body 或已卸载的输入框上，
  // 用户看到的是「终端打不进字」，实际是按键根本没到 xterm 的隐藏 textarea。
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    termRef.current?.focus();
  };

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
    // 本 effect 内所有延时回调统一登记，卸载时一次性清掉。
    // 之前这里是裸 setTimeout：面板关闭后定时器仍会对已 dispose 的 xterm 实例
    // 调 focus()，在控制台刷异常。cancelled 用于兜底（清理后仍被触发的情况）。
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let cancelled = false;
    const later = (fn: () => void, ms: number) => {
      const id = setTimeout(() => {
        timers.delete(id);
        if (!cancelled) fn();
      }, ms);
      timers.add(id);
    };
    const clearTimers = () => {
      cancelled = true;
      timers.forEach((id) => clearTimeout(id));
      timers.clear();
    };

    if (mode === "local") {
      if (!window.localTerminal) return;

      const unsubData = window.localTerminal.onData((sid, data) => {
        if (sid !== sessionId) return;
        // 与 SSH 分支同策略：显示侧剔除 Agent 哨兵包装，广播流保持原始
        const shown = filterAgentEchoForDisplay(sessionId, data);
        if (shown) termRef.current?.write(shown);
        // 录制：必须在 stripAnsi 之前采集原始数据，回放才能还原颜色与光标
        recordOutput(sessionId, data);
        const raw = stripAnsi(data);
        // 广播增量输出：供 Agent 模式实时捕获命令回显（不受 recentOutput 200 行裁剪影响）
        if (raw) emitTerminalOutput(sessionId, raw);
        const cleaned = shown === data ? raw : stripAnsi(shown);
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
        later(() => {
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
        clearTimers();
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
      // Agent 命令的哨兵包装行只从「显示」里剔除；广播出去的原始流必须原样，
      // execCommand 靠它收集 buffer 才能判断命令结束（详见 lib/agentEcho）。
      const shown = filterAgentEchoForDisplay(sessionId, data);
      if (shown) termRef.current?.write(shown);
      // 录制：必须在 stripAnsi 之前采集原始数据，回放才能还原颜色与光标
      recordOutput(sessionId, data);
      const raw = stripAnsi(data);
      // 广播增量输出：供 Agent 模式实时捕获命令回显（不受 recentOutput 200 行裁剪影响）
      if (raw) emitTerminalOutput(sessionId, raw);
      const cleaned = shown === data ? raw : stripAnsi(shown);
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
          later(() => {
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
          later(() => {
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
      clearTimers();
      unsubscribe?.();
      unsubscribeStatus?.();
    };
  }, [sessionId, updateSession, appendOutput, mode]);

  // 3. 处理用户输入
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    // 按键发生时实时读连接状态：既避免闭包里的快照过期（切连接瞬间的按键被
    // 送错通道），也让本 effect 不必依赖 status 反复重建 onData 订阅
    // —— 每次「销毁 + 重注册」之间都有一个按键会被丢掉的空窗。
    const liveStatus = () =>
      useTerminalStore.getState().sessions.find((x) => x.id === sessionId)?.status;

    // 写入失败必须留痕：invoke 的 Promise 原先没人接，主进程窗口未就绪时它会
    // 直接 reject —— 键按下去没反应、控制台也没提示，排查时完全看不出丢在哪一段。
    let writeWarned = false;
    const reportWriteFailure = (reason: string) => {
      if (writeWarned) return;
      writeWarned = true;
      console.warn(`[termai] 终端按键未送达：${reason}`);
    };
    const send = (pending: Promise<boolean> | undefined) => {
      if (!pending) return;
      pending
        .then((ok) => {
          if (!ok) reportWriteFailure("通道返回 false（会话或流已失效）");
        })
        .catch((e: unknown) => {
          reportWriteFailure((e as Error)?.message ?? String(e));
        });
    };

    const disposable = term.onData((data) => {
      // Agent 接管期间，这个 PTY 归引擎独占（见下方说明）：用户敲的字节会与 AI 下发的
      // 命令混进同一条 stdin 流。最坏的组合是用户敲了半行，AI 的 `cmd\r` 紧跟着写进去，
      // 拼成 `半行cmd` 一起被 shell 执行 —— 半条命令、误执行、参数被改，全都没法察觉。
      // 这里一律吞掉字节（不发 PTY），只放行 Ctrl+C 作为「停止任务」的快捷方式。
      const agentPhase = useAgentStore.getState().buckets[sessionId]?.phase;
      if (isAgentHoldingInput(agentPhase)) {
        if (isStopShortcut(data)) {
          useAgentStore.getState().stop(sessionId);
          if (!agentInputHintAtRef.current || Date.now() - agentInputHintAtRef.current > 3000) {
            agentInputHintAtRef.current = Date.now();
            term.writeln("\r\n\x1b[33m[已请求停止 AI 接管]\x1b[0m");
          }
          return;
        }
        // 提示最多 3 秒一次：用户连敲十几个键不该刷出一屏提示。
        if (!agentInputHintAtRef.current || Date.now() - agentInputHintAtRef.current > 3000) {
          agentInputHintAtRef.current = Date.now();
          term.writeln(
            "\r\n\x1b[33m[AI 接管中] 键盘输入已暂停，避免与 AI 下发的命令混在一起\x1b[0m" +
              "\r\n\x1b[2m（点 AI 面板的「停止」或按 Ctrl+C 可结束接管）\x1b[0m"
          );
        }
        return;
      }
      if (mode === "local") {
        // 本地终端模式：直接发送到本地 PTY
        if (liveStatus() === "connected") {
          send(window.localTerminal?.write(sessionId, data));
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

      if (liveStatus() !== "connected") {
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
            if (onRequestAIRef.current && line.startsWith("?")) {
              onRequestAIRef.current(line.slice(1).trim());
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
      send(window.ssh?.write(sessionId, data));
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
    // termReady 必须进依赖：终端是异步创建的（容器尺寸就绪后才 new Terminal），
    // 首次跑这个 effect 时 termRef.current 还是 null，会直接 return 跳过注册。
    // 少了它，挂载时就已 connected 的会话（切标签页 / 分屏切回来）永远不会注册
    // onData —— 表现为终端看得见但敲键盘没反应。
    // 不再依赖连接状态：状态在按键发生时实时读取，避免每次连接/断开都重建订阅
    // （重建的瞬间按下的键会直接丢）。
  }, [sessionId, appendCommand, mode, termReady]);

  // AI 接管状态：只订阅本会话的 phase（原始值，频率极低），用于顶部常驻提示。
  // 不要订阅整个 bucket —— 它每轮输出都会换引用，会让终端跟着流式输出重渲染。
  const agentPhase = useAgentStore((s) => s.buckets[sessionId]?.phase);
  const agentRunning = isAgentHoldingInput(agentPhase);

  return (
    <div
      className="relative w-full h-full bg-terminal-bg"
      onClick={() => termRef.current?.focus()}
    >
      <div
        ref={containerRef}
        className="absolute inset-0"
      />
      {/* AI 接管期间键盘被暂停（避免与下发的命令混进同一条 stdin），
          不给提示用户只会觉得「终端坏了打不进字」。这里做成常驻小条。 */}
      {agentRunning && (
        <div className="pointer-events-none absolute top-2 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-md border border-warning/40 bg-warning-10 px-2.5 py-1 text-[11px] text-warning-text shadow">
          AI 接管中 · 键盘输入已暂停（Ctrl+C 或面板「停止」可结束）
        </div>
      )}
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
                e.preventDefault();
                closeSearch();
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
            onClick={closeSearch}
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
