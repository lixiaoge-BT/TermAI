import { useState, useRef, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Server,
  Plus,
  Trash2,
  Edit3,
  ChevronRight,
  ChevronDown,
  CircleDot,
  Tag,
  Folder,
  FolderPlus,
  FolderOpen,
  Search,
  KeyRound,
  ShieldCheck,
  X as XIcon,
  FolderUp,
  Network,
  Download,
  Upload,
} from "lucide-react";
import { useAppConfig } from "@/store/config";
import { useTerminalStore } from "@/store/terminal";
import type { HostConfig, SshConnectParams } from "@/types";

interface Props {
  open: boolean;
  onToggle: () => void;
  onQuickConnect?: (sessionId: string) => void;
}

interface CtxMenuState {
  x: number;
  y: number;
  host: HostConfig;
}

export function HostPanel({ open, onToggle, onQuickConnect }: Props) {
  const { hosts, hostGroups, addHost, updateHost, removeHost, addHostGroup, removeHostGroup, hostFormOpen, setHostFormOpen, openFileTransfer, openForward, exportHosts, importHosts } = useAppConfig();
  // 只订阅动作 + 「每台主机已连接会话数」映射。
  // sessions 数组在每块终端输出时都会换新引用（recentOutput 变化），
  // 全量订阅会让主机列表跟着输出流逐块重渲染；映射成计数 + useShallow
  // 后，只有连接/断开时才触发重渲染。
  const createSession = useTerminalStore((s) => s.createSession);
  const connectedCounts = useTerminalStore(
    useShallow((s) => {
      const counts: Record<string, number> = {};
      for (const sess of s.sessions) {
        if (sess.hostId && sess.connected) counts[sess.hostId] = (counts[sess.hostId] ?? 0) + 1;
      }
      return counts;
    })
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  // 当前选中的主机（单击选中，不改变连接状态）
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  // 折叠状态：已折叠的分组名集合
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // 右上角 + 菜单
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  // 新建分组对话框
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  // 拖拽放置时的视觉高亮分组
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  // 新建主机时预填的分组
  const [prefillGroup, setPrefillGroup] = useState("");
  // 待删除分组的确认弹窗（null 表示不显示）
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<string | null>(null);
  // 主机导入/导出：隐藏的文件选择器 + 结果提示
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  // 当前正在使用（被激活标签页关联）的主机 ID
  const activeHostId = useTerminalStore((s) => {
    const sess = s.sessions.find((x) => x.id === s.activeSessionId);
    return sess?.hostId ?? null;
  });

  const filtered = hosts.filter((h) =>
    !query ||
    [h.name, h.host, h.username, ...(h.tags ?? [])].some((v) =>
      (v ?? "").toLowerCase().includes(query.toLowerCase())
    )
  );

  // 按分组归类（搜索时不折叠，确保所有匹配项可见）
  const searching = query.trim().length > 0;
  const groups = useMemo(() => {
    const map = new Map<string, HostConfig[]>();
    for (const h of filtered) {
      const g = (h.group || "").trim();
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(h);
    }
    // 非搜索态下，把已创建但为空的分组也展示出来
    if (!searching) {
      for (const g of hostGroups) {
        const key = g.trim();
        if (key && !map.has(key)) map.set(key, []);
      }
    }
    // 排序：未分组放最后；其余分组按名称
    const keys = Array.from(map.keys()).sort((a, b) => {
      if (a === "" && b === "") return 0;
      if (a === "") return 1;
      if (b === "") return -1;
      return a.localeCompare(b, "zh-Hans-CN");
    });
    return keys.map((k) => ({ name: k, hosts: map.get(k)! }));
  }, [filtered, hostGroups, searching]);

  const toggleCollapse = (name: string) => {
    if (searching) return; // 搜索态下不允许折叠
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // 导出主机备份：明文 JSON 下载（含密码/密钥，仅供迁移或本机备份）
  const handleExport = () => {
    if (
      !window.confirm(
        "导出文件将以明文保存主机密码 / 私钥 / API Key，仅用于本机备份或换机迁移。导出后请妥善保管，确认继续？"
      )
    ) {
      return;
    }
    const json = exportHosts();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `termai-hosts-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // 导入主机备份：按 id 合并，已存在则更新
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许重复选择同一文件
    if (!file) return;
    try {
      const text = await file.text();
      const res = importHosts(text);
      setImportMsg(`导入完成：新增 ${res.added} 台，更新 ${res.updated} 台，分组 ${res.groups} 个`);
      setTimeout(() => setImportMsg(null), 4000);
    } catch (err) {
      setImportMsg(`导入失败：${(err as Error).message}`);
      setTimeout(() => setImportMsg(null), 5000);
    }
  };

  const doConnect = async (host: HostConfig) => {
    const session = createSession({
      hostId: host.id,
      hostName: host.name,
      host: host.host,
      username: host.username,
    });
    const params: SshConnectParams = {
      host: host.host,
      port: host.port,
      username: host.username,
      password: host.authMethod === "password" ? host.password : undefined,
      privateKey: host.authMethod === "privateKey" ? host.privateKey : undefined,
      passphrase: host.passphrase,
    };
    // 跳板机（ProxyJump）：从已配置主机里解析出跳板机的完整连接参数
    if (host.proxyJumpHostId) {
      const jump = hosts.find((h) => h.id === host.proxyJumpHostId);
      if (jump) {
        params.proxyJump = {
          host: jump.host,
          port: jump.port,
          username: jump.username,
          password: jump.authMethod === "password" ? jump.password : undefined,
          privateKey: jump.authMethod === "privateKey" ? jump.privateKey : undefined,
          passphrase: jump.passphrase,
        };
      }
    }
    const tryConnect = (attempts: number) => {
      const w = window as unknown as {
        __termai_connect?: (sid: string, p: SshConnectParams) => Promise<void>;
      };
      if (w.__termai_connect) {
        w.__termai_connect(session.id, params);
      } else if (attempts > 0) {
        setTimeout(() => tryConnect(attempts - 1), 100);
      }
    };
    setTimeout(() => tryConnect(5), 100);
    onQuickConnect?.(session.id);
  };

  // 收起时整个面板不渲染——入口按钮在 Tab 栏左端（Home.tsx），不再占用左侧竖条
  if (!open) {
    return null;
  }

  return (
    <div className="relative flex flex-col h-full bg-bg-secondary border-r border-border-primary text-text-primary w-64 min-w-64">
      {importMsg && (
        <div className="absolute top-0 left-0 right-0 z-30 px-3 py-1.5 text-xs text-center bg-accent text-white shadow">
          {importMsg}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleImportFile}
      />
      <div className="px-3 py-3 border-b border-border-primary flex items-center justify-between">
        {/* 点击标题区域即可收起面板（替代原收起小图标按钮） */}
        <button
          onClick={onToggle}
          className="flex items-center gap-2 rounded px-1 -mx-1 py-0.5 hover:bg-bg-hover text-text-primary transition-colors"
          title="收起主机列表"
        >
          <Server size={16} className="text-text-link" />
          <span className="text-sm font-semibold">主机列表</span>
          <span className="text-xs text-text-secondary">({hosts.length})</span>
        </button>
        <div className="flex items-center gap-1">
          <div className="relative">
            <button
              onClick={() => setPlusMenuOpen((v) => !v)}
              className="p-1.5 rounded hover:bg-bg-hover text-text-link"
              title="新建"
            >
              <Plus size={16} />
            </button>
            {plusMenuOpen && (
              <PlusMenu
                onClose={() => setPlusMenuOpen(false)}
                onNewHost={() => {
                  setPlusMenuOpen(false);
                  setPrefillGroup("");
                  setEditingId(null);
                  setHostFormOpen(true);
                }}
                onNewGroup={() => {
                  setPlusMenuOpen(false);
                  setNewGroupName("");
                  setNewGroupOpen(true);
                }}
              />
            )}
          </div>
          <button
            onClick={handleExport}
            className="p-1.5 rounded hover:bg-bg-hover text-text-secondary"
            title="导出主机（JSON，含凭据明文，仅供迁移/备份）"
          >
            <Download size={16} />
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-1.5 rounded hover:bg-bg-hover text-text-secondary"
            title="导入主机备份"
          >
            <Upload size={16} />
          </button>
        </div>
      </div>

      <div className="p-2 border-b border-border-primary">
        <div className="flex items-center gap-1.5 bg-bg-tertiary border border-border-primary rounded px-2 py-1.5">
          <Search size={14} className="text-text-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索主机..."
            className="bg-transparent flex-1 outline-none text-xs placeholder:text-text-tertiary"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="text-text-secondary hover:text-text-primary"
              title="清除搜索"
            >
              <XIcon size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="p-4 text-center text-xs text-text-secondary">
            {hosts.length === 0 ? (
              <>
                <FolderOpen size={32} className="mx-auto mb-2 opacity-40" />
                还没有保存的主机
                <br />
                点击右上角 + 添加
              </>
            ) : (
              "没有匹配的主机"
            )}
          </div>
        )}
        {groups.map((g) => {
          const isCollapsed = !searching && collapsed.has(g.name);
          return (
            <div key={g.name || "__ungrouped__"}>
              <div
                className={`flex items-center gap-1.5 px-2 py-1.5 border-b border-border-primary cursor-pointer select-none sticky top-0 z-10 transition-colors ${
                  dragOverGroup === g.name
                    ? "bg-accent-20 border-accent"
                    : "bg-bg-tertiary border-border-primary"
                }`}
                onClick={() => toggleCollapse(g.name)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverGroup(g.name);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setDragOverGroup((cur) => (cur === g.name ? null : cur));
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const hostId = e.dataTransfer.getData("text/plain");
                  if (hostId) {
                    const host = hosts.find((h) => h.id === hostId);
                    if (host && (host.group || "") !== g.name) {
                      updateHost(hostId, { group: g.name || undefined });
                    }
                  }
                  setDragOverGroup(null);
                }}
                title={searching ? "搜索时自动展开" : (isCollapsed ? "展开分组" : "折叠分组")}
              >
                {searching || !isCollapsed ? (
                  <ChevronDown size={13} className="text-text-secondary flex-shrink-0" />
                ) : (
                  <ChevronRight size={13} className="text-text-secondary flex-shrink-0" />
                )}
                {g.name ? (
                  <Folder size={13} className="text-text-link flex-shrink-0" />
                ) : (
                  <FolderOpen size={13} className="text-text-tertiary flex-shrink-0" />
                )}
                <span className="text-xs font-semibold text-text-primary truncate flex-1">
                  {g.name || "未分组"}
                </span>
                <span className="text-[10px] text-text-secondary px-1 rounded-full bg-bg-hover">
                  {g.hosts.length}
                </span>
                {g.name && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteGroup(g.name);
                    }}
                    className="p-0.5 rounded hover:bg-bg-active text-text-tertiary hover:text-danger-text"
                    title="删除分组"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
              {!isCollapsed &&
                g.hosts.map((h) => (
                  <HostItem
                    key={h.id}
                    host={h}
                    isActive={h.id === activeHostId}
                    selected={h.id === selectedHostId}
                    activeSessionsCount={connectedCounts[h.id] ?? 0}
                    onSelect={() => setSelectedHostId(h.id)}
                    onConnect={() => doConnect(h)}
                    onEdit={() => {
                      setEditingId(h.id);
                      setHostFormOpen(true);
                    }}
                    onDelete={() => {
                      if (confirm(`确定删除主机「${h.name}」吗？`)) removeHost(h.id);
                    }}
                    onContextMenu={(e: React.MouseEvent) => {
                      e.preventDefault();
                      setCtxMenu({ x: e.clientX, y: e.clientY, host: h });
                    }}
                    onFileTransfer={() => {
                      setCtxMenu(null);
                      openFileTransfer(h.id);
                    }}
                    onForward={() => {
                      setCtxMenu(null);
                      openForward(h.id);
                    }}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", h.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                  />
                ))}
            </div>
          );
        })}
      </div>

      {ctxMenu && (
        <HostContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          onConnect={() => {
            setCtxMenu(null);
            doConnect(ctxMenu.host);
          }}
          onEdit={() => {
            setCtxMenu(null);
            setEditingId(ctxMenu.host.id);
            setHostFormOpen(true);
          }}
          onDelete={() => {
            setCtxMenu(null);
            if (confirm(`确定删除主机「${ctxMenu.host.name}」吗？`)) removeHost(ctxMenu.host.id);
          }}
          onFileTransfer={() => {
            setCtxMenu(null);
            openFileTransfer(ctxMenu.host.id);
          }}
          onForward={() => {
            setCtxMenu(null);
            openForward(ctxMenu.host.id);
          }}
        />
      )}

      {hostFormOpen && (
        <HostFormModal
          initial={editingId ? hosts.find((x) => x.id === editingId) ?? null : null}
          prefillGroup={prefillGroup}
          allGroups={Array.from(new Set([...hostGroups, ...hosts.map((h) => (h.group || "").trim())].filter(Boolean)))}
          onClose={() => {
            setHostFormOpen(false);
            setPrefillGroup("");
          }}
          onSave={(data) => {
            if (editingId) {
              updateHost(editingId, data);
            } else {
              addHost(data);
            }
            setHostFormOpen(false);
            setPrefillGroup("");
          }}
        />
      )}

      {newGroupOpen && (
        <NewGroupModal
          value={newGroupName}
          onChange={setNewGroupName}
          onClose={() => setNewGroupOpen(false)}
          onConfirm={() => {
            const name = newGroupName.trim();
            if (!name) {
              alert("请输入分组名称");
              return;
            }
            addHostGroup(name);
            setNewGroupOpen(false);
            setNewGroupName("");
          }}
        />
      )}

      {confirmDeleteGroup !== null && (
        <div
          className="fixed inset-0 z-[1003] flex items-center justify-center p-4 animate-fadeIn backdrop-blur-sm"
          style={{ backgroundColor: "var(--overlay)" }}
          onClick={() => setConfirmDeleteGroup(null)}
        >
          <div
            className="w-[340px] max-w-full bg-modal-bg border border-border-primary rounded-lg shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-primary">
              <h3 className="text-sm font-semibold">删除分组</h3>
              <button
                onClick={() => setConfirmDeleteGroup(null)}
                className="text-text-secondary hover:text-text-primary text-xl leading-none"
              >
                ×
              </button>
            </div>
            <div className="p-4 text-xs text-text-secondary leading-relaxed">
              确定删除分组「
              <span className="text-text-primary font-medium">{confirmDeleteGroup}</span>
              」吗？
              {(() => {
                const grp = groups.find((g) => g.name === confirmDeleteGroup);
                return grp && grp.hosts.length > 0 ? (
                  <div className="mt-2 text-danger-text">
                    该分组下的 {grp.hosts.length} 台主机会移入「未分组」，不会被删除。
                  </div>
                ) : null;
              })()}
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-border-primary bg-bg-tertiary">
              <button
                onClick={() => setConfirmDeleteGroup(null)}
                className="px-3 py-1.5 text-xs rounded border border-border-primary hover:bg-bg-hover"
              >
                取消
              </button>
              <button
                onClick={() => {
                  removeHostGroup(confirmDeleteGroup);
                  setConfirmDeleteGroup(null);
                }}
                className="px-3 py-1.5 text-xs rounded bg-danger hover:bg-danger-hover text-white"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function HostItem({
  host,
  isActive,
  selected,
  activeSessionsCount,
  onSelect,
  onConnect,
  onEdit,
  onDelete,
  onContextMenu,
  onFileTransfer: _onFileTransfer,
  onForward,
  onDragStart,
}: {
  host: HostConfig;
  isActive: boolean;
  selected: boolean;
  activeSessionsCount:  number;
  onSelect: () => void;
  onConnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onFileTransfer: () => void;
  onForward: () => void;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onClick={onSelect}
      onDoubleClick={onConnect}
      className={`group px-2 py-1.5 border-b border-border-tertiary cursor-grab active:cursor-grabbing ${
        isActive ? "bg-accent-20" : selected ? "bg-bg-hover" : "hover:bg-bg-tertiary"
      }`}
      style={
        isActive
          ? { borderLeft: "3px solid var(--accent)" }
          : selected
          ? { borderLeft: "3px solid var(--border-primary)" }
          : undefined
      }
      onContextMenu={onContextMenu}
      title="单击选中，双击连接；拖拽到分组上可移动主机"
    >
      <div className="flex items-center gap-2">
        <div className="flex-1 flex items-center gap-2 text-left min-w-0">
          <div className="w-7 h-7 flex items-center justify-center rounded bg-bg-hover border border-border-primary flex-shrink-0">
            <Server size={14} className="text-text-link" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span
                className="text-sm truncate"
                style={isActive ? { color: "var(--accent)", fontWeight: 700 } : undefined}
              >
                {host.name}
              </span>
              {activeSessionsCount > 0 && (
                <span className="inline-flex items-center gap-0.5 text-[10px] px-1 rounded-full bg-success-10 text-success-text">
                  <CircleDot size={10} />
                  {activeSessionsCount}
                </span>
              )}
              {host.tags?.slice(0, 2).map((t) => (
                <span key={t} className="text-[10px] px-1 rounded bg-accent-20 text-text-link">
                  {t}
                </span>
              ))}
              {isActive && (
                <span className="text-[10px] px-1 rounded bg-accent text-white">使用中</span>
              )}
            </div>
            <div className="text-xs text-text-secondary truncate">
              {host.username}@{host.host}:{host.port}
            </div>
          </div>
        </div>
        <div className="hidden group-hover:flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onForward();
            }}
            className="p-1 rounded hover:bg-bg-active text-text-secondary hover:text-text-link"
            title="端口转发"
          >
            <Network size={13} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className="p-1 rounded hover:bg-bg-active text-text-secondary hover:text-text-primary"
            title="编辑"
          >
            <Edit3 size={13} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="p-1 rounded hover:bg-bg-active text-text-secondary hover:text-danger-text"
            title="删除"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

function HostContextMenu({
  x,
  y,
  onClose,
  onConnect,
  onEdit,
  onDelete,
  onFileTransfer,
  onForward,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onConnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onFileTransfer: () => void;
  onForward: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);

  const items: { label: string; icon: React.ReactNode; onClick: () => void; danger?: boolean }[] = [
    { label: "文件传输", icon: <FolderUp size={13} />, onClick: onFileTransfer },
    { label: "端口转发", icon: <Network size={13} />, onClick: onForward },
    { label: "连接", icon: <Server size={13} />, onClick: onConnect },
    { label: "编辑", icon: <Edit3 size={13} />, onClick: onEdit },
    { label: "删除", icon: <Trash2 size={13} />, onClick: onDelete, danger: true },
  ];

  return (
    <div
      ref={menuRef}
      className="fixed z-[1001] w-40 border border-border-primary bg-dropdown-bg rounded-lg shadow-2xl py-1"
      style={{ top: y, left: x, backdropFilter: "blur(8px)" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) => (
        <button
          key={it.label}
          onClick={it.onClick}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors hover:bg-bg-selected ${
            it.danger ? "text-danger-text hover:text-danger-text" : "text-text-primary"
          }`}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  );
}

// 导出：Home.tsx 在主机列表收起时也要能渲染此弹窗
// （SplitView「添加新主机」只置全局 hostFormOpen，而本面板收起时整棵不渲染）
export function HostFormModal({
  initial,
  prefillGroup,
  allGroups,
  onClose,
  onSave,
}: {
  initial: HostConfig | null;
  prefillGroup?: string;
  allGroups: string[];
  onClose: () => void;
  onSave: (data: Omit<HostConfig, "id" | "createdAt" | "updatedAt">) => void;
}) {
  const [form, setForm] = useState({
    name: initial?.name ?? "",
    host: initial?.host ?? "",
    port: initial?.port ?? 22,
    username: initial?.username ?? "root",
    authMethod: initial?.authMethod ?? "password",
    password: initial?.password ?? "",
    privateKey: initial?.privateKey ?? "",
    passphrase: initial?.passphrase ?? "",
    group: initial?.group ?? prefillGroup ?? "",
    tags: initial?.tags ?? [],
    proxyJumpHostId: initial?.proxyJumpHostId ?? "",
  });
  const [tagInput, setTagInput] = useState("");
  // 其它主机列表（作为跳板机候选，排除自身，避免链式/自引用）
  const allHosts = useAppConfig((s) => s.hosts);
  const jumpCandidates = allHosts.filter((h) => h.id !== initial?.id);

  const submit = () => {
    if (!form.name.trim() || !form.host.trim() || !form.username.trim()) {
      alert("请填写名称、主机地址、用户名");
      return;
    }
    onSave({ ...form, port: Number(form.port) || 22 });
  };

  return (
    <div
      className="fixed inset-0 z-[999] flex items-center justify-center p-4 animate-fadeIn backdrop-blur-sm"
      style={{ backgroundColor: "var(--overlay)" }}
      onClick={onClose}
    >
      <div
        className="w-[460px] max-w-full bg-modal-bg border border-border-primary rounded-lg shadow-2xl flex flex-col max-h-[86vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-primary flex-shrink-0">
          <h3 className="text-sm font-semibold">
            {initial ? "编辑主机" : "添加 SSH 主机"}
          </h3>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto flex-1 min-h-0">
          <Field label="连接名称">
            <input
              className={inputCls}
              placeholder="如：生产服务器、测试机 MySQL"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="主机" className="col-span-2">
              <input
                className={inputCls}
                placeholder="192.168.1.100 或 example.com"
                value={form.host}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
              />
            </Field>
            <Field label="端口">
              <input
                className={inputCls}
                type="number"
                value={form.port}
                onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
              />
            </Field>
          </div>
          <Field label="用户名">
            <input
              className={inputCls}
              placeholder="root"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </Field>
          <Field label="认证方式">
            <div className="flex gap-2">
              {(["password", "privateKey"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setForm({ ...form, authMethod: m })}
                  className={`flex-1 text-xs py-2 rounded border ${
                    form.authMethod === m
                      ? "bg-accent-20 border-accent text-accent-text"
                      : "bg-bg-secondary border-border-primary text-text-secondary"
                  }`}
                >
                  {m === "password" ? (
                    <span className="inline-flex items-center gap-1.5 justify-center"><ShieldCheck size={14}/>密码</span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 justify-center"><KeyRound size={14}/>私钥</span>
                  )}
                </button>
              ))}
            </div>
          </Field>
          {form.authMethod === "password" && (
            <Field label="密码">
              <input
                type="password"
                className={inputCls}
                placeholder="输入 SSH 登录密码"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </Field>
          )}
          {form.authMethod === "privateKey" && (
            <>
              <Field label="私钥内容（PEM 格式）">
                <textarea
                  rows={6}
                  className={inputCls + " font-mono text-xs"}
                  placeholder="粘贴 -----BEGIN RSA PRIVATE KEY----- ... -----END RSA PRIVATE KEY-----"
                  value={form.privateKey}
                  onChange={(e) => setForm({ ...form, privateKey: e.target.value })}
                />
              </Field>
              <Field label="私钥口令（如无则留空）">
                <input
                  type="password"
                  className={inputCls}
                  value={form.passphrase}
                  onChange={(e) => setForm({ ...form, passphrase: e.target.value })}
                />
              </Field>
            </>
          )}
          <Field label="跳板机 / ProxyJump（可选）">
            <div className="relative">
              <select
                className={inputCls + " appearance-none pr-7 cursor-pointer"}
                value={form.proxyJumpHostId}
                onChange={(e) => setForm({ ...form, proxyJumpHostId: e.target.value })}
              >
                <option value="">不使用跳板机（直连）</option>
                {jumpCandidates.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}（{h.username}@{h.host}:{h.port}）
                  </option>
                ))}
              </select>
              <ChevronDown
                size={14}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none"
              />
            </div>
            <div className="text-[11px] text-text-tertiary mt-1">
              选中后，连接将先建立到跳板机，再经跳板机内部转发到本主机（多跳内网场景）。
            </div>
          </Field>
          <Field label="分组（可选）">
            <div className="relative">
              <select
                className={inputCls + " appearance-none pr-7 cursor-pointer"}
                value={allGroups.includes(form.group) ? form.group : "__new__"}
                onChange={(e) => {
                  if (e.target.value === "__new__") {
                    setForm({ ...form, group: "" });
                  } else {
                    setForm({ ...form, group: e.target.value });
                  }
                }}
              >
                <option value="">未分组</option>
                {allGroups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
                <option value="__new__">+ 新建分组…</option>
              </select>
              <ChevronDown
                size={14}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none"
              />
              {(!allGroups.includes(form.group)) && (
                <input
                  autoFocus
                  className={inputCls + " mt-1.5"}
                  placeholder="输入新分组名，如：生产、测试、数据库"
                  value={form.group}
                  onChange={(e) => setForm({ ...form, group: e.target.value })}
                />
              )}
            </div>
          </Field>
          <Field label="标签（回车添加，可用生产标签触发额外安全确认）">
            <div className="flex flex-wrap gap-1 mb-1.5">
              {form.tags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-accent-20 text-accent-text"
                >
                  <Tag size={10} />
                  {t}
                  <button
                    onClick={() =>
                      setForm({ ...form, tags: form.tags.filter((x) => x !== t) })
                    }
                    className="hover:text-text-primary"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <input
              className={inputCls}
              placeholder="输入后回车，如：生产 / mysql / web"
              value={tagInput}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const v = tagInput.trim();
                  if (v && !form.tags.includes(v)) {
                    setForm({ ...form, tags: [...form.tags, v] });
                  }
                  setTagInput("");
                }
              }}
              onChange={(e) => setTagInput(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border-primary flex-shrink-0 bg-bg-tertiary">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded border border-border-primary hover:bg-bg-hover"
          >
            取消
          </button>
          <button
            onClick={submit}
            className="px-3 py-1.5 text-xs rounded bg-success hover:bg-success-hover text-white flex items-center gap-1.5"
          >
            <ChevronRight size={14} />
            {initial ? "保存修改" : "保存并连接"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PlusMenu({
  onClose,
  onNewHost,
  onNewGroup,
}: {
  onClose: () => void;
  onNewHost: () => void;
  onNewGroup: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);

  const items = [
    { label: "新建主机", icon: <Server size={13} />, onClick: onNewHost },
    { label: "新建分组", icon: <FolderPlus size={13} />, onClick: onNewGroup },
  ];

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 w-32 border border-border-primary bg-dropdown-bg rounded-lg shadow-2xl py-1 z-50"
      style={{ backdropFilter: "blur(8px)" }}
    >
      {items.map((it) => (
        <button
          key={it.label}
          onClick={it.onClick}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left text-text-primary transition-colors hover:bg-bg-selected"
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  );
}

function NewGroupModal({
  value,
  onChange,
  onClose,
  onConfirm,
}: {
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[1002] flex items-center justify-center p-4 animate-fadeIn backdrop-blur-sm"
      style={{ backgroundColor: "var(--overlay)" }}
      onClick={onClose}
    >
      <div
        className="w-[360px] max-w-full bg-modal-bg border border-border-primary rounded-lg shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-primary">
          <h3 className="text-sm font-semibold">新建分组</h3>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-4">
          <Field label="分组名称">
            <input
              autoFocus
              className={inputCls}
              placeholder="如：生产、测试、数据库"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onConfirm();
                if (e.key === "Escape") onClose();
              }}
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border-primary bg-bg-tertiary">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded border border-border-primary hover:bg-bg-hover"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs rounded bg-success hover:bg-success-hover text-white"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full bg-bg-secondary border border-border-primary rounded px-2.5 py-1.5 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent placeholder:text-text-tertiary";

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <div className="text-xs text-text-secondary mb-1">{label}</div>
      {children}
    </label>
  );
}