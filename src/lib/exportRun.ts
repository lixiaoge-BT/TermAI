// =====================================================
// 导出装配（渲染层）
// -----------------------------------------------------
// 纯函数负责「把一次任务变成一组文件内容」，IO 只发生在最后一个函数里。
// 这样导出格式可以单测，不需要真的弹对话框。
//
// 为什么不在主进程生成 HTML：主进程用的是独立编译产物（dist-electron），
// 引不到 src/lib 里的类型与函数；让它重复实现一套渲染逻辑才是真的隐患。
//
// 导出固定为三份文件（同一份内容，三种格式）：
//   report.html  阅读用，命令输出默认折叠
//   report.md    进 Wiki / Issue / Git 仓库
//   report.docx  进 Word 交付、批注
// 不再附带 CSV 与 outputs/*.log —— 完整输出直接内联进这三份文件。
// =====================================================

import { buildReportHtml, buildReportMarkdown, type ExportableStep } from "./agentExport";
import { buildReportDocx } from "./docx";

export interface ExportRunInput {
  goal: string;
  plan?: string;
  summary: string;
  steps: ExportableStep[];
  host?: string;
  /** SSH 显示名（用户配的主机名），优先用于目录名 */
  hostName?: string;
  user?: string;
  startedAt?: number;
  finishedAt?: number;
  metricsLine?: string;
  /** 运行记录 id：有它才能从主进程取回完整输出 */
  runId?: string;
  /**
   * 完整输出：key 是 `001-1.log` 形态的文件名。
   *
   * 由 `exportAgentRun` 从主进程读回来填入；缺省时正文里用界面的截断片段，
   * 并在文件里如实标注「已截断」。
   */
  fullOutputs?: Record<string, string>;
}

export interface ExportFileContent {
  path: string;
  /** utf8 文本内容；encoding 为 base64 时是二进制内容的 base64 */
  content: string;
  encoding?: "base64";
}

export interface ExportBundle {
  defaultName: string;
  files: ExportFileContent[];
  runId?: string;
}

/**
 * 完整输出的文件名。
 *
 * **必须与 electron/main/agentRuns.ts 里的命名严格一致**（`${pad3}-${i+1}.log`），
 * 否则取回全文时 key 对不上，导出的正文会一直是截断片段。
 */
export function outputFileName(stepIndex: number, itemIndex: number): string {
  return `${String(stepIndex).padStart(3, "0")}-${itemIndex + 1}.log`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 导出目录名：`termai-20261104-1530-192.168.188.128`。
 *
 * 带时间戳是为了「同一天导两次」不会互相覆盖；带主机名是为了把几台机器的
 * 报告放在同一个文件夹里也能一眼分清。非法字符在这里就清洗掉，
 * 主进程还会再洗一次（防御两端都可能被直接调用）。
 */
export function runFolderName(host: string | undefined, startedAt: number): string {
  const d = new Date(startedAt || Date.now());
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}`;
  const hostPart = String(host ?? "")
    .replace(/[:*?"<>|\\/\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return hostPart ? `termai-${stamp}-${hostPart}` : `termai-${stamp}`;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Uint8Array → base64。
 *
 * 为什么不让 IPC 直接传 Uint8Array：二进制经过 contextBridge / IPC 的序列化链
 * 容易在不同 Electron 版本上出现「变成普通对象」的问题，而 base64 字符串是
 * 100% 安全的。体积代价 33%，docx 只有几百 KB，完全可以接受。
 */
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    parts.push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    parts.push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==");
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    parts.push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=");
  }
  return parts.join("");
}

/**
 * 用完整输出替换界面里的截断片段。
 *
 * 只替换「确实更长」的那份：任务还没结束就导出时日志可能只写了一半，
 * 拿半截覆盖已显示内容反而更糟。
 */
function mergeFullOutputs(
  steps: ExportableStep[],
  fullOutputs: Record<string, string> | undefined
): ExportableStep[] {
  if (!fullOutputs) return steps;
  return steps.map((step) => ({
    ...step,
    items: step.items.map((it, i) => {
      const full = fullOutputs[outputFileName(step.index, i)];
      if (!full || full.length <= (it.output?.length ?? 0)) return it;
      return { ...it, output: full, fullOutput: true };
    }),
  }));
}

/**
 * 组装导出内容（固定三份：html / md / docx）。
 */
export function buildExportBundle(input: ExportRunInput): ExportBundle {
  const startedAt = input.startedAt || Date.now();
  const steps = mergeFullOutputs(input.steps, input.fullOutputs);

  const report = {
    goal: input.goal,
    plan: input.plan,
    summary: input.summary,
    steps,
    host: input.host,
    user: input.user,
    startedAt,
    finishedAt: input.finishedAt,
    metricsLine: input.metricsLine,
  };

  const files: ExportFileContent[] = [
    { path: "report.html", content: buildReportHtml(report) },
    { path: "report.md", content: buildReportMarkdown(report) },
    { path: "report.docx", content: toBase64(buildReportDocx(report)), encoding: "base64" },
  ];

  return {
    defaultName: runFolderName(input.hostName || input.host, startedAt),
    files,
    runId: input.runId,
  };
}

export interface ExportOutcome {
  ok: boolean;
  dir?: string;
  canceled?: boolean;
  error?: string;
  /** 生成的文件数（固定为 3） */
  fileCount?: number;
}

/**
 * 弹原生目录选择框并落盘。
 *
 * 调用前先向主进程取回完整输出，否则导出的只是界面里 4000 字的片段。
 */
export async function exportAgentRun(input: ExportRunInput): Promise<ExportOutcome> {
  const api = typeof window !== "undefined" ? window.agentRun : undefined;
  if (!api) {
    return { ok: false, error: "当前环境不支持导出（需要在桌面应用里使用）" };
  }

  let fullOutputs: Record<string, string> = {};
  if (input.runId && api.readOutputs) {
    try {
      fullOutputs = (await api.readOutputs(input.runId)) ?? {};
    } catch {
      fullOutputs = {};
    }
  }

  const bundle = buildExportBundle({ ...input, fullOutputs });

  try {
    const res = await api.save({
      defaultName: bundle.defaultName,
      files: bundle.files,
      runId: bundle.runId,
    });
    return {
      ok: res.ok,
      dir: res.dir,
      canceled: res.canceled,
      error: res.error,
      fileCount: res.fileCount ?? bundle.files.length,
    };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}
