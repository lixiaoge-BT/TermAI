import { app, dialog, BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import { join, resolve, sep, dirname } from "node:path";

// =====================================================
// Agent 任务运行记录（主进程）
// -----------------------------------------------------
// 为什么要有这个东西：Agent 的 buckets 只活在渲染进程内存里，关掉应用就全没了；
// 而且 store 里每条命令的输出被 capOutput 砍到 4000 字符。想让用户「导出完整
// 输出」，就必须在截断**之前**把原始文本落到磁盘上 —— 这是本模块存在的唯一理由。
//
// 目录结构（放在 userData 下，不进用户可见目录，避免污染）：
//   userData/agent-runs/<runId>/
//   ├─ manifest.json            目标 / 主机 / 每条命令的元数据
//   └─ outputs/003-2.log        第 3 步第 2 条命令的完整输出
//
// 导出走 exportRun：弹原生「选目录」，在目录下建 termai-<时间>-<主机>/ 子目录，
// 写入 report.html / ledger.csv / tables/*.csv，并把 outputs/*.log 原样复制过去。
// =====================================================

/** 单条命令输出的落盘上限：一条 journalctl 能吐几十 MB，全存会把磁盘吃干净 */
const MAX_LOG_BYTES = 2 * 1024 * 1024;
/** 单次任务的总量上限：超过后停止落盘并在 manifest 里标记，导出时如实提示 */
const MAX_RUN_BYTES = 200 * 1024 * 1024;
/** 保留最近多少次任务（更老的自动清理，避免长期使用无限增长） */
const KEEP_RUNS = 20;
/**
 * 导出时内联进报告的完整输出总量上限。
 *
 * 完整输出要经过一次 IPC 进渲染进程再拼进 html/md/docx，全量读取会让面板卡死；
 * 超出部分退回界面片段并标注「已截断」，用户仍然能知道发生了什么。
 */
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

export interface AgentRunMeta {
  runId: string;
  sessionId?: string;
  goal: string;
  host?: string;
  user?: string;
  startedAt: number;
}

export interface AgentRunCommandMeta {
  /** 落盘文件名（outputs 下），没落盘时为空 */
  file?: string;
  command: string;
  risk: string;
  status: string;
  exitCode: number | null;
  timedOut: boolean;
  bytes?: number;
  /** 因超限没落盘时的原因 */
  skipped?: string;
}

export interface AgentRunManifest extends AgentRunMeta {
  finishedAt?: number;
  summary?: string;
  stepCount?: number;
  totalBytes?: number;
  /** 本次任务有输出因超限未完整保存 */
  truncated?: boolean;
  commands?: AgentRunCommandMeta[];
}

export interface ExportFile {
  /** 相对导出目录的路径，允许 a/b.txt */
  path: string;
  /** utf8 文本；encoding 为 base64 时是二进制内容的 base64 串 */
  content: string;
  encoding?: "base64";
}

export interface ExportInput {
  /** 导出目录名（已清洗） */
  defaultName: string;
  files: ExportFile[];
  /** 已废弃：导出不再附带 outputs/*.log，保留字段只为兼容旧渲染层 */
  runId?: string;
}

export interface ExportResult {
  ok: boolean;
  /** 最终写入的目录；取消时为 undefined */
  dir?: string;
  canceled?: boolean;
  error?: string;
  /** 实际写出的文件数 */
  fileCount?: number;
}

export interface AgentRunsManager {
  begin: (meta: AgentRunMeta) => Promise<{ runId: string; dir: string }>;
  append: (input: {
    runId: string;
    stepIndex: number;
    itemIndex: number;
    command: string;
    risk?: string;
    status?: string;
    exitCode?: number | null;
    timedOut?: boolean;
    content: string;
  }) => Promise<{ ok: boolean; file?: string; skipped?: string }>;
  finish: (patch: {
    runId: string;
    summary?: string;
    stepCount?: number;
    truncated?: boolean;
  }) => Promise<void>;
  dirOf: (runId: string) => string;
  /** 已成功落盘的输出文件名列表 */
  listOutputs: (runId: string) => Promise<string[]>;
  /**
   * 读回完整输出正文（文件名 → 内容）。
   *
   * 导出只有 html/md/docx 三种文件，完整输出必须内联进正文，所以要先取回全文。
   * 有总量上限：一次导出读几百 MB 进渲染进程会把面板卡死。
   */
  readOutputs: (runId: string) => Promise<Record<string, string>>;
  exportRun: (input: ExportInput, win?: BrowserWindow | null) => Promise<ExportResult>;
}

/** runId 只允许安全字符：它会成为目录名，绝不能带 `..` 或路径分隔符 */
function safeRunId(runId: string): string {
  const clean = String(runId ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  return clean || `run-${Date.now()}`;
}

/**
 * 导出目录名清洗。
 *
 * Windows 非法字符（`:*?"<>|`）会让 mkdir 直接失败；末尾的点/空格在 Windows 上
 * 会被静默裁剪，导致「按返回的路径去找文件找不到」。
 */
export function safeFolderName(name: string): string {
  const s = String(name ?? "")
    .replace(/[:*?"<>|\\/]/g, "-")
    // 控制字符 + Windows 保留字符（\p{Cc} 覆盖 0x00-0x1F 与 0x7F，比手写字符区间更稳）
    .replace(/[\p{Cc}]/gu, "")
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  return s || `termai-export-${Date.now()}`;
}

/** 相对路径校验：不允许绝对路径、盘符、`..` 穿越 */
function safeRelative(rel: string): string | null {
  const s = String(rel ?? "").replace(/\\/g, "/").trim();
  if (!s) return null;
  if (s.startsWith("/") || /^[a-zA-Z]:/.test(s)) return null;
  const parts = s.split("/").filter((p) => p && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) return null;
  return parts.join(sep);
}

export function createAgentRunsManager(): AgentRunsManager {
  // 惰性取路径：userData 在 app ready 之后才可靠，模块加载期不能碰
  const rootDir = () => join(app.getPath("userData"), "agent-runs");
  const dirOf = (runId: string) => join(rootDir(), safeRunId(runId));

  // 内存记账：避免每次 append 都去 stat 目录。进程重启后从 manifest 恢复，
  // 但重启后基本不会接着写同一个 run，所以够用。
  const runBytes = new Map<string, number>();

  /**
   * 同一个 run 的 append 必须串行。
   *
   * 批量探测时一个步骤里 5~6 条命令的输出几乎同时落盘（store 侧全是 fire-and-forget），
   * 而 manifest 是「读整个 JSON → push 一条 → 写回」，并发就会互相覆盖：
   * 文件本身没问题（各写各的），但 manifest 会丢掉几条命令的记录，
   * 事后查「为什么这条没完整输出」就查不到了。
   */
  const queues = new Map<string, Promise<unknown>>();
  const serialize = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = queues.get(key) ?? Promise.resolve();
    // then 的两个参数都传 fn：上一次失败也不能把这一条卡死
    const next = prev.then(fn, fn);
    queues.set(
      key,
      next.catch(() => {})
    );
    return next;
  };

  const writeManifest = async (dir: string, manifest: AgentRunManifest) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  };

  const readManifest = async (dir: string): Promise<AgentRunManifest | null> => {
    try {
      const text = await fs.readFile(join(dir, "manifest.json"), "utf8");
      return JSON.parse(text) as AgentRunManifest;
    } catch {
      return null;
    }
  };

  /** 只保留最近 KEEP_RUNS 次任务；清理失败不影响主流程 */
  const prune = async () => {
    try {
      const root = rootDir();
      const names = await fs.readdir(root);
      if (names.length <= KEEP_RUNS) return;
      const stats = await Promise.all(
        names.map(async (n) => {
          try {
            const st = await fs.stat(join(root, n));
            return { n, t: st.mtimeMs };
          } catch {
            return { n, t: 0 };
          }
        })
      );
      stats.sort((a, b) => b.t - a.t);
      for (const it of stats.slice(KEEP_RUNS)) {
        await fs.rm(join(root, it.n), { recursive: true, force: true }).catch(() => {});
      }
    } catch {
      /* 目录还不存在 / 被占用：忽略 */
    }
  };

  return {
    dirOf,

    listOutputs: async (runId) => {
      try {
        const names = await fs.readdir(join(dirOf(runId), "outputs"));
        return names.filter((n) => n.endsWith(".log"));
      } catch {
        return [];
      }
    },

    readOutputs: async (runId) => {
      const out: Record<string, string> = {};
      let total = 0;
      let names: string[] = [];
      try {
        names = (await fs.readdir(join(dirOf(runId), "outputs"))).filter((n) => n.endsWith(".log"));
      } catch {
        return out;
      }
      names.sort();
      for (const n of names) {
        if (total >= MAX_INLINE_BYTES) break;
        try {
          const text = await fs.readFile(join(dirOf(runId), "outputs", n), "utf8");
          out[n] = text;
          total += Buffer.byteLength(text, "utf8");
        } catch {
          /* 单个文件读失败就跳过，其余照常导出 */
        }
      }
      return out;
    },

    begin: async (meta) => {
      const id = safeRunId(meta.runId);
      const dir = join(rootDir(), id);
      runBytes.set(id, 0);
      await writeManifest(dir, { ...meta, runId: id, commands: [], totalBytes: 0 });
      void prune();
      return { runId: id, dir };
    },

    append: async (input) => {
      const id = safeRunId(input.runId);
      return serialize(id, async () => {
        const dir = join(rootDir(), id);
        const content = String(input.content ?? "");
        const bytes = Buffer.byteLength(content, "utf8");
        const used = runBytes.get(id) ?? 0;

        const manifest = (await readManifest(dir)) ?? null;
        if (!manifest) {
          // begin 没成功（比如磁盘不可写）时不要静默丢数据，直接报给调用方
          return { ok: false, skipped: "运行记录目录未初始化" };
        }

        // 超限时仍然记录元数据（命令本身要留痕），只是不写输出正文
        let skipped: string | undefined;
        if (bytes > MAX_LOG_BYTES) {
          skipped = `单条输出 ${(bytes / 1024 / 1024).toFixed(1)}MB 超过 2MB 上限`;
        } else if (used + bytes > MAX_RUN_BYTES) {
          skipped = `本次任务输出已达 ${Math.round(MAX_RUN_BYTES / 1024 / 1024)}MB 上限`;
        }

        const file = skipped
          ? undefined
          : `${String(input.stepIndex).padStart(3, "0")}-${input.itemIndex + 1}.log`;
        if (file) {
          try {
            await fs.mkdir(join(dir, "outputs"), { recursive: true });
            await fs.writeFile(join(dir, "outputs", file), content, "utf8");
            runBytes.set(id, used + bytes);
          } catch (e) {
            skipped = `写入失败：${(e as Error)?.message ?? String(e)}`;
          }
        }

        const commands = manifest.commands ?? [];
        commands.push({
          file,
          command: input.command,
          risk: input.risk ?? "",
          status: input.status ?? "",
          exitCode: input.exitCode ?? null,
          timedOut: Boolean(input.timedOut),
          bytes: file ? bytes : 0,
          skipped,
        });
        await writeManifest(dir, {
          ...manifest,
          commands,
          totalBytes: runBytes.get(id) ?? 0,
          truncated: manifest.truncated || Boolean(skipped),
        }).catch(() => {});

        return skipped && !file ? { ok: false, skipped } : { ok: true, file };
      });
    },

    finish: async (patch) => {
      const id = safeRunId(patch.runId);
      // 与 append 排同一条队：finish 也是「读 manifest → 改 → 写回」，
      // 不排队就会把最后几条命令的记录覆盖掉。
      return serialize(id, async () => {
        const dir = join(rootDir(), id);
        const manifest = await readManifest(dir);
        if (!manifest) return;
        await writeManifest(dir, {
          ...manifest,
          finishedAt: Date.now(),
          summary: patch.summary && patch.summary.slice(0, 200_000),
          stepCount: patch.stepCount,
          truncated: manifest.truncated || Boolean(patch.truncated),
        }).catch(() => {});
      });
    },

    exportRun: async (input, win) => {
      const folder = safeFolderName(input.defaultName);
      const options = {
        title: "选择导出位置",
        buttonLabel: "导出到此文件夹",
        properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
      };

      let picked: string | undefined;
      try {
        const res = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options);
        if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };
        picked = res.filePaths[0];
      } catch (e) {
        return { ok: false, error: `无法打开目录选择框：${(e as Error)?.message ?? String(e)}` };
      }

      // 同名目录已存在时加 -2 / -3，绝不覆盖用户已有的导出结果
      let target = resolve(picked, folder);
      for (let n = 2; n < 100; n++) {
        try {
          await fs.access(target);
          target = resolve(picked, `${folder}-${n}`);
        } catch {
          break;
        }
      }

      let fileCount = 0;
      try {
        for (const f of input.files ?? []) {
          const rel = safeRelative(f.path);
          if (!rel) continue;
          const full = join(target, rel);
          await fs.mkdir(dirname(full), { recursive: true });
          // base64 是二进制（docx）；其余按 utf8 文本写
          const data =
            f.encoding === "base64"
              ? Buffer.from(String(f.content ?? ""), "base64")
              : Buffer.from(String(f.content ?? ""), "utf8");
          await fs.writeFile(full, data);
          fileCount += 1;
        }
      } catch (e) {
        return {
          ok: false,
          dir: target,
          error: `写入失败：${(e as Error)?.message ?? String(e)}`,
        };
      }

      return { ok: true, dir: target, fileCount };
    },
  };
}
