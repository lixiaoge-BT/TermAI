/**
 * Jump Connect —— 渲染层接收主进程推送的「外部唤起」连接参数，
 * 自动在 TermAI 里建一个 SSH 标签页并发起连接。
 *
 * 触发场景：用户从堡垒机 H5 点 TermAI 图标 / 系统唤起 termai:// 协议 /
 * 命令行带 termai://... 或 -url ssh://... 启动 TermAI，主进程解析后通过
 * jump:connect 消息推到这里。
 *
 * 必须在 initTerminalBridge() 之后再调用 initJumpConnect()，
 * 否则 __termai_connect 全局桥还没注册，首次连接会丢。
 *
 * 行为对齐 Xshell：堡垒机唤起的目标主机如果还没在主机列表里，会自动
 * 持久化一份（Xshell 也是「开了就有历史记录」），下次同地址能复用同一
 * hostId，避免重复 host 条目。
 */

import { useTerminalStore } from "@/store/terminal";
import { useLayoutStore } from "@/store/layout";
import { useAppConfig } from "@/store/config";
import type { HostConfig, JumpConnectParams, SshConnectParams } from "@/types";

type ConnectFn = (sid: string, params: SshConnectParams) => Promise<void>;

declare global {
  interface Window {
    __termai_connect?: ConnectFn;
  }
}

let registered = false;

/** 应用启动时挂一次监听；多次调用幂等 */
export function initJumpConnect() {
  if (registered) return;
  registered = true;

  const w = window as unknown as {
    __jump?: { onJumpConnect: (cb: (p: JumpConnectParams) => void) => () => void };
  };
  const api = w.__jump;
  if (!api) {
    // 兜底：HMR / 测试 / standalone web 启动时 preload 没注入，跳过即可
    console.warn(
      "[jump] window.__jump 未注入，跳过外部唤起监听（preload 未生效？）"
    );
    return;
  }

  api.onJumpConnect((params) => {
    console.log("[jump] 收到外部唤起连接参数:", {
      protocol: params.protocol,
      host: params.host,
      port: params.port,
      username: params.username,
      source: params.source,
      hasPassword: !!params.password,
      hasPrivateKey: !!params.privateKey,
    });
    void handleJumpConnect(params);
  });
}

/**
 * 处理一次外部唤起：
 * 1) 把目标主机落到 host 持久化（已存在则复用；按 host:port:user 三元组去重），
 *    像 Xshell 那样「打开就能在主机列表看到」；
 * 2) 建一个新 SSH 会话并绑到该 hostId，确保文件传输 / 转发 / 持久化状态全部挂上；
 * 3) 把新会话塞进当前聚焦面板，让用户立刻看到；
 * 4) 调用 __termai_connect 触发 ssh:connect 走 ssh2；
 * 5) 桥还没就绪时短轮询重试，避免漏掉首次唤起。
 */
async function handleJumpConnect(params: JumpConnectParams) {
  const configApi = useAppConfig.getState();
  const host = ensureJumpHost(configApi, params);
  const hostName = host.name;

  const store = useTerminalStore.getState();
  const session = store.createSession({
    hostId: host.id,
    hostName,
    host: params.host,
    username: params.username,
  });

  // 确保新 tab 在当前面板中显示（堡垒机用户的首要诉求：跳出 SSH 立刻看得到）
  try {
    useLayoutStore.getState().ensureVisible(session.id);
  } catch (e) {
    console.warn("[jump] ensureVisible 失败（不影响连）:", e);
  }

  const sshParams: SshConnectParams = {
    host: params.host,
    port: params.port,
    username: params.username,
    password: params.password,
    privateKey: params.privateKey,
  };

  const w = window as Window & { __termai_connect?: ConnectFn };
  const tryConnect = (attempts: number) => {
    if (w.__termai_connect) {
      void w.__termai_connect(session.id, sshParams);
      return;
    }
    if (attempts > 0) {
      setTimeout(() => tryConnect(attempts - 1), 120);
    } else {
      console.warn(
        "[jump] __termai_connect 桥仍未就绪，会话已建（hostId=" +
          host.id +
          " / sessionId=" +
          session.id +
          "），请在 UI 上手动点击连接"
      );
    }
  };
  // 留两次重试窗口即可：正常 initTerminalBridge() 早就跑完，这里只是抢极端时序
  setTimeout(() => tryConnect(8), 60);
}

/**
 * 把堡垒机唤起的目标主机落到 host 持久化里，已存在的复用。
 * 匹配规则：host + port + username 三元组完全相同视为同一台；
 * authMethod 优先 password（堡垒机最常见的就是口令登录）。
 */
function ensureJumpHost(
  configApi: ReturnType<typeof useAppConfig.getState>,
  params: JumpConnectParams
): HostConfig {
  const existing = configApi.hosts.find(
    (h) =>
      h.host === params.host &&
      h.port === params.port &&
      h.username === params.username
  );
  if (existing) {
    // 凭据缺失/更新时，刷新 password / privateKey（jump 一来就有，避免用户重输）
    const patch: Partial<HostConfig> = { updatedAt: Date.now() };
    if (params.password && existing.password !== params.password) {
      patch.password = params.password;
      patch.authMethod = "password";
    }
    if (params.privateKey && existing.privateKey !== params.privateKey) {
      patch.privateKey = params.privateKey;
      patch.passphrase = undefined;
      patch.authMethod = "privateKey";
    }
    if (Object.keys(patch).length > 1) {
      configApi.updateHost(existing.id, patch);
      return { ...existing, ...patch } as HostConfig;
    }
    return existing;
  }

  const name = `${params.username}@${params.host}`;
  const authMethod: HostConfig["authMethod"] = params.privateKey
    ? "privateKey"
    : "password";
  return configApi.addHost({
    name,
    host: params.host,
    port: params.port,
    username: params.username,
    authMethod,
    password: params.password,
    privateKey: params.privateKey,
  });
}

