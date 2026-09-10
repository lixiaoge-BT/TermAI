import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { TerminalSessionState } from "@/types";
import { HostPanel, HostFormModal } from "@/components/HostPanel";
import { SplitView } from "@/components/SplitView";
import { useLayoutStore } from "@/store/layout";
import { computeLayout, createLeaf, findLeaf, listLeaves, type SplitDirection } from "@/lib/splitLayout";
import { AISidebar } from "@/components/AISidebar";
import { FileManager } from "@/components/FileManager";
import { ForwardManager } from "@/components/ForwardManager";
import { SessionPlayer } from "@/components/SessionPlayer";
import { useTerminalStore } from "@/store/terminal";
import { useAppConfig } from "@/store/config";
import { useChatStore, currentChatKey } from "@/store/chat";
import { useAgentStore } from "@/store/agent";
import { startRecording, isRecording, getElapsed, formatDuration, serializeOperations, stopAllRecordings } from "@/lib/recorder";
import { Plus, X, LogOut, Server, Sparkles, Terminal as TermIcon, ChevronRight, Moon, Sun, Monitor, Circle, Film, Columns2, Rows2, Square } from "lucide-react";

/**
 * Tab 栏 / 顶栏 / 状态栏真正需要的会话「轻量视图」。
 * terminal store 的 sessions 数组在每块终端输出时都会因 recentOutput 变化换新引用，
 * 直接订阅会让整个 Home（Tab 栏、SplitView、AI 侧栏）跟着输出流逐块重渲染。
 * 这里映射成轻量对象 + useShallow 浅比较：输出流不再触发重渲染，
 * 只有标签上可见的字段（状态/连接/命令数）变化才重渲染。
 * WeakMap 缓存保证「未变化的 session 对象 → 同一个 lite 引用」，浅比较才能命中。
 */
interface SessionLite {
  id: string;
  hostId?: string;
  hostName: string;
  host: string;
  username: string;
  connected: boolean;
  status: TerminalSessionState["status"];
  errorMsg?: string;
  startTime?: number;
  historyLen: number;
}

const sessionLiteCache = new WeakMap<TerminalSessionState, SessionLite>();
const toSessionLite = (s: TerminalSessionState): SessionLite => {
  let lite = sessionLiteCache.get(s);
  if (!lite) {
    lite = {
      id: s.id,
      hostId: s.hostId,
      hostName: s.hostName,
      host: s.host,
      username: s.username,
      connected: s.connected,
      status: s.status,
      errorMsg: s.errorMsg,
      startTime: s.startTime,
      historyLen: s.history.length,
    };
    sessionLiteCache.set(s, lite);
  }
  return lite;
};

export default function Home() {
  const sessions = useTerminalStore(useShallow((s) => s.sessions.map(toSessionLite)));
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const createSession = useTerminalStore((s) => s.createSession);
  const removeSession = useTerminalStore((s) => s.removeSession);
  const setActiveSession = useTerminalStore((s) => s.setActiveSession);
  const getHost = useAppConfig((c) => c.getHost);
  const setTheme = useAppConfig((c) => c.setTheme);
  const currentTheme = useAppConfig((c) => c.theme);
  // 「添加新主机」弹窗的全局兜底（渲染在下方 FileManager 旁）：
  // 主机列表收起时 HostPanel 整棵不渲染，SplitView 的 hostFormOpen 没人消费
  const hostFormOpenG = useAppConfig((c) => c.hostFormOpen);
  const setHostFormOpenG = useAppConfig((c) => c.setHostFormOpen);
  const hostGroupsG = useAppConfig((c) => c.hostGroups);
  const hostsG = useAppConfig((c) => c.hosts);
  const addHostG = useAppConfig((c) => c.addHost);
  const [aiOpen, setAiOpen] = useState(true);
  const [hostPanelOpen, setHostPanelOpen] = useState(true);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [recElapsed, setRecElapsed] = useState(0);
  // 录制总开关：开启后「跟随当前聚焦面板」录制，停止时保存所有录制中的会话
  const [recordingOn, setRecordingOn] = useState(false);

  // 终端里输入 ?问题 上抛的处理。必须保持引用稳定：XTerminal 的输入订阅 effect
  // 依赖它，身份一变就会 dispose + 重新注册 onData（原本逐块输出都会触发一次）。
  const handleRequestAI = useCallback((p: string) => {
    setAiOpen(true);
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("termai:quick-ask", { detail: p }));
    }, 50);
  }, []);

  // 确保至少有一个会话 Tab
  useEffect(() => {
    if (sessions.length === 0) {
      createSession({
        hostName: "本地终端",
        host: "local",
        username: "n/a",
      });
    }
  }, [sessions.length, createSession]);

  // ---- 分屏：布局树与终端会话的联动 ----
  const layoutRoot = useLayoutStore((s) => s.root);
  const focusedPaneId = useLayoutStore((s) => s.focusedPaneId);
  const paneCount = useMemo(() => listLeaves(layoutRoot).length, [layoutRoot]);

  // 1) 聚焦面板变化时，把「激活会话」同步为该面板展示的会话
  //    （AI 侧栏、状态栏、快捷命令、录制等都依赖 activeSessionId）
  useEffect(() => {
    const leaf = focusedPaneId ? findLeaf(layoutRoot, focusedPaneId) : null;
    if (leaf?.sessionId) setActiveSession(leaf.sessionId);
  }, [layoutRoot, focusedPaneId, setActiveSession]);

  // 2) 保证布局里至少展示一个会话（首屏、或标签被删空之后）
  useEffect(() => {
    const st = useTerminalStore.getState();
    if (st.sessions.length === 0) return;
    const leaves = computeLayout(useLayoutStore.getState().root).leaves;
    const anyVisible = leaves.some(
      (l) => l.sessionId && st.sessions.some((s) => s.id === l.sessionId)
    );
    if (!anyVisible) useLayoutStore.getState().ensureVisible(st.sessions[0].id);
  }, [sessions.length]);

  // 3) 分屏：只对「已连接」的主机进行分屏，绝不创建新窗口/空面板。
  //    新面板优先展示「已连接且尚未被任何面板展示」的会话；
  //    没有可用候选时直接提示并取消分屏。
  const handleSplit = (paneId: string, direction: SplitDirection) => {
    const layout = useLayoutStore.getState();
    const target =
      (paneId && findLeaf(layout.root, paneId)
        ? paneId
        : computeLayout(layout.root).leaves[0]?.paneId) ?? "";
    if (!target) return;

    // 目标面板必须是已连接状态才允许分屏
    const targetSessionId = findLeaf(layout.root, target)?.sessionId;
    const targetSession = useTerminalStore
      .getState()
      .sessions.find((s) => s.id === targetSessionId);
    if (!targetSession || targetSession.status !== "connected") {
      flashToast("请先在当前面板连接主机，再执行分屏");
      return;
    }

    const shown = new Set(
      computeLayout(layout.root)
        .leaves.map((l) => l.sessionId)
        .filter((x): x is string => !!x)
    );
    // 只复用「已连接且尚未展示」的真实会话，不再创建空面板/新标签
    const candidate = useTerminalStore
      .getState()
      .sessions.find((s) => !shown.has(s.id) && s.status === "connected");
    if (candidate) {
      layout.splitWith(target, direction, createLeaf(candidate.id));
    } else {
      flashToast("没有其他已连接的主机可供分屏");
    }
  };

  const active = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];

  // 当前聚焦面板所展示的会话（录制跟随它）
  const focusedLeaf = focusedPaneId ? findLeaf(layoutRoot, focusedPaneId) : null;
  const focusedSessionId = focusedLeaf?.sessionId ?? null;

  const newTab = () => {
    const s = createSession({
      hostName: `新标签 ${sessions.length + 1}`,
      host: "new",
      username: "—",
    });
    // 新建的标签放进当前聚焦面板展示
    useLayoutStore.getState().ensureVisible(s.id);
  };

  const closeTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (sessions.length <= 1) {
      alert("至少保留一个标签页");
      return;
    }
    const s = sessions.find((x) => x.id === id);
    // 释放该会话的后端进程，避免子进程泄漏：
    // - 本地终端：销毁 PTY 子进程（否则关标签会留下孤立 shell 一直堆积）
    // - SSH：断开连接（connected 时先确认）
    if (s?.host === "local") {
      void window.localTerminal?.dispose(id);
    } else {
      if (s?.connected && !confirm("该标签页已连接 SSH，确定断开并关闭？")) return;
      void window.ssh?.disconnect(id);
    }
    // 标签页关闭：中断该会话上正在跑的 Agent 任务并释放会话级数据
    useAgentStore.getState().dispose(id);
    useChatStore.getState().removeBucket(id);
    removeSession(id);
    // 清理分屏布局：面板里已失效的会话用剩余的第一个会话顶替
    const remaining = useTerminalStore.getState().sessions.map((s) => s.id);
    useLayoutStore.getState().pruneSessions(remaining, remaining[0] ?? null);
  };

  const disconnectActive = async () => {
    if (!active) return;
    if (active.connected) {
      await window.ssh?.disconnect(active.id);
    }
  };

  // 会话录制：跟随「当前聚焦面板」开关；停止时保存所有录制中的会话
  const recording = recordingOn;

  useEffect(() => {
    if (!recordingOn || !focusedSessionId) return;
    const timer = window.setInterval(
      () => setRecElapsed(getElapsed(focusedSessionId)),
      1000
    );
    return () => window.clearInterval(timer);
  }, [recordingOn, focusedSessionId]);

  // 录制期间：聚焦面板切换时，确保新聚焦的会话也处于录制中。
  // 这样在分屏里录 A 面板、又切到 B 面板输入，两边的命令都会被记录，
  // 彻底避免「录制绑定的会话 ≠ 实际输入命令的会话」导致记录为空。
  useEffect(() => {
    if (!recordingOn || !focusedSessionId) return;
    if (!isRecording(focusedSessionId)) {
      const fs = sessions.find((s) => s.id === focusedSessionId);
      startRecording(focusedSessionId, {
        meta: {
          hostName: fs?.hostName,
          host: fs?.host,
          username: fs?.username,
          mode: fs?.host === "local" ? "local" : "ssh",
        },
      });
    }
  }, [recordingOn, focusedSessionId, sessions]);

  const flashToast = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((cur) => (cur === text ? null : cur)), 3200);
  };

  const toggleRecording = async () => {
    if (!focusedSessionId) {
      flashToast("请先聚焦一个终端面板再开始记录");
      return;
    }

    // 已在记录 → 停止并保存所有录制中的会话
    if (recordingOn) {
      const all = stopAllRecordings();
      setRecordingOn(false);
      setRecElapsed(0);
      let totalOps = 0;
      let savedCount = 0;
      let maxDuration = 0;
      for (const rec of all) {
        if (rec.operations.length === 0) continue; // 跳过空白记录
        try {
          const content = serializeOperations(rec);
          const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
          const name = `${rec.meta.hostName ?? rec.meta.host ?? "会话"} ${stamp}`;
          const saved = await window.recordings.save({
            name,
            content,
            duration: rec.duration,
          });
          totalOps += rec.operations.length;
          maxDuration = Math.max(maxDuration, saved.duration);
          savedCount++;
        } catch (e) {
          flashToast(`保存记录失败：${(e as Error).message}`);
        }
      }
      if (savedCount === 0) {
        flashToast("本次记录没有任何命令，已丢弃");
      } else {
        flashToast(
          `操作记录已保存 · ${formatDuration(maxDuration)} · ${totalOps} 个操作 · ${savedCount} 个会话${
            all.some((r) => r.truncated) ? " · 已超限截断" : ""
          }`
        );
      }
      return;
    }

    // 开始记录：录制当前聚焦面板所在会话（并随焦点切换自动跟进）
    const fs = sessions.find((s) => s.id === focusedSessionId);
    startRecording(focusedSessionId, {
      meta: {
        hostName: fs?.hostName,
        host: fs?.host,
        username: fs?.username,
        mode: fs?.host === "local" ? "local" : "ssh",
      },
    });
    setRecordingOn(true);
    setRecElapsed(0);
    flashToast("开始记录，再次点击「记录」结束并保存");
  };

  return (
    <div className="w-screen h-screen flex flex-col overflow-hidden bg-bg-primary text-text-primary">
      {/* 顶栏：全局菜单 */}
      <div
        className="relative z-50 h-9 border-b border-border-primary bg-bg-tertiary text-text-primary flex items-center px-2 gap-2 text-xs flex-shrink-0 select-none"
      >
        <TermAIMenu
          onNewWindow={() => window.termAI?.openNewWindow()}
          onNewTab={newTab}
          currentTheme={currentTheme}
          onThemeChange={setTheme}
          recording={recording}
          recElapsed={recElapsed}
          onToggleRecording={() => void toggleRecording()}
          onOpenPlayer={() => setPlayerOpen(true)}
        />
          <div className="ml-auto flex items-center gap-2 pr-2">
          <span className="text-[11px] text-text-secondary">
            {sessions.length} 个标签 · {sessions.filter(s => s.connected).length} 个连接
          </span>
          <button
            onClick={() => setAiOpen((v) => !v)}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border transition-colors ${
              aiOpen
                ? "border-accent bg-bg-selected text-text-link"
                : "border-border-primary text-text-secondary hover:bg-bg-hover"
            }`}
            title="显示/隐藏 AI 侧边栏"
          >
            <Sparkles size={12} />
            AI 助手
          </button>
        </div>
      </div>

      {/* 主体 3 栏 */}
      <div className="flex-1 flex min-h-0 relative">
        {/* 左：主机面板 */}
        <HostPanel
          open={hostPanelOpen}
          onToggle={() => setHostPanelOpen((v) => !v)}
          onQuickConnect={(sid) => {
            // 双击主机连接：把新建的会话放进「当前聚焦面板」显示，
            // 而不是留在隐藏面板（否则 SSH 输出不可见，且后续分屏会把它当成
            // 候选会话拉出来，造成「点横屏又新建窗口」的错觉）。不新建面板/窗口。
            useLayoutStore.getState().ensureVisible(sid);
            setActiveSession(sid);
          }}
        />

        {/* 中：终端区 + Tab */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Tab 栏 */}
          <div
            className="h-9 border-b border-border-primary bg-bg-secondary flex items-center overflow-x-auto flex-shrink-0"
          >
            {/* 主机列表开关：只在面板收起时显示（展开时「主机列表」标题本身可点击收起，
                再放一个开关就重复了——用户反馈后删去展开态的重复入口） */}
            {!hostPanelOpen && (
              <button
                onClick={() => setHostPanelOpen(true)}
                className="h-full px-3 border-r border-border-primary flex items-center flex-shrink-0 transition-colors text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                title="展开主机列表"
              >
                <Server size={15} />
              </button>
            )}
            {sessions.map((s) => {
              const host = s.hostId ? getHost(s.hostId) : null;
              const isActive = s.id === active?.id;
              return (
                <div
                  key={s.id}
                  onClick={() => {
                    setActiveSession(s.id);
                    // 该标签若没在任何面板中展示，就放进当前聚焦面板
                    useLayoutStore.getState().ensureVisible(s.id);
                  }}
                  className={`group h-full flex items-center gap-2 px-3 border-r border-border-primary cursor-pointer max-w-[220px] transition-colors ${
                    isActive
                      ? "bg-bg-active text-text-primary font-semibold shadow-[inset_0_2px_4px_rgba(0,0,0,0.06)]"
                      : "bg-transparent text-text-secondary hover:bg-bg-tertiary"
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      s.status === "connected" ? "bg-success-text"
                      : s.status === "connecting" ? "bg-warning-text animate-pulse"
                      : s.status === "error" ? "bg-danger-text"
                      : "bg-text-tertiary"
                    }`}
                  />
                  <Server size={12} className="text-text-link flex-shrink-0" />
                  <span className="text-xs truncate">
                    {s.hostName}
                    {host?.tags?.some((t) => /生产|prod|线上/i.test(t)) && (
                      <span className="ml-1 text-[9px] text-danger-text">PROD</span>
                    )}
                  </span>
                  <button
                    onClick={(e) => closeTab(s.id, e)}
                    className="opacity-0 group-hover:opacity-100 rounded p-0.5 transition-colors hover:bg-bg-active"
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
            <button
              onClick={newTab}
              className="h-full px-2 flex items-center gap-1 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
              title="新建标签页"
            >
              <Plus size={14} />
              新建
            </button>
            {/* 分屏按钮：左右/上下分屏。从 tab 栏直接发起，
                对当前聚焦面板分屏（SplitView 内部会回退到第一个面板）。
                不再在每个面板标题条上重复放分屏入口 —— 见 SplitView。 */}
            <div className="flex items-center gap-0.5 ml-1 pl-1 border-l border-border-primary h-6">
              <button
                onClick={() => handleSplit(focusedPaneId ?? "", "row")}
                className="h-full px-1.5 flex items-center text-text-secondary hover:bg-bg-tertiary rounded transition-colors"
                title="左右分屏（按当前聚焦面板）"
              >
                <Columns2 size={14} />
              </button>
              <button
                onClick={() => handleSplit(focusedPaneId ?? "", "column")}
                className="h-full px-1.5 flex items-center text-text-secondary hover:bg-bg-tertiary rounded transition-colors"
                title="上下分屏（按当前聚焦面板）"
              >
                <Rows2 size={14} />
              </button>
              <button
                onClick={() => useLayoutStore.getState().mergeToSinglePane(focusedPaneId ?? undefined)}
                disabled={paneCount <= 1}
                className="h-full px-1.5 flex items-center text-text-secondary hover:bg-bg-tertiary rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                title={paneCount <= 1 ? "当前只有一个面板" : "取消分屏（合并为单一面板，保留当前聚焦）"}
              >
                <Square size={14} />
              </button>
            </div>
            {active?.connected && (
              <div className="ml-auto pr-2">
                <button
                  onClick={disconnectActive}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border-primary text-text-secondary hover:border-danger/50 hover:text-danger-text hover:bg-danger/10 transition-colors"
                >
                  <LogOut size={11} />
                  断开连接
                </button>
              </div>
            )}
          </div>

          {/* 终端区：分屏布局。所有终端常驻挂载、按面板矩形定位，
              切换/分屏都不重挂载 XTerminal，SSH 与 PTY 不会中断。 */}
          <div className="flex-1 relative min-h-0 bg-terminal-bg flex flex-col">
            <SplitView onRequestAI={handleRequestAI} />
          </div>
        </div>

        {/* 右：AI 侧边栏 */}
        <AISidebar open={aiOpen} onToggle={() => setAiOpen((v) => !v)} />
      </div>

      <FileManager />
      <ForwardManager />

      {/* 主机表单弹窗兜底：仅主机列表收起时渲染（展开时由 HostPanel 内部渲染，
          承载「编辑主机」流；这里 initial 恒为 null，只服务 SplitView「添加新主机」） */}
      {!hostPanelOpen && hostFormOpenG && (
        <HostFormModal
          initial={null}
          allGroups={Array.from(
            new Set(
              [...hostGroupsG, ...hostsG.map((h) => (h.group || "").trim())].filter(Boolean)
            )
          )}
          onClose={() => setHostFormOpenG(false)}
          onSave={(data) => {
            addHostG(data);
            setHostFormOpenG(false);
          }}
        />
      )}

      {/* 底栏状态 */}
      <StatusBar session={active} />

      {/* 监听 termai:quick-ask，自动发送 */}
      <QuickAskBridge />

      {/* 会话录制库 / 回放 */}
      <SessionPlayer open={playerOpen} onClose={() => setPlayerOpen(false)} />

      {toast && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[1100] px-4 py-2 rounded-lg bg-accent text-white text-xs shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}

function TermAIMenu({
  onNewWindow,
  onNewTab,
  currentTheme,
  onThemeChange,
  recording,
  recElapsed,
  onToggleRecording,
  onOpenPlayer,
}: {
  onNewWindow: () => void;
  onNewTab: () => void;
  currentTheme: "dark" | "light" | "system";
  onThemeChange: (theme: "dark" | "light" | "system") => void;
  recording: boolean;
  recElapsed: number;
  onToggleRecording: () => void;
  onOpenPlayer: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [opsOpen, setOpsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setThemeOpen(false);
        setOpsOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const themeItems = [
    { key: "dark", label: "深色模式", icon: Moon },
    { key: "light", label: "浅色模式", icon: Sun },
    { key: "system", label: "跟随系统", icon: Monitor },
  ] as const;

  return (
    <div ref={containerRef} className="relative h-full flex items-center">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 px-2 py-1 rounded text-[12px] transition-colors text-text-primary ${open ? "bg-bg-active" : ""} hover:bg-bg-active`}
      >
        <div className="w-5 h-5 rounded flex items-center justify-center" style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-hover))" }}>
          <TermIcon size={12} className="text-white" />
        </div>
        <span className="font-semibold text-sm text-text-primary">TermAI</span>
      </button>
      {open && (
        <div
          className="absolute left-0 top-full mt-0 w-44 z-[200] border border-border-primary bg-dropdown-bg rounded-lg shadow-xl py-1"
          style={{ backdropFilter: "blur(8px)" }}
        >
          <button
            onClick={() => {
              onNewWindow();
              setOpen(false);
            }}
            className="block w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-bg-selected hover:text-text-link transition-colors"
          >
            新建窗口
          </button>
          <button
            onClick={() => {
              onNewTab();
              setOpen(false);
            }}
            className="block w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-bg-selected hover:text-text-link transition-colors"
          >
            新建标签页
          </button>
          <div
            className="relative"
            onMouseEnter={() => setThemeOpen(true)}
            onMouseLeave={() => setThemeOpen(false)}
          >
            <button className="flex items-center justify-between w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-bg-selected hover:text-text-link transition-colors">
              <span>主题功能</span>
              <ChevronRight size={12} className="text-text-tertiary" />
            </button>
            {themeOpen && (
              <div
                className="absolute left-full top-0 ml-0.5 w-36 z-[201] border border-border-primary bg-dropdown-bg rounded-lg shadow-xl py-1"
                style={{ backdropFilter: "blur(8px)" }}
              >
                {themeItems.map((it) => (
                  <button
                    key={it.key}
                    onClick={() => {
                      onThemeChange(it.key);
                      setThemeOpen(false);
                      setOpen(false);
                    }}
                    className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs transition-colors ${
                      currentTheme === it.key
                        ? "text-text-link bg-bg-selected"
                        : "text-text-primary hover:bg-bg-selected hover:text-text-link"
                    }`}
                  >
                    <it.icon size={12} />
                    {it.label}
                    {currentTheme === it.key && <span className="ml-auto">●</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div
            className="relative"
            onMouseEnter={() => setOpsOpen(true)}
            onMouseLeave={() => setOpsOpen(false)}
          >
            <button className="flex items-center justify-between w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-bg-selected hover:text-text-link transition-colors">
              <span>操作</span>
              <ChevronRight size={12} className="text-text-tertiary" />
            </button>
            {opsOpen && (
              <div
                className="absolute left-full top-0 ml-0.5 w-40 z-[201] border border-border-primary bg-dropdown-bg rounded-lg shadow-xl py-1"
                style={{ backdropFilter: "blur(8px)" }}
              >
                <button
                  onClick={() => {
                    onToggleRecording();
                    setOpsOpen(false);
                    setOpen(false);
                  }}
                  className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs transition-colors ${
                    recording
                      ? "text-danger-text bg-danger/10"
                      : "text-text-primary hover:bg-bg-selected hover:text-text-link"
                  }`}
                  title={recording ? "停止并保存操作记录" : "记录当前会话操作"}
                >
                  <Circle size={12} fill={recording ? "currentColor" : "none"} />
                  {recording ? `停止记录 ${formatDuration(recElapsed)}` : "记录"}
                </button>
                <button
                  onClick={() => {
                    onOpenPlayer();
                    setOpsOpen(false);
                    setOpen(false);
                  }}
                  className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-bg-selected hover:text-text-link transition-colors"
                  title="打开操作记录库"
                >
                  <Film size={12} />
                  操作记录
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBar({
  session,
}: {
  session: SessionLite | undefined;
}) {
  // 只统计当前终端会话的对话条数（各会话互相独立）
  const msgCount = useChatStore((s) =>
    session ? (s.buckets[session.id]?.messages.length ?? 0) : 0
  );
  // 渲染优化后 Home 不再随终端输出流重渲染，「连接时长」是渲染时算的，
  // 没人触发就会冻结。这里在已连接期间自己每秒跳一次（局部状态，只重渲染状态栏）。
  const [, tickNow] = useState(0);
  useEffect(() => {
    if (session?.status !== "connected" || !session?.startTime) return;
    const timer = window.setInterval(() => tickNow((v) => v + 1), 1000);
    return () => window.clearInterval(timer);
  }, [session?.status, session?.startTime]);
  return (
    <div
      className="h-6 border-t border-border-primary bg-bg-tertiary text-text-secondary flex items-center px-3 gap-4 text-[10px] flex-shrink-0 overflow-hidden"
    >
      <span className="flex items-center gap-1.5">
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            session?.status === "connected" ? "bg-success-text"
            : session?.status === "connecting" ? "bg-warning-text"
            : "bg-text-tertiary"
          }`}
        />
        {session?.status === "connected" ? "已连接" : session?.status === "connecting" ? "连接中..." : "未连接"}
      </span>
      <span className="truncate">主机: {session?.host ?? "-"}</span>
      <span className="truncate">用户: {session?.username ?? "-"}</span>
      {session?.startTime && (
        <span className="truncate">连接时长: {formatDurationMs(Date.now() - session.startTime)}</span>
      )}
      {session?.status === "error" && session.errorMsg && (
        <span className="truncate text-danger-text">错误: {session.errorMsg}</span>
      )}
      <div className="ml-auto flex items-center gap-4 overflow-hidden">
        <span className="truncate">终端命令历史: {session?.historyLen ?? 0}</span>
        <span className="truncate">AI 对话: {msgCount} 条</span>
        <span className="text-text-link truncate">TermAI v0.1.0</span>
      </div>
    </div>
  );
}

function formatDurationMs(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

// 处理快捷问 AI 的事件桥（全局唯一监听）
// 对话归属到「事件发生时处于激活状态的终端会话」，因此终端里输入 ?问题 时，
// 回答会进入当前标签页的独立对话里。
function QuickAskBridge() {
  useEffect(() => {
    const listener = async (e: Event) => {
      const q = (e as CustomEvent<string>).detail;
      if (!q) return;

      const chat = useChatStore.getState();
      const session = useTerminalStore.getState().getActiveSession();
      const key = currentChatKey(session?.id);
      const aiConfig = useAppConfig.getState().aiConfig;
      const hostConfig = session?.hostId ? useAppConfig.getState().getHost(session.hostId) : null;

      if (!aiConfig.apiKey) {
        chat.setError(key, "请先在 AI 侧栏配置 API Key");
        return;
      }
      chat.setError(key, null);
      const { chatCompletion } = await import("@/services/ai");
      chat.addMessage(key, { role: "user", content: q });
      // 确保 AI 侧边栏切回问答模式，用户看得到这次提问的回答
      window.dispatchEvent(new CustomEvent("termai:ai-mode", { detail: "chat" }));
      chat.setLoading(key, true);
      try {
        const r = await chatCompletion({
          config: aiConfig,
          userMessage: q,
          chatHistory: useChatStore.getState().buckets[key]?.messages ?? [],
          terminalCtx: session,
          hostConfig,
        });
        chat.addMessage(key, { role: "assistant", content: r.content, commands: r.commands });
      } catch (err) {
        chat.addMessage(key, { role: "assistant", content: `❌ 失败：${(err as Error).message}` });
      } finally {
        chat.setLoading(key, false);
      }
    };
    window.addEventListener("termai:quick-ask", listener);
    return () => window.removeEventListener("termai:quick-ask", listener);
  }, []);

  return null;
}
