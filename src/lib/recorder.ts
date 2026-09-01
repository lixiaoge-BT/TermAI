// =====================================================
// 操作记录器（渲染进程，内存态）
// -----------------------------------------------------
// 以「命令」为单位的操作记录：用户每在终端提交一条命令，即生成一个
// 操作节点，记录该命令文本及其产生的输出。停止录制时序列化为结构化
// JSON（操作日志），供「操作记录查看器」以图标时间线呈现。
// =====================================================

export interface RecordingSessionMeta {
  hostName?: string;
  host?: string;
  username?: string;
  mode?: "ssh" | "local";
}

/** 一条操作记录：用户提交的一个命令及其输出 */
export interface RecordedOperation {
  index: number;
  command: string; // 用户输入的命令（已清洗）
  output: string; // 该命令产生的输出（已清洗 ANSI）
  ts: number; // 相对录制开始的毫秒数
  durationMs: number; // 该操作耗时（到下一个命令/录制结束）
}

export interface StoppedRecording {
  operations: RecordedOperation[];
  meta: RecordingSessionMeta;
  duration: number; // 总时长（秒）
  truncated: boolean;
}

interface OpBuffer {
  command: string;
  output: string;
  startTs: number; // 相对录制开始的毫秒数
}

interface ActiveRecording {
  startedAt: number;
  operations: RecordedOperation[];
  current: OpBuffer | null;
  meta: RecordingSessionMeta;
  bytes: number;
  truncated: boolean;
}

// 上限保护：避免长时间挂机录制把内存吃满
const MAX_OPS = 5000;
const MAX_BYTES = 32 * 1024 * 1024; // 32MB

const active = new Map<string, ActiveRecording>();

/* eslint-disable no-control-regex */
// ANSI 转义码正则，用于清理终端输出生成可读文本
const ANSI_REGEX = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[=>]/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/** 清洗一段原始终端数据：去 ANSI + 统一换行，便于阅读与展示 */
function clean(raw: string): string {
  return stripAnsi(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function startRecording(
  sessionId: string,
  opts: { meta?: RecordingSessionMeta } = {}
): void {
  if (active.has(sessionId)) return;
  active.set(sessionId, {
    startedAt: performance.now(),
    operations: [],
    current: null,
    meta: opts.meta ?? {},
    bytes: 0,
    truncated: false,
  });
}

/**
 * 提交一条命令（用户输入回车时调用），结束上一个操作的收集、开启新操作。
 * 仅在录制中生效；空命令（空白/以空格开头的续行）会被忽略。
 */
export function commitOperation(sessionId: string, rawCommand: string): void {
  const rec = active.get(sessionId);
  if (!rec) return;
  const cmd = clean(rawCommand).trim();
  if (!cmd) return;

  const now = performance.now();
  if (rec.current) {
    finalizeCurrent(rec, now);
  }
  rec.current = {
    command: cmd,
    output: "",
    startTs: now - rec.startedAt,
  };
}

function finalizeCurrent(rec: ActiveRecording, now: number) {
  const cur = rec.current;
  if (!cur) return;
  rec.operations.push({
    index: rec.operations.length + 1,
    command: cur.command,
    output: clean(cur.output),
    ts: cur.startTs,
    durationMs: Math.max(0, now - rec.startedAt - cur.startTs),
  });
  rec.current = null;
}

/** 记录一段原始输出，归入「当前操作」。返回 false 表示已因超限自动停止。 */
export function recordOutput(sessionId: string, data: string): boolean {
  const rec = active.get(sessionId);
  if (!rec || !data) return false;
  // 还没有提交过任何命令（录制前的序幕输出）直接丢弃，不计入操作
  if (!rec.current) return false;

  rec.current.output += data;
  rec.bytes += data.length;

  if (rec.operations.length > MAX_OPS || rec.bytes > MAX_BYTES) {
    rec.truncated = true;
    active.delete(sessionId);
    return false;
  }
  return true;
}

export function isRecording(sessionId: string): boolean {
  return active.has(sessionId);
}

/** 已录制时长（秒） */
export function getElapsed(sessionId: string): number {
  const rec = active.get(sessionId);
  if (!rec) return 0;
  return (performance.now() - rec.startedAt) / 1000;
}

/** 停止录制并返回结构化操作记录；未在该会话录制时返回 null */
export function stopRecording(sessionId: string): StoppedRecording | null {
  const rec = active.get(sessionId);
  if (!rec) return null;
  const now = performance.now();
  // 收尾：把最后一个未结束的操作也落盘
  if (rec.current) finalizeCurrent(rec, now);
  active.delete(sessionId);

  const durationSec = (now - rec.startedAt) / 1000;
  return {
    operations: rec.operations,
    meta: rec.meta,
    duration: durationSec,
    truncated: rec.truncated,
  };
}

/** 丢弃某会话的录制（不落盘） */
export function discardRecording(sessionId: string): void {
  active.delete(sessionId);
}

/** 停掉所有会话的录制并返回各自的结构化记录（例如窗口关闭前 / 停止时批量保存） */
export function stopAllRecordings(): StoppedRecording[] {
  const now = performance.now();
  const result: StoppedRecording[] = [];
  for (const rec of active.values()) {
    if (rec.current) finalizeCurrent(rec, now);
    result.push({
      operations: rec.operations,
      meta: rec.meta,
      duration: (now - rec.startedAt) / 1000,
      truncated: rec.truncated,
    });
  }
  active.clear();
  return result;
}

/** 格式化秒数为 mm:ss / hh:mm:ss */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 把结构化操作记录序列化为落盘 JSON 文本 */
export function serializeOperations(rec: StoppedRecording): string {
  const startedAtMs = Date.now() - rec.duration * 1000;
  const payload = {
    app: "TermAI",
    version: 1,
    type: "operation-log",
    meta: rec.meta,
    startedAt: new Date(startedAtMs).toISOString(),
    durationSec: rec.duration,
    truncated: rec.truncated,
    operations: rec.operations,
  };
  return JSON.stringify(payload, null, 2);
}
