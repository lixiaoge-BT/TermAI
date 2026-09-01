import { promises as fs, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { platform, homedir } from "node:os";

export interface LocalFileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifyTime: number;
}

export interface LocalFsManager {
  listDir: (path: string) => Promise<LocalFileInfo[]>;
  listRoots: () => Promise<string[]>;
  getDesktopPath: () => Promise<string>;
  mkdir: (path: string) => Promise<void>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
}

// 路径拼接（跨平台）
function joinPath(base: string, name: string): string {
  return join(base, name);
}

export function createLocalFsManager(): LocalFsManager {
  const listDir = async (path: string): Promise<LocalFileInfo[]> => {
    const entries = await fs.readdir(path, { withFileTypes: true });
    const infos = await Promise.all(
      entries
        .filter((e) => e.name !== "." && e.name !== "..")
        .map(async (e) => {
          const full = joinPath(path, e.name);
          let size = 0;
          let modifyTime = 0;
          try {
            const st = await fs.lstat(full);
            size = st.size;
            modifyTime = st.mtimeMs;
          } catch {
            // 无权限或丢失，使用 0
          }
          return {
            name: e.name,
            path: full,
            isDirectory: e.isDirectory(),
            size,
            modifyTime,
          } as LocalFileInfo;
        })
    );
    infos.sort(
      (a, b) =>
        Number(b.isDirectory) - Number(a.isDirectory) ||
        a.name.localeCompare(b.name, "zh")
    );
    return infos;
  };

  const listRoots = async (): Promise<string[]> => {
    if (platform() === "win32") {
      const roots: string[] = [];
      const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      for (const l of letters) {
        const drive = `${l}:\\`;
        try {
          const st = statSync(drive);
          if (st) roots.push(drive);
        } catch {
          // 驱动器不存在或不可访问
        }
      }
      return roots.length ? roots : ["C:\\"];
    }
    if (platform() === "darwin") {
      return ["/"];
    }
    return ["/"];
  };

  const getDesktopPath = async (): Promise<string> => {
    return join(homedir(), "Desktop");
  };

  const mkdir = async (path: string): Promise<void> => {
    await fs.mkdir(path, { recursive: true });
  };

  const rename = async (oldPath: string, newPath: string): Promise<void> => {
    await fs.rename(oldPath, newPath);
  };

  // fs.rm 支持递归删除目录与文件
  const remove = async (path: string): Promise<void> => {
    await fs.rm(path, { recursive: true, force: true });
  };

  return { listDir, listRoots, getDesktopPath, mkdir, rename, remove };
}

export { joinPath, dirname };
