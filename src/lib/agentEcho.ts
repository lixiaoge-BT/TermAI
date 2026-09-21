// =====================================================
// Agent 命令的哨兵回显过滤（只作用于「显示」，绝不碰原始流）
// -----------------------------------------------------
// execCommand 会把命令包成下面这样再写进远端 shell：
//
//   echo "TERMAI_BEGIN_<token>"; <命令> 2>&1; echo "TERMAI_EXIT_<token>:$?"; echo "TERMAI_END_<token>"
//
// 远端 PTY 会把这一整行**原样回显**，然后再打印三条哨兵输出。于是用户的终端窗口
// 里每条命令都会多出 4 行与任务无关的噪声（用户实测反馈）。
//
// 两段式处理：
//   ① 回显区间抑制 —— 从命令回显那一行开始，整段丢弃，直到 BEGIN 哨兵**独立成行**
//      的输出出现为止。之所以用「区间」而不是「按行匹配」：bash/readline 在命令行
//      超过终端宽度时会**在回显中间插入换行**，按行匹配会漏出半截命令碎片。
//   ② 行过滤 —— 区间之后的真实输出里，只剩 EXIT / END 两条哨兵输出行要剔掉。
//
// 额外处理：回显区间被抑制后，用户终端里就**看不到实际执行的命令**了。因此窗口开启时
// 可携带一条「展示命令」，在 BEGIN 哨兵出现后、真实输出之前，按 `$ <命令>\r\n` 的
// 形式补回终端显示。它只影响视觉，不改变原始数据流与 Agent 的观察结果。
//
// 过滤按「精确 token + 生效窗口」工作：只有 execCommand 正在执行的那一刻注册进来的
// 那几条串才会被处理。因此用户自己手敲的命令、命令自身的真实输出都不会被动；即使
// 用户手动敲 `echo "TERMAI_BEGIN_x"`（窗口未生效）也照样正常显示。
//
// ⚠️ 绝对不能拿它过滤 emitTerminalOutput 的原始流：execCommand 正是靠那一路数据
// 收集 buffer、切分哨兵来判断「命令结束」和取退出码。过滤掉就再也判不出结束，
// 慢命令只能拿到残缺输出，还会被上层 isOk() 当成执行成功。
// 同理，recordOutput（回放录制）也保留原始数据，回放要还原真实过程。
// =====================================================

/** 一次 Agent 命令用到的三条哨兵（token 全局唯一，故可按精确子串匹配） */
export interface AgentEchoTags {
  begin: string;
  exitTag: string;
  end: string;
}

/** 所有哨兵共用的前缀；用于识别「被数据包从中间截断」的哨兵行 */
const TAG_PREFIX = "TERMAI_";
/** heredoc 临时脚本模式的边界标记，同样不该出现在展示里 */
const HEREDOC_MARK = "TERMAI_AGENT_EOF";
/** 回显区间的最长等待（毫秒）。BEGIN 是 shell 执行 echo 的输出，正常情况下必然到达；
 *  超时说明脚本压根没跑起来（连接卡死等），此时放弃抑制，避免把输出整段吞掉。 */
const ECHO_WINDOW_MS = 2000;

interface EchoState {
  tags: AgentEchoTags;
  /** 要补回终端显示的命令文本（可选）。多行命令会被折叠成单行显示，避免把终端刷乱。 */
  command?: string;
  /** BEGIN 哨兵（独立成行的那条输出）是否已经出现 —— 出现即代表回显区间结束 */
  sawBegin: boolean;
  /** BEGIN 行的换行恰好被数据包切走，下一包开头要顺手吃掉那个换行 */
  skipLeadingNewline: boolean;
  /** 未换行的尾行暂存：EXIT / END 行可能被数据包切在两段里 */
  carry: string;
  /** 回显区间的截止时间戳 */
  deadline: number;
  /** 「独立成行的 BEGIN 输出」匹配器，注册时构建一次 */
  beginLineRe: RegExp;
}

const states = new Map<string, EchoState>();

/** 单行展示命令的最大长度；超出则截断加省略号 */
const MAX_COMMAND_DISPLAY_LEN = 240;

function formatDisplayCommand(cmd: string | undefined): string {
  if (!cmd) return "";
  // 把多行命令折叠成单行显示：终端显示不需要完整脚本，关键是让用户知道"执行了哪条"
  const oneLine = cmd
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!oneLine) return "";
  if (oneLine.length <= MAX_COMMAND_DISPLAY_LEN) return oneLine;
  return oneLine.slice(0, MAX_COMMAND_DISPLAY_LEN - 1) + "…";
}

/** execCommand 下发命令前调用：开启本会话的哨兵过滤窗口 */
export function beginAgentEchoFilter(
  sessionId: string,
  tags: AgentEchoTags,
  command?: string
): void {
  states.set(sessionId, {
    tags,
    command: formatDisplayCommand(command),
    sawBegin: false,
    skipLeadingNewline: false,
    carry: "",
    deadline: Date.now() + ECHO_WINDOW_MS,
    // 要求 BEGIN 落在行首：回显行里的 `echo "TERMAI_BEGIN_xxx"` 前面是 `echo "`，
    // 不会被误判成哨兵输出；而 readline 换行插入的边界也有同样的前提保护。
    beginLineRe: new RegExp(`(?:^|\\r?\\n)${tags.begin}(?:\\r?\\n)?`),
  });
}

/** execCommand 收尾时调用：关闭窗口，恢复原样透传 */
export function endAgentEchoFilter(sessionId: string): void {
  states.delete(sessionId);
}

/** 整行删除（保留原始换行符，避免把 \r\n 归一成 \n —— 那会让光标不换行、排版错乱） */
function stripAgentLines(text: string, tags: AgentEchoTags): string {
  if (!text) return "";
  return text.replace(/[^\r\n]*(?:\r\n|\n|\r|$)/g, (line) =>
    line.includes(tags.exitTag) ||
    line.includes(tags.end) ||
    line.includes(HEREDOC_MARK)
      ? ""
      : line
  );
}

/** 尾行是否可能是「被数据包截断的哨兵行」 */
function looksLikeCutMarker(tail: string): boolean {
  if (!tail) return false;
  if (tail.includes(TAG_PREFIX)) return true;
  // 极端边界：包正好切在 "TERMAI_" 这 7 个字符中间（至少 3 个字符才算，避免把
  // 正常输出里以 T / TE 结尾的行无谓地扣一包）
  for (let n = Math.min(TAG_PREFIX.length - 1, tail.length); n >= 3; n--) {
    if (tail.endsWith(TAG_PREFIX.slice(0, n))) return true;
  }
  return false;
}

/**
 * 终端显示/上下文用的过滤：剔除 Agent 哨兵包装行，其余原样返回。
 * 窗口未生效时是零开销的透传（直接返回入参，引用相等，调用方可据此省掉二次清理）。
 */
export function filterAgentEchoForDisplay(sessionId: string, data: string): string {
  const st = states.get(sessionId);
  if (!st) return data;

  let buf = st.carry + data;
  st.carry = "";
  if (st.skipLeadingNewline) {
    buf = buf.replace(/^\r?\n/, "");
    st.skipLeadingNewline = false;
  }

  // ① 回显区间：整段丢弃，直到 BEGIN 哨兵独立成行地出现
  if (!st.sawBegin) {
    const m = st.beginLineRe.exec(buf);
    if (m) {
      st.sawBegin = true;
      // 换行被包边界切走时，留个标记让下一包吃掉它，避免多出一个空行
      if (!m[0].endsWith("\n")) st.skipLeadingNewline = true;
      // 回显区间里「BEGIN 前的那个换行」是提示符行的**行尾**（上一条命令结束后
      // shell 打印提示符，光标停在提示符后，我们下发的脚本回显在其后）。整段丢弃
      // 会连这个换行一起吃掉 —— 后续输出（命令无输出时则是**下一条提示符**）
      // 就贴在旧提示符同一行，终端上表现为「提示符成对出现」。
      // 因为屏幕上的提示符仍然保留，这里直接把展示命令补在提示符后面，让它看起来
      // 就像用户手动输入的一样；如果没有展示命令，则只补回一个换行，确保真实输出
      // （或下一条提示符）从新行开始。
      const displayCmd = st.command;
      const cmdLine = displayCmd ? `${displayCmd}\r\n` : "\r\n";
      buf = cmdLine + buf.slice(m.index + m[0].length);
    } else if (Date.now() < st.deadline) {
      return "";
    } else {
      // 超时兜底：脚本没能跑起来，放弃区间抑制，按行过滤保底
      st.sawBegin = true;
    }
  }

  // ② 区间之后：只剩 EXIT / END 两条哨兵输出行要剔掉
  const tailStart = Math.max(buf.lastIndexOf("\n"), buf.lastIndexOf("\r")) + 1;
  const tail = buf.slice(tailStart);
  if (looksLikeCutMarker(tail)) {
    st.carry = tail;
    return stripAgentLines(buf.slice(0, tailStart), st.tags);
  }
  return stripAgentLines(buf, st.tags);
}
