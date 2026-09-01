import { useCallback, useEffect, useState } from "react";
import { formatDuration } from "@/lib/recorder";
import { useAppConfig } from "@/store/config";
import type { RecordingMeta } from "@/types";
import {
  Film,
  Trash2,
  Pencil,
  FolderOpen,
  ChevronLeft,
  Terminal,
  Folder,
  FileText,
  GitBranch,
  Package,
  Box,
  Settings2,
  SquarePen,
  AlertTriangle,
  type LucideIcon,
} from "lucide-react";

interface OpLogOperation {
  index: number;
  command: string;
  output: string;
  ts: number;
  durationMs: number;
}

interface OpLog {
  app?: string;
  version?: number;
  type?: string;
  meta?: {
    hostName?: string;
    host?: string;
    username?: string;
    mode?: string;
  };
  startedAt?: string;
  durationSec?: number;
  truncated?: boolean;
  operations?: OpLogOperation[];
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SessionPlayer({ open, onClose }: Props) {
  const appTheme = useAppConfig((c) => c.theme);
  const resolvedTheme =
    appTheme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : appTheme;

  const [items, setItems] = useState<RecordingMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirPath, setDirPath] = useState<string>("");
  const [selected, setSelected] = useState<RecordingMeta | null>(null);
  const [content, setContent] = useState<string>("");

  const refresh = useCallback(async () => {
    if (!window.recordings) {
      setError("操作记录功能不可用（预加载接口缺失）");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [list, dir] = await Promise.all([
        window.recordings.list(),
        window.recordings.getDir(),
      ]);
      setItems(list);
      setDirPath(dir);
    } catch (e) {
      setError(`读取记录列表失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
    else {
      setSelected(null);
      setContent("");
    }
  }, [open, refresh]);

  const openRecording = async (item: RecordingMeta) => {
    try {
      const text = await window.recordings.read(item.id);
      setContent(text);
      setSelected(item);
    } catch (e) {
      setError(`读取记录失败：${(e as Error).message}`);
    }
  };

  const removeRecording = async (item: RecordingMeta) => {
    if (!confirm(`确定删除记录「${item.title || item.name}」吗？此操作不可恢复。`)) return;
    try {
      await window.recordings.remove(item.id);
      if (selected?.id === item.id) {
        setSelected(null);
        setContent("");
      }
      await refresh();
    } catch (e) {
      setError(`删除失败：${(e as Error).message}`);
    }
  };

  const renameRecording = async (item: RecordingMeta) => {
    const next = prompt("为这条操作记录命名：", item.title || item.name);
    if (next === null) return;
    try {
      await window.recordings.rename(item.id, next.trim() || item.name);
      await refresh();
    } catch (e) {
      setError(`重命名失败：${(e as Error).message}`);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center p-4 animate-fadeIn backdrop-blur-sm"
      style={{ backgroundColor: "var(--overlay)" }}
      onClick={onClose}
    >
      <div
        className="w-[980px] max-w-full h-[680px] max-h-full bg-modal-bg border border-border-primary rounded-lg shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-primary flex-shrink-0">
          <div className="flex items-center gap-2">
            {selected && (
              <button
                onClick={() => {
                  setSelected(null);
                  setContent("");
                }}
                className="p-1 rounded hover:bg-bg-hover text-text-secondary"
                title="返回记录库"
              >
                <ChevronLeft size={16} />
              </button>
            )}
            <Film size={16} className="text-text-link" />
            <h3 className="text-sm font-semibold">
              {selected ? `操作记录：${selected.title || selected.name}` : "操作记录库"}
            </h3>
            {!selected && <span className="text-xs text-text-secondary">({items.length})</span>}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void window.recordings.openDir()}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-border-primary text-text-secondary hover:bg-bg-hover"
              title={`记录文件目录：${dirPath}`}
            >
              <FolderOpen size={13} />
              打开目录
            </button>
            <button
              onClick={onClose}
              className="text-text-secondary hover:text-text-primary text-xl leading-none px-1"
            >
              ×
            </button>
          </div>
        </div>

        {error && (
          <div className="px-4 py-2 text-xs bg-danger-10 text-danger-text border-b border-border-primary">
            {error}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-hidden">
          {selected ? (
            <OperationViewer content={content} theme={resolvedTheme} />
          ) : (
            <LibraryView
              items={items}
              loading={loading}
              dirPath={dirPath}
              onOpen={(it) => void openRecording(it)}
              onRemove={(it) => void removeRecording(it)}
              onRename={(it) => void renameRecording(it)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function LibraryView({
  items,
  loading,
  dirPath,
  onOpen,
  onRemove,
  onRename,
}: {
  items: RecordingMeta[];
  loading: boolean;
  dirPath: string;
  onOpen: (item: RecordingMeta) => void;
  onRemove: (item: RecordingMeta) => void;
  onRename: (item: RecordingMeta) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-text-secondary">
        正在读取记录列表…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
        <Film size={40} className="opacity-40 text-text-secondary" />
        <div className="text-sm text-text-primary">还没有任何操作记录</div>
        <div className="text-xs text-text-secondary leading-relaxed">
          在终端标签栏点击「记录」开始，再次点击即可停止并保存。
          <br />
          记录以「命令 + 输出」为单位，保存为操作日志，可在此以图标时间线查看。
        </div>
        {dirPath && (
          <div className="text-[11px] text-text-tertiary mt-1 break-all">目录：{dirPath}</div>
        )}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {items.map((it) => (
        <div
          key={it.id}
          className="group flex items-center gap-3 px-4 py-2.5 border-b border-border-tertiary hover:bg-bg-tertiary transition-colors"
        >
          <button
            onClick={() => onOpen(it)}
            className="w-9 h-9 flex items-center justify-center rounded bg-bg-hover border border-border-primary text-text-link hover:border-accent flex-shrink-0"
            title="查看操作记录"
          >
            <Film size={15} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-sm truncate text-text-primary font-medium">
              {it.title || it.name}
            </div>
            <div className="text-[11px] text-text-secondary truncate">
              {new Date(it.createdAt).toLocaleString()} · {formatDuration(it.duration)} ·{" "}
              {(it.size / 1024).toFixed(0)} KB
            </div>
          </div>
          <div className="hidden group-hover:flex items-center gap-1">
            <button
              onClick={() => onRename(it)}
              className="p-1.5 rounded hover:bg-bg-active text-text-secondary hover:text-text-primary"
              title="重命名"
            >
              <Pencil size={13} />
            </button>
            <button
              onClick={() => onRemove(it)}
              className="p-1.5 rounded hover:bg-bg-active text-text-secondary hover:text-danger-text"
              title="删除"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function parseOpLog(content: string): OpLog | null {
  try {
    const data = JSON.parse(content) as OpLog;
    if (data?.type !== "operation-log" || !Array.isArray(data.operations)) return null;
    return data;
  } catch {
    return null;
  }
}

/** 根据命令特征挑选一个代表性图标 */
function opIcon(command: string): LucideIcon {
  const c = command.trim().toLowerCase();
  if (/^(git|gh)\b/.test(c)) return GitBranch;
  if (/^(npm|yarn|pnpm|bun)\b/.test(c)) return Package;
  if (/^(docker|kubectl|podman|docker-compose|compose)\b/.test(c)) return Box;
  if (/^(systemctl|service|systemd)\b/.test(c) || c.includes("service ")) return Settings2;
  if (/^(vi|vim|nano|emacs|code|subl)\b/.test(c)) return SquarePen;
  if (/^(cat|less|more|head|tail|grep|awk|sed|echo|printf|wc|sort|uniq)\b/.test(c)) return FileText;
  if (
    /^(cd|ls|ll|pwd|mkdir|rmdir|rm|mv|cp|touch|find|tree|ln|chmod|chown|stat)\b/.test(c)
  )
    return Folder;
  if (/^(ssh|scp|rsync|telnet|curl|wget|ping|netstat|ss|ip|ifconfig)\b/.test(c)) return Terminal;
  return Terminal;
}

function OperationViewer({ content, theme }: { content: string; theme: "dark" | "light" }) {
  const log = parseOpLog(content);
  const operations = log?.operations ?? [];
  const [hovered, setHovered] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);

  if (!log) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6 text-text-secondary">
        <AlertTriangle size={32} className="opacity-60 text-warning-text" />
        <div className="text-sm text-text-primary">该记录格式不支持或已损坏</div>
        <div className="text-xs">
          可能是旧版文本录制，已无法以操作记录查看。可在「打开目录」中手动查看原始文件。
        </div>
      </div>
    );
  }

  const displayIdx = pinned ?? hovered ?? (operations[0]?.index ?? null);
  const display = operations.find((o) => o.index === displayIdx) ?? null;

  const meta = log.meta ?? {};
  const modeLabel = meta.mode === "local" ? "本地终端" : meta.mode === "ssh" ? "SSH" : "—";

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 元信息头部 */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border-primary bg-bg-tertiary flex-shrink-0 text-[11px] text-text-secondary">
        {meta.hostName && <span className="text-text-primary">会话：{meta.hostName}</span>}
        {meta.host && <span>主机：{meta.host}</span>}
        {meta.username && <span>用户：{meta.username}</span>}
        <span>模式：{modeLabel}</span>
        {log.startedAt && <span>开始：{new Date(log.startedAt).toLocaleString()}</span>}
        <span>时长：{formatDuration(log.durationSec ?? 0)}</span>
        <span className="text-text-link">{operations.length} 个操作</span>
        {log.truncated && <span className="text-warning-text">已超限截断</span>}
      </div>

      {/* 图标时间线（横向滚动） */}
      <div className="relative flex-shrink-0 border-b border-border-primary bg-bg-secondary px-4 py-3">
        {operations.length === 0 ? (
          <div className="text-xs text-text-secondary">本次记录没有任何命令操作。</div>
        ) : (
          <div className="flex items-start gap-0 overflow-x-auto pb-1">
            {operations.map((op, i) => {
              const Icon = opIcon(op.command);
              const active = op.index === displayIdx;
              return (
                <div key={op.index} className="flex items-start flex-shrink-0">
                  {/* 连接线（除第一个外） */}
                  {i > 0 && (
                    <div className="w-5 self-center h-px bg-border-primary mx-0.5" />
                  )}
                  <button
                    onMouseEnter={() => setHovered(op.index)}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => setPinned((p) => (p === op.index ? null : op.index))}
                    className={`group flex flex-col items-center gap-1 px-1 rounded-lg transition-colors ${
                      active ? "bg-bg-selected" : "hover:bg-bg-hover"
                    }`}
                    title={op.command}
                  >
                    <span
                      className={`w-10 h-10 rounded-full flex items-center justify-center border transition-colors ${
                        active
                          ? "border-accent bg-accent text-white"
                          : "border-border-primary bg-bg-hover text-text-link group-hover:border-accent"
                      }`}
                    >
                      <Icon size={18} />
                    </span>
                    <span
                      className={`text-[10px] ${
                        active ? "text-text-link" : "text-text-secondary"
                      }`}
                    >
                      #{op.index}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div className="text-[10px] text-text-tertiary mt-1">
          鼠标移到图标上查看该操作的命令与输出（点击可固定）
        </div>
      </div>

      {/* 详情面板：展示当前 hover/固定 的操作 */}
      <div className="flex-1 min-h-0 overflow-auto p-4">
        {display ? (
          <div className="flex flex-col h-full min-h-0">
            <div className="text-[11px] text-text-secondary mb-1">
              命令（第 {display.index} 个操作 · 录制后 {formatDuration(display.ts / 1000)} · 耗时{" "}
              {display.durationMs}ms）
            </div>
            <pre className="mb-3 p-2 rounded bg-bg-tertiary border border-border-primary text-xs font-mono whitespace-pre-wrap break-all text-text-primary">
              {display.command}
            </pre>
            <div className="text-[11px] text-text-secondary mb-1">输出</div>
            <pre
              className={`flex-1 min-h-0 overflow-auto p-2 rounded border border-border-primary text-xs font-mono whitespace-pre-wrap break-all ${
                theme === "light" ? "bg-white text-gray-900" : "bg-terminal-bg text-text-primary"
              }`}
            >
              {display.output.trim() || "（无输出）"}
            </pre>
          </div>
        ) : (
          <div className="text-xs text-text-secondary">将鼠标移动到上方图标以查看操作详情。</div>
        )}
      </div>
    </div>
  );
}
