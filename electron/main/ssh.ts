import { Client, ClientChannel, ConnectConfig, SFTPWrapper } from "ssh2";
import type { BrowserWindow } from "electron";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import { parseSocks5ConnectRequest, buildSocks5SuccessReply } from "./socks5.js";

export interface SshSessionInfo {
  id: string;
  host: string;
  username: string;
  connected: boolean;
  startTime: number;
}

export interface SshConnectParams {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface RemoteFileInfo {
  name: string;
  path: string;
  type: "file" | "directory" | "link" | "other";
  size: number;
  modifyTime: number;
  isDirectory: boolean;
}

export interface SftpManager {
  sftpConnect: (sessionId: string, params: SshConnectParams) => Promise<boolean>;
  sftpList: (sessionId: string, path: string) => Promise<RemoteFileInfo[]>;
  sftpMkdir: (sessionId: string, path: string) => Promise<void>;
  sftpRemove: (sessionId: string, path: string, isDir: boolean) => Promise<void>;
  sftpRename: (sessionId: string, oldPath: string, newPath: string) => Promise<void>;
  sftpDownload: (sessionId: string, remotePath: string, localPath: string) => Promise<void>;
  sftpUpload: (sessionId: string, localPath: string, remotePath: string) => Promise<void>;
  sftpRealpath: (sessionId: string, path: string) => Promise<string>;
  sftpDisconnect: (sessionId: string) => boolean;
  sftpDisposeAll: () => void;
}

export type SshForwardType = "local" | "remote" | "dynamic";

// 创建转发时的参数（id 可选，未提供时由主进程生成）
export interface SshForwardSpec {
  id?: string;
  type: SshForwardType;
  // local / dynamic：本地监听地址，默认 127.0.0.1
  localAddress?: string;
  // local / dynamic：本地监听端口，0 表示随机分配
  localPort: number;
  // 转发目标：
  //  - local：远端（SSH 服务器侧可达）目标地址
  //  - remote：本机（客户端侧）目标地址
  //  - dynamic：无（目标由 SOCKS 客户端在连接时指定）
  remoteAddress: string;
  remotePort: number;
}

export interface SshForwardStatus {
  id: string;
  type: SshForwardType;
  localAddress?: string;
  localPort?: number;
  remoteAddress?: string;
  remotePort?: number;
  // remote 转发在 SSH 服务器端绑定的地址 / 端口
  bindAddress?: string;
  bindPort?: number;
  listening: boolean;
  error?: string;
}

/** 独立 exec 通道的执行结果（不含 PTY 回显，纯 stdout/stderr） */
export interface SshExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** 超时被中断（此时 stdout 可能是半截） */
  timeout?: boolean;
}

export interface SshManager extends SftpManager {
  connect: (sessionId: string, params: SshConnectParams) => Promise<boolean>;
  disconnect: (sessionId: string) => boolean;
  /**
   * 在既有连接上另开一条 exec 通道跑命令。
   *
   * 为什么不复用用户 PTY：终端里写命令会把回显和提示符留给用户看，
   * 采样（每 2s 一次）会把界面刷满；exec 通道不占 PTY、不进终端缓冲区，
   * 也不会打断用户正在敲的输入。
   */
  exec: (sessionId: string, command: string, timeoutMs?: number) => Promise<SshExecResult>;
  write: (sessionId: string, data: string) => boolean;
  resize: (sessionId: string, cols: number, rows: number) => boolean;
  listSessions: () => SshSessionInfo[];
  disposeAll: () => void;
  // ---------------- 端口转发 ----------------
  forwardLocal: (sessionId: string, spec: SshForwardSpec) => Promise<SshForwardStatus>;
  forwardRemote: (sessionId: string, spec: SshForwardSpec) => Promise<SshForwardStatus>;
  forwardDynamic: (sessionId: string, spec: SshForwardSpec) => Promise<SshForwardStatus>;
  listForwards: (sessionId: string) => SshForwardStatus[];
  cancelForward: (sessionId: string, id: string) => boolean;
  cancelAllForwards: (sessionId: string) => void;
}

interface Session {
  id: string;
  client: Client;
  stream?: ClientChannel;
  info: SshSessionInfo;
  emitter: EventEmitter;
  // 连接参数快照（含 proxyJump），用于断线后自动重连
  params?: SshConnectParams;
  // 跳板机连接（ProxyJump 时建立，目标连接走它内部转发）
  jumpClient?: Client;
  // 是否为「用户主动断开」：主动断开不触发自动重连
  intentionalClose: boolean;
  // 当前是否处于重连流程中（用于区分首次连接与重连的状态事件）
  reconnecting: boolean;
  // 重连次数（用于退避上限）
  reconnectAttempts: number;
  // 是否已安排重连定时器（避免 'end'/'close' 重复排程）
  reconnectScheduled: boolean;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  // 建立 PTY 时的终端尺寸，重连后重建 shell 用
  cols?: number;
  rows?: number;
}

interface SftpSession {
  client: Client;
  sftp: SFTPWrapper;
}

interface ForwardEntry {
  id: string;
  type: SshForwardType;
  spec: SshForwardSpec;
  server?: net.Server;
  // remote 转发用：监听 SSH 服务器侧连入
  tcpHandler?: (info: unknown, accept: () => ClientChannel, reject: () => void) => void;
  status: SshForwardStatus;
}

// 构造 SSH 连接配置（终端与 SFTP 共用，确保算法兼容一致）
function buildConnectConfig(params: SshConnectParams): ConnectConfig {
  const config: ConnectConfig = {
    host: params.host,
    port: params.port,
    username: params.username,
    readyTimeout: 15000,
    keepaliveInterval: 30000,
    // 连续 3 次保活无响应即判定连接已死，触发重连（默认 0 = 永不超时）
    keepaliveCountMax: 3,
    // 放宽算法支持，兼容旧版 OpenSSH（CentOS 6/7、旧版 Ubuntu 等）
    algorithms: {
      kex: [
        "ecdh-sha2-nistp256",
        "ecdh-sha2-nistp384",
        "ecdh-sha2-nistp521",
        "diffie-hellman-group-exchange-sha256",
        "diffie-hellman-group14-sha256",
        "diffie-hellman-group14-sha1",
        "diffie-hellman-group1-sha1",
      ],
      serverHostKey: [
        "ssh-ed25519",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "ssh-rsa",
        "ssh-dss",
        "rsa-sha2-256",
        "rsa-sha2-512",
      ],
      cipher: [
        "aes128-ctr",
        "aes192-ctr",
        "aes256-ctr",
        "aes128-gcm",
        "aes128-gcm@openssh.com",
        "aes256-gcm",
        "aes256-gcm@openssh.com",
        "aes256-cbc",
        "aes192-cbc",
        "aes128-cbc",
        "3des-cbc",
      ],
      hmac: [
        "hmac-sha2-256",
        "hmac-sha2-512",
        "hmac-sha1",
        "hmac-md5",
        "hmac-sha2-256-etm@openssh.com",
        "hmac-sha2-512-etm@openssh.com",
      ],
    },
  };

  if (params.privateKey) {
    config.privateKey = params.privateKey;
    if (params.passphrase) config.passphrase = params.passphrase;
  } else if (params.password) {
    config.password = params.password;
    config.tryKeyboard = true; // 兼容旧版服务器的 keyboard-interactive 认证
  }

  return config;
}

// 远端路径拼接（Unix 风格）
function joinRemote(base: string, name: string): string {
  if (base === "/") return "/" + name;
  return base.replace(/\/+$/, "") + "/" + name;
}

// 前端传来的尺寸做合法性收敛，避免 NaN / 0 / 超大值把 PTY 搞崩
function sanitizeSize(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function createSshManager(win: BrowserWindow): SshManager {
  const sessions = new Map<string, Session>();
  const sftpSessions = new Map<string, SftpSession>();
  const progressLastEmit = new Map<string, number>();

  const emit = (channel: string, ...args: unknown[]) => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  };

  const emitProgress = (sessionId: string, data: unknown) => {
    const now = Date.now();
    const last = progressLastEmit.get(sessionId) ?? 0;
    if (now - last > 150 || (data as { transferred: number; total: number }).transferred >= (data as { transferred: number; total: number }).total) {
      progressLastEmit.set(sessionId, now);
      emit("sftp:progress", sessionId, data);
    }
  };

  const connect = async (sessionId: string, params: SshConnectParams): Promise<boolean> => {
    // 同名 session 还在（比如重连期间又点连接），先彻底清掉旧的再建
    const stale = sessions.get(sessionId);
    if (stale) {
      stale.intentionalClose = true;
      if (stale.reconnectTimer) clearTimeout(stale.reconnectTimer);
      try {
        stale.client.end();
        stale.jumpClient?.end();
      } catch {
        /* ignore */
      }
      sessions.delete(sessionId);
    }

    const client = new Client();
    const emitter = new EventEmitter();
    const session: Session = {
      id: sessionId,
      client,
      emitter,
      info: {
        id: sessionId,
        host: params.host,
        username: params.username,
        connected: false,
        startTime: Date.now(),
      },
      params: { ...params },
      intentionalClose: false,
      reconnecting: false,
      reconnectAttempts: 0,
      reconnectScheduled: false,
      cols: params.cols,
      rows: params.rows,
    };
    sessions.set(sessionId, session);

    // ProxyJump：先连跳板机，再从跳板机内部转发到目标，作为目标连接的 sock
    let jump: { jumpClient: Client; sock: ClientChannel } | undefined;
    if (params.proxyJump) {
      try {
        jump = await acquireJump(params);
        session.jumpClient = jump.jumpClient;
      } catch (e) {
        emit("ssh:status", sessionId, "error", (e as Error).message);
        sessions.delete(sessionId);
        throw e;
      }
    }

    await openShell(session, params, jump);
    return true;
  };

  // ---------------- 跳板机 / 自动重连辅助 ----------------

  type JumpConfig = NonNullable<SshConnectParams["proxyJump"]>;

  const connectJump = (cfg: JumpConfig): Promise<Client> =>
    new Promise((resolve, reject) => {
      const c = new Client();
      c.on("ready", () => resolve(c)).on("error", reject).connect(buildConnectConfig(cfg));
    });

  const acquireJump = async (params: SshConnectParams): Promise<{ jumpClient: Client; sock: ClientChannel }> => {
    const jumpClient = await connectJump(params.proxyJump!);
    const sock = await new Promise<ClientChannel>((res, rej) => {
      jumpClient.forwardOut("127.0.0.1", 0, params.host, params.port, (err, stream) => {
        if (err || !stream) rej(err ?? new Error("跳板机转发失败"));
        else res(stream);
      });
    });
    return { jumpClient, sock };
  };

  const shellOptions = (cols?: number, rows?: number) => ({
    term: "xterm-256color",
    // 用前端 xterm 的真实尺寸建立 PTY。写死 80x24 会让远端 shell 在
    // 第 80 列就换行，而屏幕更宽 —— 长命令与历史命令重绘会整体错位。
    cols: sanitizeSize(cols, 80, 1, 1000),
    rows: sanitizeSize(rows, 24, 1, 500),
  });

  const wireStream = (session: Session, stream: ClientChannel) => {
    session.stream = stream;
    stream
      .on("data", (data: Buffer) => {
        emit("ssh:data", session.id, data.toString("utf-8"));
      })
      .on("close", () => {
        emit("ssh:status", session.id, "closed");
        session.info.connected = false;
      })
      .on("exit", (code) => {
        emit("ssh:status", session.id, "exit", code);
      })
      .stderr.on("data", (data: Buffer) => {
        emit("ssh:data", session.id, data.toString("utf-8"));
      });
  };

  /**
   * 建立 SSH 连接 + shell 流。首次连接与断线重连共用。
   * jump 提供时（ProxyJump），把它的转发 sock 作为目标连接的传输层。
   */
  const openShell = (
    session: Session,
    params: SshConnectParams,
    jump?: { jumpClient: Client; sock: ClientChannel }
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const client = session.client;
      const config = buildConnectConfig(params);
      if (jump) (config as ConnectConfig & { sock?: unknown }).sock = jump.sock;

      client
        .on("ready", () => {
          session.info.connected = true;
          // 重连成功后重置计数；首次连接用 'connected'，重连用 'reconnected'
          // 先取出重连标记再重置：否则 emit 时恒为 false，'reconnected' 分支永远走不到
          const wasReconnecting = session.reconnecting;
          session.reconnecting = false;
          session.reconnectAttempts = 0;
          emit("ssh:status", session.id, wasReconnecting ? "reconnected" : "connected");

          client.shell(shellOptions(session.cols, session.rows), (err, stream) => {
            if (err) {
              reject(err);
              return;
            }
            wireStream(session, stream);
            resolve();
          });
        })
        .on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
          // keyboard-interactive 认证回退（配合 tryKeyboard=true）
          const answers = prompts.map(() => params.password ?? "");
          finish(answers);
        })
        .on("error", (err) => {
          if (session.intentionalClose) {
            reject(err);
            return;
          }
          emit("ssh:status", session.id, "error", err.message);
          // 首次连接失败（目标不可达等）不重连；重连失败交给 doReconnect 退避
          if (!session.reconnecting) sessions.delete(session.id);
          reject(err);
        })
        .on("end", () => {
          session.info.connected = false;
          emit("ssh:status", session.id, "end");
          maybeReconnect(session);
        })
        .on("close", () => {
          session.info.connected = false;
          emit("ssh:status", session.id, "close");
          if (session.intentionalClose) {
            sessions.delete(session.id);
            return;
          }
          maybeReconnect(session);
        })
        .connect(config);
    });

  const MAX_RECONNECT_ATTEMPTS = 5;
  const RECONNECT_BASE_MS = 1000;

  const maybeReconnect = (session: Session) => {
    if (session.intentionalClose) {
      sessions.delete(session.id);
      return;
    }
    if (session.reconnectScheduled) return;
    if (session.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      emit("ssh:status", session.id, "disconnected", "重连失败，已达最大重试次数");
      sessions.delete(session.id);
      return;
    }
    session.reconnectScheduled = true;
    session.reconnectAttempts += 1;
    // 指数退避：1s → 2s → 4s → 8s → 16s（封顶 30s）
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (session.reconnectAttempts - 1), 30000);
    emit("ssh:status", session.id, "reconnecting", {
      attempt: session.reconnectAttempts,
      max: MAX_RECONNECT_ATTEMPTS,
      delay,
    });
    session.reconnectTimer = setTimeout(() => {
      void doReconnect(session);
    }, delay);
  };

  const doReconnect = async (session: Session) => {
    if (session.intentionalClose) return;
    const params = session.params;
    if (!params) {
      emit("ssh:status", session.id, "disconnected");
      sessions.delete(session.id);
      return;
    }
    session.reconnectScheduled = false;
    session.reconnecting = true;

    // 旧连接（含跳板机）已随断开失效，清掉残留转发，避免指向死 client
    cancelAllForwards(session.id);

    const client = new Client();
    session.client = client;

    let jump: { jumpClient: Client; sock: ClientChannel } | undefined;
    if (params.proxyJump) {
      try {
        // ssh2 的 Client.end() 返回 EventEmitter 而非 Promise，不能 .catch()；
        // 旧跳板机连接可能已随断开失效，这里只需尽力关闭，失败也不影响重建。
        try {
          session.jumpClient?.end();
        } catch {
          /* ignore */
        }
        jump = await acquireJump(params);
        session.jumpClient = jump.jumpClient;
      } catch {
        // 跳板机连不上：继续退避重试
        session.reconnecting = false;
        maybeReconnect(session);
        return;
      }
    }

    try {
      await openShell(session, params, jump);
      // 重连成功后，连接入口（XTerminal 'reconnected' 状态）会自动恢复端口转发
    } catch {
      session.reconnecting = false;
      maybeReconnect(session);
    }
  };

  const disconnect = (sessionId: string): boolean => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    // 标记为「主动断开」，阻断自动重连
    session.intentionalClose = true;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    cancelAllForwards(sessionId);
    try {
      if (session.stream) session.stream.end();
      session.client.end();
      session.jumpClient?.end();
    } catch {
      // ignore
    }
    sessions.delete(sessionId);
    return true;
  };

  const write = (sessionId: string, data: string): boolean => {
    const session = sessions.get(sessionId);
    if (!session || !session.stream) return false;
    session.stream.write(data);
    return true;
  };

  const resize = (sessionId: string, cols: number, rows: number): boolean => {
    const session = sessions.get(sessionId);
    if (!session || !session.stream) return false;
    try {
      session.stream.setWindow(rows, cols, 800, 600);
      return true;
    } catch {
      return false;
    }
  };

  const listSessions = (): SshSessionInfo[] => {
    return Array.from(sessions.values()).map((s) => ({ ...s.info }));
  };

  // 与用户 PTY 完全隔离的一次性执行通道。只读采样专用：
  // 不写终端缓冲区、不改 shell 状态、不影响正在输入的半行命令。
  const exec = (
    sessionId: string,
    command: string,
    timeoutMs = 4000
  ): Promise<SshExecResult> =>
    new Promise((resolve, reject) => {
      const session = sessions.get(sessionId);
      if (!session) {
        reject(new Error("SSH 会话不存在"));
        return;
      }
      // 采样是「锦上添花」：连接正在重连/已断开时不要抛给调用方去弹错误框，
      // 直接给空结果，UI 自己会降级成「—」。
      if (!session.info.connected) {
        resolve({ stdout: "", stderr: "not connected", code: null });
        return;
      }

      let settled = false;
      let stdout = "";
      let stderr = "";
      const finish = (r: SshExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      // 通道卡住（对端不响应）时不能让 Promise 永远挂着，否则采样队列会堆积。
      const timer = setTimeout(() => {
        finish({ stdout, stderr, code: null, timeout: true });
      }, Math.max(500, timeoutMs));

      session.client.exec(command, { pty: false }, (err, stream) => {
        if (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
          return;
        }
        // 上限保护：采样命令输出只有几 KB，异常时（比如 /proc 被挂成目录树）
        // 也不能把主进程内存吃掉。
        const MAX_OUT = 128 * 1024;
        stream.on("data", (d: Buffer) => {
          if (stdout.length < MAX_OUT) stdout += d.toString("utf-8");
        });
        stream.stderr.on("data", (d: Buffer) => {
          if (stderr.length < 8192) stderr += d.toString("utf-8");
        });
        stream.on("close", (code: number | null) => {
          finish({ stdout, stderr, code: code ?? null });
        });
        stream.on("error", () => {
          finish({ stdout, stderr, code: null });
        });
      });
    });

  const disposeAll = () => {
    for (const session of sessions.values()) {
      try {
        session.intentionalClose = true;
        if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
        cancelAllForwards(session.id);
        if (session.stream) session.stream.end();
        session.client.end();
        session.jumpClient?.end();
      } catch {
        // ignore
      }
    }
    sessions.clear();
    forwardMap.clear();
    sftpDisposeAll();
  };

  // ---------------- 端口转发 ----------------
  // 按 sessionId -> forwardId 组织，便于列出与清理
  const forwardMap = new Map<string, Map<string, ForwardEntry>>();

  const emitForward = (sessionId: string, status: SshForwardStatus) => {
    emit("ssh:forward", sessionId, status);
  };

  const registerForward = (sessionId: string, entry: ForwardEntry) => {
    if (!forwardMap.has(sessionId)) forwardMap.set(sessionId, new Map());
    forwardMap.get(sessionId)!.set(entry.id, entry);
    emitForward(sessionId, entry.status);
  };

  const pipeChannel = (socket: net.Socket, stream: ClientChannel) => {
    stream.on("error", () => socket.destroy());
    socket.on("error", () => stream.end());
    socket.pipe(stream).pipe(socket);
    stream.on("close", () => socket.destroy());
  };

  const genForwardId = () =>
    `fw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const forwardLocal = (
    sessionId: string,
    spec: SshForwardSpec
  ): Promise<SshForwardStatus> =>
    new Promise((resolve, reject) => {
      const sess = sessions.get(sessionId);
      if (!sess || !sess.client || !sess.info.connected) {
        reject(new Error("SSH 未连接"));
        return;
      }
      const id = spec.id ?? genForwardId();
      const localAddress = spec.localAddress || "127.0.0.1";
      const server = net.createServer();
      server.on("connection", (socket: net.Socket) => {
        sess.client.forwardOut(
          localAddress,
          0,
          spec.remoteAddress,
          spec.remotePort,
          (err, stream) => {
            if (err || !stream) {
              socket.destroy();
              return;
            }
            pipeChannel(socket, stream);
          }
        );
      });
      server.on("error", (e: Error) => {
        const entry = forwardMap.get(sessionId)?.get(id);
        if (entry) {
          entry.status = { ...entry.status, listening: false, error: e.message };
          emitForward(sessionId, entry.status);
        }
        reject(e);
      });
      server.listen(spec.localPort || 0, localAddress, () => {
        const addr = server.address() as net.AddressInfo;
        const status: SshForwardStatus = {
          id,
          type: "local",
          localAddress: addr.address,
          localPort: addr.port,
          remoteAddress: spec.remoteAddress,
          remotePort: spec.remotePort,
          listening: true,
        };
        registerForward(sessionId, { id, type: "local", spec, server, status });
        resolve(status);
      });
    });

  const forwardRemote = (
    sessionId: string,
    spec: SshForwardSpec
  ): Promise<SshForwardStatus> =>
    new Promise((resolve, reject) => {
      const sess = sessions.get(sessionId);
      if (!sess || !sess.client || !sess.info.connected) {
        reject(new Error("SSH 未连接"));
        return;
      }
      const id = spec.id ?? genForwardId();
      const bindAddr = spec.localAddress || "127.0.0.1";
      const bindPort = spec.localPort || 0;
      const tcpHandler = (
        info: { destPort?: number },
        accept: () => ClientChannel,
        rejectConn: () => void
      ) => {
        // 只处理本转发绑定的端口（动态端口 0 时无法精确匹配，放行）
        if (bindPort !== 0 && info.destPort !== bindPort) return;
        const stream = accept();
        if (!stream) {
          rejectConn();
          return;
        }
        const socket = net.connect(spec.remotePort, spec.remoteAddress);
        pipeChannel(socket, stream);
      };
      sess.client.on("tcp connection", tcpHandler);
      sess.client.forwardIn(bindAddr, bindPort, (err: Error | undefined) => {
        if (err) {
          sess.client.removeListener("tcp connection", tcpHandler);
          reject(err);
          return;
        }
        const status: SshForwardStatus = {
          id,
          type: "remote",
          bindAddress: bindAddr,
          bindPort,
          remoteAddress: spec.remoteAddress,
          remotePort: spec.remotePort,
          listening: true,
        };
        registerForward(sessionId, { id, type: "remote", spec, tcpHandler, status });
        resolve(status);
      });
    });

  const forwardDynamic = (
    sessionId: string,
    spec: SshForwardSpec
  ): Promise<SshForwardStatus> =>
    new Promise((resolve, reject) => {
      const sess = sessions.get(sessionId);
      if (!sess || !sess.client || !sess.info.connected) {
        reject(new Error("SSH 未连接"));
        return;
      }
      const id = spec.id ?? genForwardId();
      const localAddress = spec.localAddress || "127.0.0.1";
      const server = net.createServer();
      server.on("connection", (socket: net.Socket) => {
        let authed = false;
        let buf = Buffer.alloc(0);
        const fail = () => {
          try {
            socket.destroy();
          } catch {
            /* ignore */
          }
        };
        const onData = (data: Buffer) => {
          buf = Buffer.concat([buf, data]);
          if (!authed) {
            if (buf.length < 2) return;
            const n = buf[1];
            if (buf.length < 2 + n) return;
            socket.write(Buffer.from([0x05, 0x00])); // 选无认证
            authed = true;
            buf = buf.slice(2 + n);
            if (buf.length === 0) return;
          }
          const target = parseSocks5ConnectRequest(buf);
          if (!target) {
            if (buf.length > 2048) fail(); // 防御畸形数据
            return;
          }
          buf = Buffer.alloc(0);
          socket.removeListener("data", onData);
          sess.client.forwardOut(
            localAddress,
            0,
            target.host,
            target.port,
            (err, stream) => {
              if (err || !stream) {
                // 连接失败应答
                socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                fail();
                return;
              }
              socket.write(buildSocks5SuccessReply());
              pipeChannel(socket, stream);
            }
          );
        };
        socket.on("data", onData);
        socket.on("error", () => {
          /* ignore */
        });
      });
      server.on("error", (e: Error) => {
        const entry = forwardMap.get(sessionId)?.get(id);
        if (entry) {
          entry.status = { ...entry.status, listening: false, error: e.message };
          emitForward(sessionId, entry.status);
        }
        reject(e);
      });
      server.listen(spec.localPort || 0, localAddress, () => {
        const addr = server.address() as net.AddressInfo;
        const status: SshForwardStatus = {
          id,
          type: "dynamic",
          localAddress: addr.address,
          localPort: addr.port,
          listening: true,
        };
        registerForward(sessionId, { id, type: "dynamic", spec, server, status });
        resolve(status);
      });
    });

  const listForwards = (sessionId: string): SshForwardStatus[] => {
    const m = forwardMap.get(sessionId);
    return m ? Array.from(m.values()).map((e) => e.status) : [];
  };

  const cancelForward = (sessionId: string, id: string): boolean => {
    const m = forwardMap.get(sessionId);
    const entry = m?.get(id);
    if (!entry) return false;
    try {
      if (entry.server) entry.server.close();
      if (entry.tcpHandler) {
        const client = sessions.get(sessionId)?.client;
        if (client) {
          client.removeListener("tcp connection", entry.tcpHandler);
          client.cancelForwardIn(
            entry.spec.localAddress || "127.0.0.1",
            entry.spec.localPort,
            () => {
              /* ignore */
            }
          );
        }
      }
    } catch {
      /* ignore */
    }
    m!.delete(id);
    emitForward(sessionId, { ...entry.status, listening: false });
    return true;
  };

  const cancelAllForwards = (sessionId: string) => {
    const m = forwardMap.get(sessionId);
    if (!m) return;
    for (const id of Array.from(m.keys())) cancelForward(sessionId, id);
    forwardMap.delete(sessionId);
  };

  // ---------------- SFTP ----------------

  const sftpConnect = (sessionId: string, params: SshConnectParams): Promise<boolean> => {
    return new Promise((resolve, reject) => {
      if (sftpSessions.has(sessionId)) {
        console.log("[sftp] session already connected:", sessionId);
        resolve(true);
        return;
      }
      console.log("[sftp] connecting to", params.host, params.port, "as", params.username);
      const client = new Client();
      const config = buildConnectConfig(params);
      let settled = false;

      const cleanup = () => {
        sftpSessions.delete(sessionId);
      };

      client
        .on("ready", () => {
          console.log("[sftp] ssh ready, requesting sftp subsystem...");
          client.sftp((err, sftp) => {
            if (err) {
              console.error("[sftp] subsystem error:", err.message);
              client.end();
              if (!settled) {
                settled = true;
                reject(err);
              }
              return;
            }
            console.log("[sftp] subsystem ready");
            sftpSessions.set(sessionId, { client, sftp });
            if (!settled) {
              settled = true;
              resolve(true);
            }
          });
        })
        .on("error", (err) => {
          console.error("[sftp] connection error:", err.message);
          cleanup();
          if (!settled) {
            settled = true;
            reject(err);
          }
        })
        .on("close", () => {
          console.log("[sftp] connection closed");
          cleanup();
        })
        .on("end", () => {
          console.log("[sftp] connection ended");
          cleanup();
        })
        .connect(config);

      // 兜底超时
      setTimeout(() => {
        if (!settled) {
          settled = true;
          client.end();
          cleanup();
          reject(new Error("SFTP 连接超时（15秒）"));
        }
      }, 15000);
    });
  };

  const sftpDisconnect = (sessionId: string): boolean => {
    const s = sftpSessions.get(sessionId);
    if (!s) return false;
    try {
      s.client.end();
    } catch {
      // ignore
    }
    sftpSessions.delete(sessionId);
    progressLastEmit.delete(sessionId);
    return true;
  };

  const sftpDisposeAll = () => {
    for (const s of sftpSessions.values()) {
      try {
        s.client.end();
      } catch {
        // ignore
      }
    }
    sftpSessions.clear();
    progressLastEmit.clear();
  };

  const sftpList = (sessionId: string, path: string): Promise<RemoteFileInfo[]> => {
    return new Promise((resolve, reject) => {
      const s = sftpSessions.get(sessionId);
      if (!s) return reject(new Error("SFTP 未连接"));
      s.sftp.readdir(path, (err, list) => {
        if (err) return reject(err);
        const items: RemoteFileInfo[] = list
          .filter((e) => e.filename !== "." && e.filename !== "..")
          .map((e) => {
            const isDir = e.attrs.isDirectory();
            const isLink = e.attrs.isSymbolicLink();
            return {
              name: e.filename,
              path: joinRemote(path, e.filename),
              type: isDir ? "directory" : isLink ? "link" : "file",
              size: e.attrs.size,
              modifyTime: (e.attrs.mtime ?? 0) * 1000,
              isDirectory: isDir,
            };
          })
          .sort(
            (a, b) =>
              Number(b.isDirectory) - Number(a.isDirectory) ||
              a.name.localeCompare(b.name, "zh")
          );
        resolve(items);
      });
    });
  };

  const sftpMkdir = (sessionId: string, path: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const s = sftpSessions.get(sessionId);
      if (!s) return reject(new Error("SFTP 未连接"));
      s.sftp.mkdir(path, (err) => (err ? reject(err) : resolve()));
    });
  };

  const sftpRemove = (sessionId: string, path: string, isDir: boolean): Promise<void> => {
    return new Promise((resolve, reject) => {
      const s = sftpSessions.get(sessionId);
      if (!s) return reject(new Error("SFTP 未连接"));
      const sftp = s.sftp;

      if (!isDir) {
        sftp.unlink(path, (err) => (err ? reject(err) : resolve()));
        return;
      }

      // 递归删除目录
      const rmrf = (p: string): Promise<void> =>
        new Promise<void>((res, rej) => {
          sftp.readdir(p, (err, list) => {
            if (err) return rej(err);
            const tasks: Promise<void>[] = list
              .filter((e) => e.filename !== "." && e.filename !== "..")
              .map((e) => {
                const cp = joinRemote(p, e.filename);
                if (e.attrs.isDirectory()) return rmrf(cp);
                return new Promise<void>((r, j) =>
                  sftp.unlink(cp, (e2) => (e2 ? j(e2) : r()))
                );
              });
            Promise.all(tasks)
              .then(
                () =>
                  new Promise<void>((r, j) =>
                    sftp.rmdir(p, (e3) => (e3 ? j(e3) : r()))
                  )
              )
              .then(res)
              .catch(rej);
          });
        });

      rmrf(path).then(resolve).catch(reject);
    });
  };

  const sftpRename = (sessionId: string, oldPath: string, newPath: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const s = sftpSessions.get(sessionId);
      if (!s) return reject(new Error("SFTP 未连接"));
      s.sftp.rename(oldPath, newPath, (err) => (err ? reject(err) : resolve()));
    });
  };

  const sftpDownload = (
    sessionId: string,
    remotePath: string,
    localPath: string
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      const s = sftpSessions.get(sessionId);
      if (!s) return reject(new Error("SFTP 未连接"));
      s.sftp.fastGet(
        remotePath,
        localPath,
        {
          step: (transferred, _chunk, total) => {
            emitProgress(sessionId, {
              sessionId,
              transferred,
              total,
              direction: "download",
              remotePath,
              localPath,
            });
          },
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
  };

  const sftpUpload = (
    sessionId: string,
    localPath: string,
    remotePath: string
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      const s = sftpSessions.get(sessionId);
      if (!s) return reject(new Error("SFTP 未连接"));
      s.sftp.fastPut(
        localPath,
        remotePath,
        {
          step: (transferred, _chunk, total) => {
            emitProgress(sessionId, {
              sessionId,
              transferred,
              total,
              direction: "upload",
              remotePath,
              localPath,
            });
          },
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
  };

  const sftpRealpath = (sessionId: string, path: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const s = sftpSessions.get(sessionId);
      if (!s) return reject(new Error("SFTP 未连接"));
      s.sftp.realpath(path, (err, absPath) => (err ? reject(err) : resolve(absPath)));
    });
  };

  return {
    connect,
    disconnect,
    write,
    resize,
    exec,
    listSessions,
    disposeAll,
    forwardLocal,
    forwardRemote,
    forwardDynamic,
    listForwards,
    cancelForward,
    cancelAllForwards,
    sftpConnect,
    sftpList,
    sftpMkdir,
    sftpRemove,
    sftpRename,
    sftpDownload,
    sftpUpload,
    sftpRealpath,
    sftpDisconnect,
    sftpDisposeAll,
  };
}
