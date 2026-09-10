import { app, shell } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// =====================================================
// 操作记录存储管理器（主进程）
// -----------------------------------------------------
// 操作记录以 JSON (.json) 格式存放在 userData/recordings 下，
// 文件内含会话元信息与「命令 + 输出」操作数组，供查看器以图标时间线呈现。
// =====================================================

export interface RecordingMeta {
  id: string;
  name: string;
  path: string;
  size: number;
  createdAt: number; // 文件 mtime（毫秒）
  duration: number; // 秒
  width: number;
  height: number;
  type?: string; // 记录类型，如 "operation-log"
  title?: string;
}

export interface RecordingsManager {
  getDir: () => string;
  save: (input: { name: string; content: string; duration?: number }) => Promise<RecordingMeta>;
  list: () => Promise<RecordingMeta[]>;
  read: (id: string) => Promise<string>;
  remove: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<RecordingMeta>;
  openDir: () => Promise<void>;
}

/**
 * 把展示名写进记录 JSON 的顶层 name 字段。
 * 内容不是合法 JSON 时原样返回，避免因改名/保存损坏已有记录。
 */
function withStoredName(content: string, name?: string): string {
  if (!name) return content;
  try {
    const data = JSON.parse(content) as Record<string, unknown>;
    if (typeof data !== "object" || data === null) return content;
    data.name = name;
    return JSON.stringify(data);
  } catch {
    return content;
  }
}

export function createRecordingsManager(): RecordingsManager {
  const dir = join(app.getPath("userData"), "recordings");

  const ensureDir = async () => {
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  const filePathOf = (id: string) => {
    // id 只允许文件名字符，避免路径穿越
    const safe = id.replace(/[^a-zA-Z0-9._-]/g, "");
    if (!safe.endsWith(".json")) return null;
    return join(dir, safe);
  };

  /**
   * 读取操作记录文件的元信息。
   * 时长优先使用保存时传入的 duration；未传入时尝试从 JSON 的
   * durationSec 解析，再无法解析则返回 0。
   */
  const readMeta = async (filePath: string, id: string): Promise<RecordingMeta> => {
    const stat = await fs.stat(filePath);
    let duration = 0;
    let title: string | undefined;
    let type: string | undefined;
    let nameOverride: string | undefined;

    try {
      const raw = await fs.readFile(filePath, "utf8");
      const data = JSON.parse(raw);
      if (typeof data?.durationSec === "number") duration = data.durationSec;
      if (typeof data?.type === "string") type = data.type;
      // 用户改过的展示名存在 JSON 的 name 字段里；没有则回退为文件名
      if (typeof data?.name === "string" && data.name.trim()) nameOverride = data.name;
      // 标题优先用会话名，其次用第一条命令
      const meta = data?.meta ?? {};
      title = meta.hostName || meta.host;
      if (!title && Array.isArray(data?.operations) && data.operations[0]) {
        title = data.operations[0].command?.slice(0, 40);
      }
    } catch {
      /* 忽略读取/解析错误，使用默认值 */
    }

    return {
      id,
      name: nameOverride || id.replace(/\.json$/, ""),
      path: filePath,
      size: stat.size,
      createdAt: stat.mtimeMs,
      duration,
      width: 0,
      height: 0,
      type,
      title,
    };
  };

  const getDir = () => dir;

  const save = async (input: {
    name: string;
    content: string;
    duration?: number;
  }): Promise<RecordingMeta> => {
    await ensureDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const id = `rec-${stamp}-${randomUUID().slice(0, 8)}.json`;
    const filePath = join(dir, id);
    const displayName = input.name?.trim();
    await fs.writeFile(filePath, withStoredName(input.content, displayName), "utf8");
    const meta = await readMeta(filePath, id);
    // 用传入的名称覆盖自动 id 名（列表展示用）
    return {
      ...meta,
      name: input.name?.trim() || meta.name,
      duration: input.duration ?? meta.duration,
    };
  };

  const list = async (): Promise<RecordingMeta[]> => {
    await ensureDir();
    const names = await fs.readdir(dir);
    const jsons = names.filter((n) => n.endsWith(".json"));
    const metas = await Promise.all(
      jsons.map(async (id) => {
        try {
          return await readMeta(join(dir, id), id);
        } catch {
          return null;
        }
      })
    );
    return metas
      .filter((m): m is RecordingMeta => m !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  };

  const read = async (id: string): Promise<string> => {
    const filePath = filePathOf(id);
    if (!filePath) throw new Error("非法的记录文件名");
    return fs.readFile(filePath, "utf8");
  };

  const remove = async (id: string): Promise<void> => {
    const filePath = filePathOf(id);
    if (!filePath) throw new Error("非法的记录文件名");
    await fs.unlink(filePath);
  };

  const rename = async (id: string, name: string): Promise<RecordingMeta> => {
    const filePath = filePathOf(id);
    if (!filePath) throw new Error("非法的记录文件名");
    const trimmed = name?.trim();
    if (!trimmed) throw new Error("名称不能为空");
    // 展示名必须落盘：list() 走 readMeta 从文件内容重建 name，
    // 只改内存里的对象会在下次刷新时被文件名重新推导覆盖掉。
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
      if (typeof data !== "object" || data === null) data = {};
    } catch {
      // 文件内容不是合法 JSON（老数据 / 损坏）：保留原内容结构，只补一个 name 字段
      data = {};
    }
    data.name = trimmed;
    await fs.writeFile(filePath, JSON.stringify(data), "utf8");
    const meta = await readMeta(filePath, id);
    return { ...meta, name: trimmed };
  };

  const openDir = async (): Promise<void> => {
    await ensureDir();
    await shell.openPath(dir);
  };

  return { getDir, save, list, read, remove, rename, openDir };
}
