import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Folder,
  File as FileIcon,
  ArrowDownToLine,
  ArrowUpFromLine,
  FolderPlus,
  Trash2,
  RefreshCw,
  X,
  HardDrive,
  Home,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { useAppConfig } from "@/store/config";
import type { LocalFileInfo, RemoteFileInfo, SftpProgress, HostConfig } from "@/types";

const SFTP_SESSION = "filetransfer_sftp";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function formatTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function joinLocal(base: string, name: string): string {
  if (base.endsWith("/") || base.endsWith("\\")) return base + name;
  const sep = base.includes("\\") ? "\\" : "/";
  return base + sep + name;
}

function joinRemote(base: string, name: string): string {
  if (base === "/") return "/" + name;
  return base.replace(/\/+$/, "") + "/" + name;
}

function splitPath(path: string, isRemote: boolean): string[] {
  if (isRemote) {
    const parts = path.split("/").filter(Boolean);
    return parts.map((_, i) => "/" + parts.slice(0, i + 1).join("/"));
  }
  // 本地：Windows 盘符 C:\ 或 unix /
  if (/^[A-Za-z]:\\/.test(path)) {
    const drive = path.slice(0, 3);
    const rest = path.slice(3).split("\\").filter(Boolean);
    return [drive, ...rest.map((_, i) => drive + rest.slice(0, i + 1).join("\\"))];
  }
  const parts = path.split("/").filter(Boolean);
  return ["/", ...parts.map((_, i) => "/" + parts.slice(0, i + 1).join("/"))];
}

export function FileManager() {
  const fileTransferHostId = useAppConfig((s) => s.fileTransferHostId);
  const closeFileTransfer = useAppConfig((s) => s.closeFileTransfer);
  const getHost = useAppConfig((s) => s.getHost);
  const host: HostConfig | undefined = fileTransferHostId ? getHost(fileTransferHostId) : undefined;

  if (!fileTransferHostId || !host) return null;
  return <FileManagerInner host={host} onClose={closeFileTransfer} />;
}

function FileManagerInner({ host, onClose }: { host: HostConfig; onClose: () => void }) {
  const sftpParams = useMemo(
    () => ({
      host: host.host,
      port: typeof host.port === "string" ? parseInt(host.port, 10) || 22 : host.port ?? 22,
      username: host.username,
      password: host.authMethod === "password" ? host.password : undefined,
      privateKey: host.authMethod === "privateKey" ? host.privateKey : undefined,
      passphrase: host.passphrase,
    }),
    [host.host, host.port, host.username, host.authMethod, host.password, host.privateKey, host.passphrase]
  );

  // 本地状态
  const [localPath, setLocalPath] = useState<string>("");
  const [localFiles, setLocalFiles] = useState<LocalFileInfo[]>([]);
  const [localSel, setLocalSel] = useState<Set<string>>(new Set());
  const [localLoading, setLocalLoading] = useState(false);
  const [localRoots, setLocalRoots] = useState<string[]>([]);
  const [desktopPath, setDesktopPath] = useState<string>("");

  // 远端状态
  const [remotePath, setRemotePath] = useState<string>("/");
  const [remoteFiles, setRemoteFiles] = useState<RemoteFileInfo[]>([]);
  const [remoteSel, setRemoteSel] = useState<Set<string>>(new Set());
  const [remoteConnected, setRemoteConnected] = useState(false);
  const [remoteConnecting, setRemoteConnecting] = useState(true);
  const [remoteError, setRemoteError] = useState<string>("");

  // 传输状态
  const [transferring, setTransferring] = useState(false);
  const [progress, setProgress] = useState<SftpProgress | null>(null);
  const [transferMsg, setTransferMsg] = useState("");

  // 自定义弹窗（替代 prompt/confirm，避免 Electron 原生弹窗不显示/无反馈）
  type DialogState =
    | { open: false }
    | {
        open: true;
        type: "prompt";
        title: string;
        placeholder?: string;
        defaultValue?: string;
        onConfirm: (value: string) => void;
        onCancel: () => void;
      }
    | {
        open: true;
        type: "confirm";
        title: string;
        content?: string;
        onConfirm: () => void;
        onCancel: () => void;
      };
  const [dialog, setDialog] = useState<DialogState>({ open: false });
  const [dialogValue, setDialogValue] = useState("");

  const showPrompt = useCallback(
    (
      opts: Pick<
        Extract<DialogState, { open: true; type: "prompt" }>,
        "title" | "placeholder" | "defaultValue"
      >
    ) =>
      new Promise<string | null>((resolve) => {
        setDialogValue(opts.defaultValue || "");
        setDialog({
          open: true,
          type: "prompt",
          ...opts,
          onConfirm: (v) => {
            setDialog({ open: false });
            resolve(v);
          },
          onCancel: () => {
            setDialog({ open: false });
            resolve(null);
          },
        });
      }),
    []
  );

  const showConfirm = useCallback(
    (
      opts: Pick<
        Extract<DialogState, { open: true; type: "confirm" }>,
        "title" | "content"
      >
    ) =>
      new Promise<boolean>((resolve) => {
        setDialog({
          open: true,
          type: "confirm",
          ...opts,
          onConfirm: () => {
            setDialog({ open: false });
            resolve(true);
          },
          onCancel: () => {
            setDialog({ open: false });
            resolve(false);
          },
        });
      }),
    []
  );

  const sessionId = SFTP_SESSION;

  // 加载本地盘符 + 桌面路径 + 默认目录（优先桌面）
  useEffect(() => {
    (async () => {
      setLocalLoading(true);
      try {
        const [roots, desktop] = await Promise.all([
          window.localFs.listRoots(),
          window.localFs.getDesktopPath(),
        ]);
        setLocalRoots(roots);
        setDesktopPath(desktop);
        // 默认先打开桌面；如果桌面路径不可用，回退到第一个盘符
        let start = desktop;
        try {
          await window.localFs.listDir(start);
        } catch {
          start = roots[0] || "/";
        }
        setLocalPath(start);
        const list = await window.localFs.listDir(start);
        setLocalFiles(list);
      } catch (e) {
        console.error("local fs error", e);
      } finally {
        setLocalLoading(false);
      }
    })();
  }, []);

  const loadLocal = useCallback(async (p: string) => {
    setLocalLoading(true);
    try {
      const list = await window.localFs.listDir(p);
      setLocalFiles(list);
      setLocalPath(p);
      setLocalSel(new Set());
    } catch (e) {
      setTransferMsg(`本地读取失败：${(e as Error).message}`);
    } finally {
      setLocalLoading(false);
    }
  }, []);

  const loadRemote = useCallback(async (p: string) => {
    try {
      const list = await window.sftp.list(sessionId, p);
      setRemoteFiles(list);
      setRemotePath(p);
      setRemoteSel(new Set());
    } catch (e) {
      setTransferMsg(`远端读取失败：${(e as Error).message}`);
    }
  }, [sessionId]);

  // 连接 SFTP
  const connectRemote = useCallback(async () => {
    setRemoteConnecting(true);
    setRemoteError("");
    setRemoteConnected(false);
    console.log("[FileManager] SFTP connecting to", sftpParams.host, sftpParams.port, "as", sftpParams.username);
    try {
      // 先清理可能存在的旧连接
      try {
        await window.sftp.disconnect(sessionId);
      } catch {
        // ignore
      }
      await window.sftp.connect(sessionId, sftpParams);
      console.log("[FileManager] SFTP connected");
      const home = await window.sftp.realpath(sessionId, ".");
      console.log("[FileManager] SFTP home:", home);
      setRemoteConnected(true);
      await loadRemote(home);
    } catch (e) {
      console.error("[FileManager] SFTP connection failed:", e);
      setRemoteError(`连接失败：${(e as Error).message}`);
      setRemoteConnected(false);
    } finally {
      setRemoteConnecting(false);
    }
  }, [sessionId, sftpParams, loadRemote]);

  useEffect(() => {
    connectRemote();
    return () => {
      window.sftp.disconnect(sessionId).catch(() => {});
    };
  }, [sessionId, sftpParams, connectRemote]);

  // 监听传输进度
  useEffect(() => {
    const off = window.sftp.onProgress((_sid, data) => {
      setProgress(data);
    });
    return () => {
      off();
    };
  }, []);

  // 关闭时断开 SFTP
  useEffect(() => {
    return () => {
      window.sftp.disconnect(sessionId).catch(() => {});
    };
  }, [sessionId]);

  // ---------- 操作 ----------
  const newFolderLocal = async () => {
    setTransferMsg("请输入新建文件夹名称");
    const name = await showPrompt({ title: "新建文件夹", placeholder: "文件夹名称" });
    if (!name) {
      setTransferMsg("");
      return;
    }
    const p = joinLocal(localPath, name);
    setTransferMsg("正在创建本地文件夹...");
    try {
      await window.localFs.mkdir(p);
      setTransferMsg(`已创建：${p}`);
      await loadLocal(localPath);
    } catch (e) {
      setTransferMsg(`新建失败：${(e as Error).message}`);
    }
  };

  const newFolderRemote = async () => {
    if (!remoteConnected) {
      setTransferMsg("远端未连接，无法新建文件夹");
      return;
    }
    setTransferMsg("请输入新建文件夹名称");
    const name = await showPrompt({ title: "新建文件夹", placeholder: "文件夹名称" });
    if (!name) {
      setTransferMsg("");
      return;
    }
    const p = joinRemote(remotePath, name);
    setTransferMsg("正在创建远端文件夹...");
    try {
      await window.sftp.mkdir(sessionId, p);
      setTransferMsg(`已创建：${p}`);
      await loadRemote(remotePath);
    } catch (e) {
      setTransferMsg(`新建失败：${(e as Error).message}`);
    }
  };

  const deleteLocal = async () => {
    if (localSel.size === 0) return;
    const ok = await showConfirm({
      title: "确认删除",
      content: `确定删除选中的 ${localSel.size} 个本地项目？此操作不可恢复。`,
    });
    if (!ok) return;
    setTransferMsg("正在删除本地项目...");
    let failed = 0;
    for (const path of localSel) {
      try {
        await window.localFs.remove(path);
      } catch (e) {
        failed++;
        setTransferMsg(`删除失败：${path} — ${(e as Error).message}`);
      }
    }
    if (failed === 0) setTransferMsg(`已删除 ${localSel.size} 个本地项目`);
    await loadLocal(localPath);
  };

  const deleteRemote = async () => {
    if (remoteSel.size === 0) return;
    if (!remoteConnected) {
      setTransferMsg("远端未连接，无法删除");
      return;
    }
    const ok = await showConfirm({
      title: "确认删除",
      content: `确定删除选中的 ${remoteSel.size} 个远端项目？此操作不可恢复。`,
    });
    if (!ok) return;
    setTransferMsg("正在删除远端项目...");
    let failed = 0;
    for (const path of remoteSel) {
      const item = remoteFiles.find((f) => f.path === path);
      try {
        await window.sftp.remove(sessionId, path, !!item?.isDirectory);
      } catch (e) {
        failed++;
        setTransferMsg(`删除失败：${path} — ${(e as Error).message}`);
      }
    }
    if (failed === 0) setTransferMsg(`已删除 ${remoteSel.size} 个远端项目`);
    await loadRemote(remotePath);
  };

  const renameLocal = async () => {
    if (localSel.size !== 1) return;
    const old = Array.from(localSel)[0];
    setTransferMsg("请输入新名称");
    const name = await showPrompt({
      title: "重命名",
      defaultValue: old.split(/[\\/]/).pop() || "",
      placeholder: "新名称",
    });
    if (!name) {
      setTransferMsg("");
      return;
    }
    const np = joinLocal(localPath, name);
    setTransferMsg("正在重命名...");
    try {
      await window.localFs.rename(old, np);
      setTransferMsg(`已重命名为：${name}`);
      await loadLocal(localPath);
    } catch (e) {
      setTransferMsg(`重命名失败：${(e as Error).message}`);
    }
  };

  const renameRemote = async () => {
    if (remoteSel.size !== 1 || !remoteConnected) {
      if (!remoteConnected) setTransferMsg("远端未连接，无法重命名");
      return;
    }
    const old = Array.from(remoteSel)[0];
    setTransferMsg("请输入新名称");
    const name = await showPrompt({
      title: "重命名",
      defaultValue: old.split("/").pop() || "",
      placeholder: "新名称",
    });
    if (!name) {
      setTransferMsg("");
      return;
    }
    const np = joinRemote(remotePath, name);
    setTransferMsg("正在重命名...");
    try {
      await window.sftp.rename(sessionId, old, np);
      setTransferMsg(`已重命名为：${name}`);
      await loadRemote(remotePath);
    } catch (e) {
      setTransferMsg(`重命名失败：${(e as Error).message}`);
    }
  };

  // ---------- 传输（递归） ----------
  const downloadItem = async (item: RemoteFileInfo, destDir: string) => {
    const dest = joinLocal(destDir, item.name);
    if (item.isDirectory) {
      await window.localFs.mkdir(dest);
      const children = await window.sftp.list(sessionId, item.path);
      for (const c of children) await downloadItem(c, dest);
    } else {
      await window.sftp.download(sessionId, item.path, dest);
    }
  };

  const uploadItem = async (item: LocalFileInfo, destDir: string) => {
    const dest = joinRemote(destDir, item.name);
    if (item.isDirectory) {
      await window.sftp.mkdir(sessionId, dest);
      const children = await window.localFs.listDir(item.path);
      for (const c of children) await uploadItem(c, dest);
    } else {
      await window.sftp.upload(sessionId, item.path, dest);
    }
  };

  const doDownload = async () => {
    if (remoteSel.size === 0 || !remoteConnected || transferring) return;
    setTransferring(true);
    setTransferMsg("");
    try {
      for (const path of remoteSel) {
        const item = remoteFiles.find((f) => f.path === path);
        if (item) await downloadItem(item, localPath);
      }
      setTransferMsg(`下载完成：${remoteSel.size} 个项目 → ${localPath}`);
      await loadLocal(localPath);
    } catch (e) {
      setTransferMsg(`下载失败：${(e as Error).message}`);
    } finally {
      setTransferring(false);
      setProgress(null);
    }
  };

  const doUpload = async () => {
    if (localSel.size === 0 || !remoteConnected || transferring) return;
    setTransferring(true);
    setTransferMsg("");
    try {
      for (const path of localSel) {
        const item = localFiles.find((f) => f.path === path);
        if (item) await uploadItem(item, remotePath);
      }
      setTransferMsg(`上传完成：${localSel.size} 个项目 → ${remotePath}`);
      await loadRemote(remotePath);
    } catch (e) {
      setTransferMsg(`上传失败：${(e as Error).message}`);
    } finally {
      setTransferring(false);
      setProgress(null);
    }
  };

  const pct = progress && progress.total > 0 ? Math.floor((progress.transferred / progress.total) * 100) : 0;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center p-3 animate-fadeIn backdrop-blur-sm"
      style={{ backgroundColor: "var(--overlay)" }}
      onClick={onClose}
    >
      <div
        className="w-[96vw] h-[92vh] max-w-[1280px] bg-modal-bg border border-border-primary rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-primary flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <HardDrive size={16} className="text-text-link flex-shrink-0" />
            <span className="text-sm font-semibold truncate">文件传输</span>
            <span className="text-xs text-text-secondary truncate">
              · {host.name}（{host.username}@{host.host}）
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-bg-hover text-text-secondary"
            title="关闭"
          >
            <X size={16} />
          </button>
        </div>

        {/* 主体：双栏 */}
        <div className="flex-1 flex min-h-0">
          {/* 本地 */}
          <Pane
            title="本地"
            icon={<HardDrive size={13} />}
            path={localPath}
            isRemote={false}
            files={localFiles}
            selected={localSel}
            setSelected={setLocalSel}
            loading={localLoading}
            error=""
            roots={localRoots}
            desktopPath={desktopPath}
            onRootChange={(r) => loadLocal(r)}
            onNavigate={(p) => loadLocal(p)}
            onNewFolder={newFolderLocal}
            onDelete={deleteLocal}
            onRename={renameLocal}
            onRefresh={() => loadLocal(localPath)}
            disabledOps={transferring}
          />

          {/* 中间传输按钮 */}
          <div className="w-16 flex flex-col items-center justify-center gap-3 border-l border-r border-border-primary bg-bg-secondary flex-shrink-0">
            <button
              onClick={doDownload}
              disabled={remoteSel.size === 0 || !remoteConnected || transferring}
              className="flex flex-col items-center gap-1 px-2 py-2 rounded-lg text-xs text-white bg-success hover:bg-success-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="将选中远端文件下载到本地当前目录"
            >
              <ArrowDownToLine size={18} />
              下载
            </button>
            <button
              onClick={doUpload}
              disabled={localSel.size === 0 || !remoteConnected || transferring}
              className="flex flex-col items-center gap-1 px-2 py-2 rounded-lg text-xs text-white bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="将选中本地文件上传到远端当前目录"
            >
              <ArrowUpFromLine size={18} />
              上传
            </button>
          </div>

          {/* 远端 */}
          <Pane
            title="远程服务器"
            icon={<HardDrive size={13} />}
            path={remotePath}
            isRemote
            files={remoteFiles}
            selected={remoteSel}
            setSelected={setRemoteSel}
            loading={remoteConnecting}
            error={remoteError}
            connected={remoteConnected}
            onNavigate={(p) => loadRemote(p)}
            onNewFolder={newFolderRemote}
            onDelete={deleteRemote}
            onRename={renameRemote}
            onRefresh={() => {
              if (remoteConnected) loadRemote(remotePath);
              else connectRemote();
            }}
            disabledOps={transferring || !remoteConnected}
          />
        </div>

        {/* 底部状态 / 进度 */}
        <div className="border-t border-border-primary px-4 py-2 flex items-center gap-3 flex-shrink-0 bg-bg-tertiary">
          {transferring && progress ? (
            <>
              <Loader2 size={14} className="animate-spin text-accent flex-shrink-0" />
              <span className="text-xs text-text-primary flex-shrink-0">
                {progress.direction === "download" ? "下载中" : "上传中"} {pct}%
              </span>
              <div className="flex-1 h-1.5 rounded-full bg-bg-hover overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-xs text-text-secondary truncate max-w-[280px]">
                {progress.direction === "download" ? progress.remotePath : progress.localPath}
              </span>
            </>
          ) : (
            <span className="text-xs text-text-secondary truncate">
              {transferMsg || "提示：勾选文件后点击中间「下载/上传」按钮进行传输，双击文件夹可进入。"}
            </span>
          )}
        </div>
      </div>

      {/* 自定义输入/确认弹窗（替代 prompt/confirm） */}
      {dialog.open && (
        <div
          className="fixed inset-0 z-[1100] flex items-center justify-center p-4 animate-fadeIn"
          style={{ backgroundColor: "var(--overlay)" }}
          onClick={(e) => {
            e.stopPropagation();
            dialog.onCancel();
          }}
        >
          <div
            className="bg-modal-bg border border-border-primary rounded-lg shadow-xl w-full max-w-sm p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-text-primary mb-2">{dialog.title}</h3>
            {dialog.type === "confirm" && dialog.content ? (
              <p className="text-xs text-text-secondary mb-4">{dialog.content}</p>
            ) : null}
            {dialog.type === "prompt" ? (
              <input
                type="text"
                value={dialogValue}
                onChange={(e) => setDialogValue(e.target.value)}
                placeholder={dialog.placeholder}
                className="w-full bg-bg-secondary border border-border-primary rounded px-2 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent mb-4"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    dialog.onConfirm(dialogValue);
                  } else if (e.key === "Escape") {
                    dialog.onCancel();
                  }
                }}
              />
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => dialog.onCancel()}
                className="px-3 py-1.5 rounded text-xs text-text-secondary hover:bg-bg-hover transition-colors"
              >
                取消
              </button>
              <button
                onClick={() =>
                  dialog.type === "prompt" ? dialog.onConfirm(dialogValue) : dialog.onConfirm()
                }
                className="px-3 py-1.5 rounded text-xs text-white bg-accent hover:bg-accent-hover transition-colors"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface PaneProps {
  title: string;
  icon: React.ReactNode;
  path: string;
  isRemote: boolean;
  files: (LocalFileInfo | RemoteFileInfo)[];
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  loading: boolean;
  error: string;
  connected?: boolean;
  roots?: string[];
  desktopPath?: string;
  onRootChange?: (root: string) => void;
  onNavigate: (p: string) => void;
  onNewFolder: () => void;
  onDelete: () => void;
  onRename: () => void;
  onRefresh: () => void;
  disabledOps: boolean;
}

function Pane({
  title,
  icon,
  path,
  isRemote,
  files,
  selected,
  setSelected,
  loading,
  error,
  connected,
  roots,
  desktopPath,
  onRootChange,
  onNavigate,
  onNewFolder,
  onDelete,
  onRename,
  onRefresh,
  disabledOps,
}: PaneProps) {
  const crumbs = splitPath(path, isRemote);
  // 下拉框选项：桌面 + 各盘符
  const rootOptions = useMemo(() => {
    if (isRemote || !roots) return [];
    const opts: { label: string; value: string }[] = [];
    if (desktopPath) {
      opts.push({ label: "桌面", value: desktopPath });
    }
    roots.forEach((r) => opts.push({ label: r, value: r }));
    return opts;
  }, [isRemote, roots, desktopPath]);
  const currentRootValue = useMemo(() => {
    if (isRemote || !roots) return path;
    if (desktopPath && path === desktopPath) return desktopPath;
    return crumbs[0] ?? path;
  }, [isRemote, roots, desktopPath, path, crumbs]);

  const toggle = (p: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* 标题 + 工具栏 */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-secondary">
        <span className="text-xs font-semibold flex items-center gap-1 text-text-primary">
          {icon}
          {title}
        </span>
        {isRemote && connected === false && !loading && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-danger-bg text-danger-text">
            未连接
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={onNewFolder}
            disabled={disabledOps}
            className="p-1 rounded hover:bg-bg-hover active:bg-bg-active text-text-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-transform active:scale-95"
            title={disabledOps && isRemote && !connected ? "远端未连接" : "新建文件夹"}
          >
            <FolderPlus size={14} />
          </button>
          <button
            onClick={onRefresh}
            disabled={disabledOps}
            className="p-1 rounded hover:bg-bg-hover active:bg-bg-active text-text-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-transform active:scale-95"
            title={disabledOps && isRemote && !connected ? "远端未连接" : "刷新"}
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={onRename}
            disabled={disabledOps || selected.size !== 1}
            className="p-1 rounded hover:bg-bg-hover active:bg-bg-active text-text-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-transform active:scale-95"
            title={
              disabledOps && isRemote && !connected
                ? "远端未连接"
                : selected.size !== 1
                ? "请选中一个项目"
                : "重命名"
            }
          >
            <span className="text-xs">重命名</span>
          </button>
          <button
            onClick={onDelete}
            disabled={disabledOps || selected.size === 0}
            className="p-1 rounded hover:bg-bg-active active:bg-danger-bg text-text-secondary hover:text-danger-text disabled:opacity-40 disabled:cursor-not-allowed transition-transform active:scale-95"
            title={
              disabledOps && isRemote && !connected
                ? "远端未连接"
                : selected.size === 0
                ? "请先选中要删除的项目"
                : "删除"
            }
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* 面包屑 */}
      <div className="px-3 py-1 border-b border-border-secondary flex items-center gap-1 text-xs overflow-x-auto whitespace-nowrap">
        <button
          onClick={() => onNavigate(isRemote ? "/" : (crumbs[0] ?? path))}
          className="text-text-link hover:underline flex items-center"
          title="根目录"
        >
          <Home size={12} />
        </button>
        {!isRemote && rootOptions.length > 0 && (
          <select
            value={currentRootValue}
            onChange={(e) => onRootChange?.(e.target.value)}
            className="ml-1 bg-bg-secondary border border-border-primary rounded px-1 py-0.5 text-text-primary text-xs cursor-pointer focus:outline-none focus:border-accent"
          >
            {rootOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        )}
        {crumbs
          .filter((_, i) => !(i === 0 && !isRemote && roots && roots.length > 1))
          .map((c) => (
            <span key={c} className="flex items-center gap-1">
              <span className="text-text-tertiary">/</span>
              <button
                onClick={() => onNavigate(c)}
                className="hover:text-text-link hover:underline text-text-secondary"
              >
                {c.split(/[\\/]/).pop()}
              </button>
            </span>
          ))}
      </div>

      {/* 文件列表 */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-6 flex items-center gap-2 text-sm text-text-secondary">
            <Loader2 size={16} className="animate-spin" />
            {isRemote ? "连接中..." : "加载中..."}
          </div>
        ) : error ? (
          <div className="p-6 flex items-start gap-2 text-sm text-danger-text">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {files.map((f) => {
                const isDir = f.isDirectory;
                const isSel = selected.has(f.path);
                return (
                  <tr
                    key={f.path}
                    onClick={() => toggle(f.path)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      if (isDir) onNavigate(f.path);
                    }}
                    className={`cursor-pointer border-b border-border-secondary ${
                      isSel ? "bg-accent-20" : "hover:bg-bg-tertiary"
                    }`}
                  >
                    <td className="w-6 pl-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={() => toggle(f.path)}
                        onClick={(e) => e.stopPropagation()}
                        className="accent-[var(--accent)]"
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {isDir ? (
                          <Folder size={14} className="text-text-link flex-shrink-0" />
                        ) : (
                          <FileIcon size={14} className="text-text-secondary flex-shrink-0" />
                        )}
                        <span className={`truncate ${isDir ? "text-text-primary font-medium" : "text-text-primary"}`}>
                          {f.name}
                        </span>
                      </div>
                    </td>
                    <td className="py-1.5 pr-3 text-right text-text-secondary whitespace-nowrap w-20">
                      {isDir ? "—" : formatSize(f.size)}
                    </td>
                    <td className="py-1.5 pr-3 text-text-tertiary whitespace-nowrap w-36 hidden sm:table-cell">
                      {formatTime(f.modifyTime)}
                    </td>
                  </tr>
                );
              })}
              {files.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-text-secondary">
                    空文件夹
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
