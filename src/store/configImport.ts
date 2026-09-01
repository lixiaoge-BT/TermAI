import type { HostConfig } from "@/types";

export interface HostsBackup {
  version: 1;
  exportedAt: number;
  hosts: HostConfig[];
  hostGroups: string[];
}

/** 校验单个主机对象，非法返回 null（不抛错，便于批量导入时跳过坏数据）。 */
export function validateHost(raw: unknown): HostConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return null;
  if (typeof o.name !== "string" || !o.name) return null;
  if (typeof o.host !== "string" || !o.host) return null;
  if (o.port !== undefined && typeof o.port !== "number") return null;
  if (o.username !== undefined && typeof o.username !== "string") return null;
  if (
    o.authMethod !== undefined &&
    o.authMethod !== "password" &&
    o.authMethod !== "privateKey"
  ) {
    return null;
  }
  const now = Date.now();
  const host: HostConfig = {
    id: o.id,
    name: o.name,
    host: o.host,
    port: typeof o.port === "number" ? o.port : 22,
    username: typeof o.username === "string" ? o.username : "root",
    authMethod: o.authMethod === "privateKey" ? "privateKey" : "password",
    password: typeof o.password === "string" ? o.password : undefined,
    privateKey: typeof o.privateKey === "string" ? o.privateKey : undefined,
    passphrase: typeof o.passphrase === "string" ? o.passphrase : undefined,
    tags: Array.isArray(o.tags) ? (o.tags.filter((t) => typeof t === "string") as string[]) : [],
    group: typeof o.group === "string" ? o.group : undefined,
    createdAt: typeof o.createdAt === "number" ? o.createdAt : now,
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : now,
    forwards: Array.isArray(o.forwards) ? (o.forwards as HostConfig["forwards"]) : undefined,
    proxyJumpHostId:
      typeof o.proxyJumpHostId === "string" ? o.proxyJumpHostId : undefined,
  };
  return host;
}

/**
 * 解析并校验主机备份 JSON 文本。
 * 返回合法的 hosts 与 hostGroups；非法字段被静默跳过，不抛错。
 * 解析失败（非 JSON / 结构不符）抛出 Error。
 */
export function parseHostsBackup(json: string): HostsBackup {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("文件不是合法的 JSON");
  }
  if (!data || typeof data !== "object") {
    throw new Error("备份文件结构不正确");
  }
  const o = data as Record<string, unknown>;
  if (!Array.isArray(o.hosts)) {
    throw new Error("备份文件缺少 hosts 数组");
  }
  const hosts = o.hosts
    .map((h) => validateHost(h))
    .filter((h): h is HostConfig => h !== null);
  const hostGroups = Array.isArray(o.hostGroups)
    ? (o.hostGroups.filter((g) => typeof g === "string") as string[])
    : [];
  return {
    version: 1,
    exportedAt: typeof o.exportedAt === "number" ? o.exportedAt : Date.now(),
    hosts,
    hostGroups,
  };
}
