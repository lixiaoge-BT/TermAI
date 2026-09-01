/// <reference types="vite/client" />

import type { SshApi, WinApi, LocalTerminalApi, SshConnectParams, SshProxyJumpConfig, SshSessionInfo, SftpApi, LocalFsApi, SecureStorageApi, RecordingsApi, RecordingMeta, RemoteFileInfo, LocalFileInfo, SftpProgress, SshForwardType, SshForwardSpec, SshForwardStatus } from "../../electron/preload";

declare global {
  interface Window {
    ssh: SshApi;
    termAI: WinApi;
    localTerminal: LocalTerminalApi;
    clipboard: { writeText: (text: string) => void; readText: () => string };
    sftp: SftpApi;
    localFs: LocalFsApi;
    secureStorage: SecureStorageApi;
    recordings: RecordingsApi;
    __termai_debug?: { ping: () => Promise<string> };
  }
}

export type { SshConnectParams, SshProxyJumpConfig, SshSessionInfo, RemoteFileInfo, LocalFileInfo, SftpProgress, SshForwardType, SshForwardSpec, SshForwardStatus, RecordingMeta };

// 持久化在 HostConfig 上的转发配置（enabled 控制连接后是否自动恢复）
export interface SshForwardConfig {
  id: string;
  type: SshForwardType;
  localAddress?: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  enabled: boolean;
}

export interface HostConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "privateKey";
  password?: string;
  privateKey?: string;
  passphrase?: string;
  tags?: string[];
  group?: string;
  createdAt: number;
  updatedAt: number;
  // 端口转发配置，连接建立后自动恢复 enabled 的项
  forwards?: SshForwardConfig[];
  // 跳板机：引用其他已配置的主机作为 ProxyJump（多跳场景）
  proxyJumpHostId?: string;
}

export interface AIMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  // 解析出的命令卡片
  commands?: ParsedCommand[];
}

export interface ParsedCommand {
  id: string;
  command: string;
  language: string;
  description?: string;
  riskLevel: "none" | "low" | "medium" | "high" | "critical";
}

export interface AIProviderConfig {
  provider: "openai" | "anthropic" | "custom";
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  // 自动分析终端报错：终端输出出现错误关键词时自动唤起 AI 分析
  autoAnalyze?: boolean;
}

export interface TerminalSessionState {
  id: string;
  hostId?: string;
  hostName: string;
  host: string;
  username: string;
  connected: boolean;
  status: "idle" | "connecting" | "connected" | "reconnecting" | "disconnected" | "error";
  errorMsg?: string;
  history: string[]; // 用户执行过的命令
  recentOutput: string[]; // 最近 100 行输出
  startTime?: number;
}
