import { useEffect, useMemo, useRef, useState } from "react";
import { XTerminal } from "@/components/XTerminal";
import { useLayoutStore } from "@/store/layout";
import { useTerminalStore } from "@/store/terminal";
import { useAppConfig } from "@/store/config";
import { computeLayout, type Rect, type SplitDirection } from "@/lib/splitLayout";
import { Columns2, Rows2, X as XIcon, LayoutGrid, Server, Plus } from "lucide-react";

// 每个面板顶部标题条的高度（px）。终端区域 = 面板矩形减去这个高度。
const HEADER_H = 28;

interface Props {
  /** 终端里输入 ?问题 时上抛给 Home 处理 */
  onRequestAI: (prompt: string) => void;
  /** 请求分屏：由 Home 决定新面板放哪个会话 */
  onSplit: (paneId: string, direction: SplitDirection) => void;
}

/**
 * 分屏视图
 * -------------------------------------------------------------
 * 关键设计：所有会话的 XTerminal 始终挂载在同一个容器里（不卸载），
 * 只是用绝对定位把它们摆到各自面板的矩形中；没被展示的会话保持
 * display:none。这样切分屏 / 换会话都不会重挂载 XTerminal，
 * SSH 连接与 PTY 不会中断（卸载再挂载会重建终端、丢回显）。
 * 面板尺寸变化由 XTerminal 内部的 ResizeObserver 自动 fit + 同步 PTY。
 */
export function SplitView({ onRequestAI, onSplit }: Props) {
  const sessions = useTerminalStore((s) => s.sessions);
  const getHost = useAppConfig((c) => c.getHost);
  const hostConfigs = useAppConfig((c) => c.hosts);
  const setHostFormOpen = useAppConfig((c) => c.setHostFormOpen);

  const root = useLayoutStore((s) => s.root);
  const focusedPaneId = useLayoutStore((s) => s.focusedPaneId);
  const focusPane = useLayoutStore((s) => s.focusPane);
  const closePaneById = useLayoutStore((s) => s.closePaneById);
  const setPaneSessionById = useLayoutStore((s) => s.setPaneSessionById);
  const setSplitRatio = useLayoutStore((s) => s.setSplitRatio);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{
    splitId: string;
    direction: SplitDirection;
    parent: Rect;
  } | null>(null);

  const layout = useMemo(() => computeLayout(root), [root]);

  /** sessionId -> 所在面板与矩形 */
  const cellBySession = useMemo(() => {
    const m = new Map<string, { paneId: string; rect: Rect }>();
    for (const leaf of layout.leaves) {
      if (leaf.sessionId) m.set(leaf.sessionId, { paneId: leaf.paneId, rect: leaf.rect });
    }
    return m;
  }, [layout]);

  const onlyOnePane = layout.leaves.length <= 1;

  // 拖拽分隔条调整比例
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      let ratio: number;
      if (drag.direction === "row") {
        const px = (e.clientX - box.left) / box.width;
        ratio = (px - drag.parent.x) / drag.parent.w;
      } else {
        const py = (e.clientY - box.top) / box.height;
        ratio = (py - drag.parent.y) / drag.parent.h;
      }
      setSplitRatio(drag.splitId, ratio);
    };
    const onUp = () => setDrag(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, setSplitRatio]);

  /** 给面板指派会话；若该会话已在别的面板展示则两者互换 */
  const assignSession = (paneId: string, sessionId: string) => {
    const holder = layout.leaves.find(
      (l) => l.sessionId === sessionId && l.paneId !== paneId
    );
    const current = layout.leaves.find((l) => l.paneId === paneId)?.sessionId ?? null;
    setPaneSessionById(paneId, sessionId);
    if (holder) setPaneSessionById(holder.paneId, current);
  };

  return (
    <div
      ref={containerRef}
      className={`relative flex-1 min-h-0 bg-terminal-bg ${drag ? "select-none" : ""}`}
    >
      {/* 1) 终端实例层：全部常驻挂载，按面板矩形定位 */}
      {sessions.map((s) => {
        const cell = cellBySession.get(s.id);
        const hostConfig = s.hostId ? getHost(s.hostId) ?? null : null;
        return (
          <div
            key={s.id}
            className="absolute overflow-hidden"
            style={
              cell
                ? {
                    left: `${cell.rect.x * 100}%`,
                    top: `calc(${cell.rect.y * 100}% + ${HEADER_H}px)`,
                    width: `${cell.rect.w * 100}%`,
                    height: `calc(${cell.rect.h * 100}% - ${HEADER_H}px)`,
                    display: "block",
                  }
                : { display: "none" }
            }
            onMouseDown={() => {
              if (cell) focusPane(cell.paneId);
            }}
          >
            <XTerminal
              sessionId={s.id}
              hostConfig={hostConfig}
              mode={s.host === "local" ? "local" : "ssh"}
              onRequestAI={onRequestAI}
            />
          </div>
        );
      })}

      {/* 1.5) 未连接/空面板的占位覆盖层：必须不透明，防止底层 XTerminal 内容穿帮 */}
      {layout.leaves.map((leaf) => {
        const session = leaf.sessionId
          ? sessions.find((s) => s.id === leaf.sessionId)
          : undefined;
        if (session?.connected) return null;
        // connecting / error 状态下必须露出终端本体：否则「正在连接...」或
        // 「连接失败：xxx」会被不透明遮罩盖住，用户只看到空面板而误以为连不上。
        if (session && (session.status === "connecting" || session.status === "error"))
          return null;
        return (
          <div
            key={`empty-${leaf.paneId}`}
            className="absolute inset-0 flex items-center justify-center bg-terminal-bg"
            style={{
              left: `${leaf.rect.x * 100}%`,
              top: `calc(${leaf.rect.y * 100}% + ${HEADER_H}px)`,
              width: `${leaf.rect.w * 100}%`,
              height: `calc(${leaf.rect.h * 100}% - ${HEADER_H}px)`,
              zIndex: 4,
            }}
          >
            <EmptyPanePrompt
              paneId={leaf.paneId}
              hostConfigs={hostConfigs}
              onQuickCreate={() => setHostFormOpen(true)}
            />
          </div>
        );
      })}

      {/* 2) 面板标题条 */}
      {layout.leaves.map((leaf) => {
        const isFocused = leaf.paneId === focusedPaneId;
        const session = leaf.sessionId
          ? sessions.find((s) => s.id === leaf.sessionId)
          : undefined;
        return (
          <div
            key={leaf.paneId}
            onMouseDown={() => focusPane(leaf.paneId)}
            className={`absolute flex items-center gap-1.5 px-2 border-b border-border-primary transition-all opacity-0 hover:opacity-100 ${
              isFocused ? "bg-bg-active" : "bg-bg-secondary"
            }`}
            style={{
              left: `${leaf.rect.x * 100}%`,
              top: `${leaf.rect.y * 100}%`,
              width: `${leaf.rect.w * 100}%`,
              height: HEADER_H,
              boxShadow: isFocused ? "inset 0 -2px 0 var(--accent)" : undefined,
              zIndex: 3,
            }}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                session?.status === "connected"
                  ? "bg-success-text"
                  : session?.status === "connecting"
                  ? "bg-warning-text animate-pulse"
                  : session?.status === "error"
                  ? "bg-danger-text"
                  : "bg-text-tertiary"
              }`}
            />
            {/* 切换该面板展示的会话 */}
            <select
              value={leaf.sessionId ?? ""}
              onChange={(e) => {
                if (e.target.value) assignSession(leaf.paneId, e.target.value);
              }}
              className="min-w-0 flex-1 bg-transparent outline-none text-[11px] truncate cursor-pointer text-text-primary"
              title="选择本面板显示的会话"
            >
              <option value="" disabled>
                （未选择会话）
              </option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.hostName}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-0.5 flex-shrink-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSplit(leaf.paneId, "row");
                }}
                className="p-1 rounded hover:bg-bg-hover text-text-secondary hover:text-text-link"
                title="左右分屏"
              >
                <Columns2 size={12} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSplit(leaf.paneId, "column");
                }}
                className="p-1 rounded hover:bg-bg-hover text-text-secondary hover:text-text-link"
                title="上下分屏"
              >
                <Rows2 size={12} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closePaneById(leaf.paneId);
                }}
                disabled={onlyOnePane}
                className="p-1 rounded hover:bg-bg-hover text-text-secondary hover:text-danger-text disabled:opacity-30 disabled:cursor-not-allowed"
                title={onlyOnePane ? "至少保留一个面板" : "关闭面板"}
              >
                <XIcon size={12} />
              </button>
            </div>
          </div>
        );
      })}

      {/* 2.5) 多面板时给每个面板加淡色边框，强化边界感但不过分突兀 */}
      {layout.leaves.length > 1 &&
        layout.leaves.map((leaf) => (
          <div
            key={`border-${leaf.paneId}`}
            className="absolute pointer-events-none border border-[var(--border-secondary)]"
            style={{
              left: `${leaf.rect.x * 100}%`,
              top: `${leaf.rect.y * 100}%`,
              width: `${leaf.rect.w * 100}%`,
              height: `${leaf.rect.h * 100}%`,
              zIndex: 5,
            }}
          />
        ))}

      {/* 3) 可拖拽分隔条：中心一条细淡的分割线，hover/拖拽时才高亮 */}
      {layout.dividers.map((d) => (
        <div
          key={d.splitId}
          onMouseDown={(e) => {
            e.preventDefault();
            setDrag({ splitId: d.splitId, direction: d.direction, parent: d.parent });
          }}
          className={`absolute z-[6] flex items-center justify-center ${
            d.direction === "row" ? "cursor-col-resize" : "cursor-row-resize"
          }`}
          style={
            d.direction === "row"
              ? {
                  left: `${(d.parent.x + d.at * d.parent.w) * 100}%`,
                  top: `${d.parent.y * 100}%`,
                  height: `${d.parent.h * 100}%`,
                  width: 10,
                  transform: "translateX(-50%)",
                }
              : {
                  top: `${(d.parent.y + d.at * d.parent.h) * 100}%`,
                  left: `${d.parent.x * 100}%`,
                  width: `${d.parent.w * 100}%`,
                  height: 10,
                  transform: "translateY(-50%)",
                }
          }
          title="拖拽调整分屏比例"
        >
          <div
            className={`rounded-full transition-colors ${
              d.direction === "row" ? "w-[2px] h-full" : "h-[2px] w-full"
            } ${
              drag?.splitId === d.splitId
                ? "bg-accent"
                : "bg-[var(--border-primary)] hover:bg-accent"
            }`}
          />
        </div>
      ))}
    </div>
  );
}

function EmptyPanePrompt({
  paneId,
  hostConfigs,
  onQuickCreate,
}: {
  paneId: string;
  hostConfigs: ReturnType<typeof useAppConfig.getState>["hosts"];
  onQuickCreate: () => void;
}) {
  const getHost = useAppConfig((c) => c.getHost);
  const createSession = useTerminalStore((s) => s.createSession);
  const setActiveSession = useTerminalStore((s) => s.setActiveSession);
  const focusPane = useLayoutStore((s) => s.focusPane);

  const quickConnect = (hostId: string) => {
    const host = getHost(hostId);
    if (!host) return;
    const sess = createSession({
      hostId: host.id,
      hostName: host.name,
      host: host.host,
      username: host.username,
    });
    setActiveSession(sess.id);
    useLayoutStore.getState().setPaneSessionById(paneId, sess.id);
    focusPane(paneId);
    setTimeout(() => {
      const w = window as unknown as {
        __termai_connect?: (sid: string, p: unknown) => Promise<void>;
      };
      w.__termai_connect?.(sess.id, {
        host: host.host,
        port: host.port,
        username: host.username,
        password: host.authMethod === "password" ? host.password : undefined,
        privateKey: host.authMethod === "privateKey" ? host.privateKey : undefined,
        passphrase: host.passphrase,
      });
    }, 50);
  };

  return (
    <div className="max-w-md w-full p-6 text-center">
      <div
        className="w-14 h-14 mx-auto mb-3 rounded-2xl border border-border-primary flex items-center justify-center"
        style={{ background: "linear-gradient(135deg, var(--bg-selected), rgba(163,113,247,0.2))" }}
      >
        <LayoutGrid size={24} className="text-text-link" />
      </div>
      <h2 className="text-base font-semibold mb-1 text-text-primary">还未连接主机</h2>
      <p className="text-xs mb-4 leading-relaxed text-text-secondary">
        从左侧主机列表选择一台主机并点击连接，或在终端输入{" "}
        <code className="px-1 rounded bg-bg-hover">?你的问题</code> 直接问 AI。
      </p>

      {hostConfigs.length > 0 && (
        <div className="mb-4">
          <div className="text-[11px] mb-2 text-text-secondary">快速连接最近主机</div>
          <div className="grid grid-cols-2 gap-2 text-left">
            {hostConfigs.slice(0, 4).map((h) => (
              <button
                key={h.id}
                onClick={() => quickConnect(h.id)}
                className="flex items-center gap-2 p-2 rounded-lg border border-border-primary bg-bg-secondary text-left transition-colors hover:border-accent hover:bg-bg-tertiary"
              >
                <div className="w-8 h-8 rounded flex items-center justify-center bg-bg-hover">
                  <Server size={14} className="text-text-link" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs truncate text-text-primary">{h.name}</div>
                  <div className="text-[10px] truncate text-text-secondary">
                    {h.username}@{h.host}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={onQuickCreate}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm rounded-lg text-white bg-success hover:bg-success-hover transition-colors"
      >
        <Plus size={16} />
        {hostConfigs.length === 0 ? "添加第一台 SSH 主机" : "添加新主机"}
      </button>
    </div>
  );
}
