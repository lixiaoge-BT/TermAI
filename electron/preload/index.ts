import { contextBridge, ipcRenderer, clipboard } from "electron";

export type SshConnectParams = {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  // 前端 xterm 的真实尺寸。建 shell 时就带上，否则远端 PTY 停留在默认 80x24，
  // 长命令换行与历史命令重绘会整体错位。
  cols?: number;
  rows?: number;
  // 跳板机（ProxyJump）：先连到 jump，再从 jump 内部转发到目标 host:port。
  // 用于「本机 → 跳板机 → 内网目标」的多跳场景。
  proxyJump?: SshProxyJumpConfig;
};

/** 跳板机连接配置（由前端从已有主机解析后传入，含完整认证信息） */
export type SshProxyJumpConfig = {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
};

export type SshSessionInfo = {
  id: string;
  host: string;
  username: string;
  connected: boolean;
  startTime: number;
};

export type RemoteFileInfo = {
  name: string;
  path: string;
  type: "file" | "directory" | "link" | "other";
  size: number;
  modifyTime: number;
  isDirectory: boolean;
};

export type LocalFileInfo = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifyTime: number;
};

export type SftpProgress = {
  sessionId: string;
  transferred: number;
  total: number;
  direction: "download" | "upload";
  remotePath: string;
  localPath: string;
};

export type SshForwardType = "local" | "remote" | "dynamic";

// 创建转发时的参数（与主进程 SshForwardSpec 对应）
export type SshForwardSpec = {
  id?: string;
  type: SshForwardType;
  localAddress?: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
};

export type SshForwardStatus = {
  id: string;
  type: SshForwardType;
  localAddress?: string;
  localPort?: number;
  remoteAddress?: string;
  remotePort?: number;
  bindAddress?: string;
  bindPort?: number;
  listening: boolean;
  error?: string;
};

/**
 * 外部唤起（堡垒机 / 自定义协议 / 命令行参数）的连接参数。
 * 主进程解析后通过 jump:connect 事件推送到渲染层，渲染层自动建标签 + 连 SSH。
 */
export type JumpSource =
  | "argv"               // 首次启动从 process.argv 解析
  | "second-instance"    // 二次启动，second-instance 事件拿到第二个 argv
  | "open-url"           // macOS 协议唤起，open-url 事件
  | "windows-protocol";  // Windows 协议唤起（argv 里带协议头）

export type JumpConnectParams = {
  protocol: "ssh";
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  /** 来源标识，便于排查 */
  source: JumpSource;
};

const sshApi = {
  connect: (sessionId: string, params: SshConnectParams) =>
    ipcRenderer.invoke("ssh:connect", params, sessionId) as Promise<boolean>,
  disconnect: (sessionId: string) =>
    ipcRenderer.invoke("ssh:disconnect", sessionId) as Promise<boolean>,
  write: (sessionId: string, data: string) =>
    ipcRenderer.invoke("ssh:write", sessionId, data) as Promise<boolean>,
  resize: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke("ssh:resize", sessionId, cols, rows) as Promise<boolean>,
  listSessions: () =>
    ipcRenderer.invoke("ssh:list-sessions") as Promise<SshSessionInfo[]>,
  forwardLocal: (sessionId: string, spec: SshForwardSpec) =>
    ipcRenderer.invoke("ssh:forward-local", sessionId, spec) as Promise<SshForwardStatus>,
  forwardRemote: (sessionId: string, spec: SshForwardSpec) =>
    ipcRenderer.invoke("ssh:forward-remote", sessionId, spec) as Promise<SshForwardStatus>,
  forwardDynamic: (sessionId: string, spec: SshForwardSpec) =>
    ipcRenderer.invoke("ssh:forward-dynamic", sessionId, spec) as Promise<SshForwardStatus>,
  listForwards: (sessionId: string) =>
    ipcRenderer.invoke("ssh:list-forwards", sessionId) as Promise<SshForwardStatus[]>,
  cancelForward: (sessionId: string, id: string) =>
    ipcRenderer.invoke("ssh:cancel-forward", sessionId, id) as Promise<boolean>,
  onForward: (
    callback: (sessionId: string, status: SshForwardStatus) => void
  ) => {
    const listener = (
      _e: unknown,
      sessionId: string,
      status: SshForwardStatus
    ) => callback(sessionId, status);
    ipcRenderer.on("ssh:forward", listener);
    return () => ipcRenderer.off("ssh:forward", listener);
  },
  onData: (callback: (sessionId: string, data: string) => void) => {
    const listener = (_e: unknown, sessionId: string, data: string) =>
      callback(sessionId, data);
    ipcRenderer.on("ssh:data", listener);
    return () => ipcRenderer.off("ssh:data", listener);
  },
  onStatus: (
    callback: (sessionId: string, status: string, extra?: unknown) => void
  ) => {
    const listener = (
      _e: unknown,
      sessionId: string,
      status: string,
      extra?: unknown
    ) => callback(sessionId, status, extra);
    ipcRenderer.on("ssh:status", listener);
    return () => ipcRenderer.off("ssh:status", listener);
  },
};

const winApi = {
  openNewWindow: () => ipcRenderer.invoke("win:open-new-window"),
};

const localTerminalApi = {
  create: (sessionId: string, shell?: string, cols?: number, rows?: number) =>
    ipcRenderer.invoke("local-terminal:create", sessionId, shell, cols, rows) as Promise<boolean>,
  write: (sessionId: string, data: string) =>
    ipcRenderer.invoke("local-terminal:write", sessionId, data) as Promise<boolean>,
  resize: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke("local-terminal:resize", sessionId, cols, rows) as Promise<boolean>,
  dispose: (sessionId: string) =>
    ipcRenderer.invoke("local-terminal:dispose", sessionId) as Promise<boolean>,
  onData: (callback: (sessionId: string, data: string) => void) => {
    const listener = (_e: unknown, sessionId: string, data: string) =>
      callback(sessionId, data);
    ipcRenderer.on("local-terminal:data", listener);
    return () => ipcRenderer.off("local-terminal:data", listener);
  },
  onReady: (callback: (sessionId: string) => void) => {
    const listener = (_e: unknown, sessionId: string) => callback(sessionId);
    ipcRenderer.on("local-terminal:ready", listener);
    return () => ipcRenderer.off("local-terminal:ready", listener);
  },
  onExit: (callback: (sessionId: string, exitCode: number) => void) => {
    const listener = (_e: unknown, sessionId: string, exitCode: number) =>
      callback(sessionId, exitCode);
    ipcRenderer.on("local-terminal:exit", listener);
    return () => ipcRenderer.off("local-terminal:exit", listener);
  },
  onError: (callback: (sessionId: string, error: string) => void) => {
    const listener = (_e: unknown, sessionId: string, error: string) =>
      callback(sessionId, error);
    ipcRenderer.on("local-terminal:error", listener);
    return () => ipcRenderer.off("local-terminal:error", listener);
  },
};

const clipboardApi = {
  writeText: (text: string) => clipboard.writeText(text),
  readText: () => clipboard.readText(),
};

const sftpApi = {
  connect: (sessionId: string, params: SshConnectParams) =>
    ipcRenderer.invoke("sftp:connect", params, sessionId) as Promise<boolean>,
  list: (sessionId: string, path: string) =>
    ipcRenderer.invoke("sftp:list", sessionId, path) as Promise<RemoteFileInfo[]>,
  mkdir: (sessionId: string, path: string) =>
    ipcRenderer.invoke("sftp:mkdir", sessionId, path) as Promise<void>,
  remove: (sessionId: string, path: string, isDir: boolean) =>
    ipcRenderer.invoke("sftp:remove", sessionId, path, isDir) as Promise<void>,
  rename: (sessionId: string, oldPath: string, newPath: string) =>
    ipcRenderer.invoke("sftp:rename", sessionId, oldPath, newPath) as Promise<void>,
  download: (sessionId: string, remotePath: string, localPath: string) =>
    ipcRenderer.invoke("sftp:download", sessionId, remotePath, localPath) as Promise<void>,
  upload: (sessionId: string, localPath: string, remotePath: string) =>
    ipcRenderer.invoke("sftp:upload", sessionId, localPath, remotePath) as Promise<void>,
  realpath: (sessionId: string, path: string) =>
    ipcRenderer.invoke("sftp:realpath", sessionId, path) as Promise<string>,
  disconnect: (sessionId: string) =>
    ipcRenderer.invoke("sftp:disconnect", sessionId) as Promise<boolean>,
  onProgress: (
    callback: (sessionId: string, data: SftpProgress) => void
  ) => {
    const listener = (
      _e: unknown,
      sessionId: string,
      data: SftpProgress
    ) => callback(sessionId, data);
    ipcRenderer.on("sftp:progress", listener);
    return () => ipcRenderer.off("sftp:progress", listener);
  },
};

const localFsApi = {
  listDir: (path: string) =>
    ipcRenderer.invoke("local-fs:list-dir", path) as Promise<LocalFileInfo[]>,
  listRoots: () =>
    ipcRenderer.invoke("local-fs:list-roots") as Promise<string[]>,
  getDesktopPath: () =>
    ipcRenderer.invoke("local-fs:get-desktop-path") as Promise<string>,
  mkdir: (path: string) =>
    ipcRenderer.invoke("local-fs:mkdir", path) as Promise<void>,
  rename: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke("local-fs:rename", oldPath, newPath) as Promise<void>,
  remove: (path: string) =>
    ipcRenderer.invoke("local-fs:remove", path) as Promise<void>,
};

const secureStorageApi = {
  encrypt: (plain: string) =>
    ipcRenderer.invoke("secure:encrypt", plain) as Promise<string>,
  decrypt: (cipher: string) =>
    ipcRenderer.invoke("secure:decrypt", cipher) as Promise<string>,
};

/** 一条操作记录的元信息（.json 文件） */
export interface RecordingMeta {
  id: string;
  name: string;
  path: string;
  size: number;
  createdAt: number; // 毫秒时间戳
  duration: number; // 秒
  width: number;
  height: number;
  type?: string; // 记录类型，如 "operation-log"
  title?: string;
}

const recordingsApi = {
  getDir: () => ipcRenderer.invoke("recording:get-dir") as Promise<string>,
  save: (input: { name: string; content: string; duration?: number }) =>
    ipcRenderer.invoke("recording:save", input) as Promise<RecordingMeta>,
  list: () => ipcRenderer.invoke("recording:list") as Promise<RecordingMeta[]>,
  read: (id: string) => ipcRenderer.invoke("recording:read", id) as Promise<string>,
  remove: (id: string) => ipcRenderer.invoke("recording:remove", id) as Promise<void>,
  rename: (id: string, name: string) =>
    ipcRenderer.invoke("recording:rename", id, name) as Promise<RecordingMeta>,
  openDir: () => ipcRenderer.invoke("recording:open-dir") as Promise<void>,
};

contextBridge.exposeInMainWorld("ssh", sshApi);
contextBridge.exposeInMainWorld("secureStorage", secureStorageApi);
contextBridge.exposeInMainWorld("termAI", winApi);
contextBridge.exposeInMainWorld("localTerminal", localTerminalApi);
contextBridge.exposeInMainWorld("clipboard", clipboardApi);
contextBridge.exposeInMainWorld("sftp", sftpApi);
contextBridge.exposeInMainWorld("localFs", localFsApi);
contextBridge.exposeInMainWorld("recordings", recordingsApi);

// 暴露一个 ping 用于调试
contextBridge.exposeInMainWorld("__termai_debug", {
  ping: () => ipcRenderer.invoke("ping", "hello from renderer"),
});

/**
 * 外部唤起 Jump Connect —— 配合主进程 deepLink.ts / 堡垒机对接。
 * 主进程解析出 host/user/port/password 后通过 jump:connect 消息推到这里，
 * 渲染层的 src/lib/jumpConnect.ts 监听后自动建 SSH tab 并连接。
 */
const jumpApi = {
  onJumpConnect: (callback: (params: JumpConnectParams) => void) => {
    const listener = (_e: unknown, params: JumpConnectParams) => callback(params);
    ipcRenderer.on("jump:connect", listener);
    return () => {
      ipcRenderer.off("jump:connect", listener);
    };
  },
};
contextBridge.exposeInMainWorld("__jump", jumpApi);

export type SshApi = typeof sshApi;
export type WinApi = typeof winApi;
export type LocalTerminalApi = typeof localTerminalApi;
export type SftpApi = typeof sftpApi;
export type LocalFsApi = typeof localFsApi;
export type SecureStorageApi = typeof secureStorageApi;
export type RecordingsApi = typeof recordingsApi;
export type JumpApi = typeof jumpApi;
