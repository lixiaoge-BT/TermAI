// =====================================================
// Agent 执行引擎：把 AI 的决策真实下发到终端，并可靠取回输出
// -----------------------------------------------------
// 核心难点：终端是流式 PTY，没有「命令返回值」这回事。
// 这里用哨兵标记（sentinel）包裹命令，从数据流中精确切出
// 「本次命令的输出」与「退出码」，避免把回显、提示符混进来。
// =====================================================

import { subscribeTerminalOutput } from "@/lib/terminalBus";
import { beginAgentEchoFilter, endAgentEchoFilter, type AgentEchoTags } from "@/lib/agentEcho";
import {
  AGENT_RUN_START,
  AGENT_RUN_END,
  AGENT_DONE,
  AGENT_PLAN,
  AGENT_MAX_SUB_COMMANDS_PER_LINE,
} from "./prompts";
import { useTerminalStore } from "@/store/terminal";
import { redactSecrets } from "./safety";

export { AGENT_RUN_START, AGENT_RUN_END, AGENT_DONE };

export interface AgentReply {
  /** 命令/结论之前的思考说明 */
  thought: string;
  /**
   * 本次要执行的命令。批量探测时会有多条（彼此无依赖的只读命令），
   * 引擎按顺序全部执行后一次性回传，以此把多次 AI 往返压缩成一次。
   */
  commands: string[];
  /** 是否结束 */
  done: boolean;
  /** 结束时的最终总结 */
  finalAnswer: string | null;
  raw: string;
  /**
   * 非空表示本次回复是「计划声明」（<<<PLAN>>>）：run() 据此把它存为任务蓝图并继续，
   * 不会当作命令执行，也不会当作结束。
   */
  plan?: string;
  /**
   * 为真表示「回复里既无 <<<RUN>>> 也无 <<<DONE>>>，是兜底当作结束」——
   * run() 据此把模型的「过渡/解释」性裸文本与真正的任务完成区分开，
   * 避免模型在中间说一句「让我分析一下」就被误判任务结束。
   */
  noMarkerFallback?: boolean;
  /**
   * 「命令 + 结论」写在同一轮时，`<<<DONE>>>` 之后的正文。
   *
   * 这种形态在小模型上很常见：它一边发最后一条命令，一边就把结论写好了。
   * 旧实现直接丢弃命令、照收结论 —— 模型说「已清理完成」，实际一条都没跑，
   * 结论是凭空编的（探针实测 `RUN+DONE 同轮 → done=true, commands=[]`）。
   * 现在命令优先执行，这段正文降级为**待核对草稿**，run() 会提示模型对照真实输出
   * 重新确认后才允许结束。
   */
  deferredAnswer?: string;
  /**
   * 非空表示「命令不是按协议给的，被引擎归一化后补执行」：
   * - `fence`：模型把命令写在 ```bash 围栏里，没打 `<<<RUN>>>`
   * - `prefix`：模型用 `RUN: 命令` 的单行前缀
   * run() 据此在观察里补一句「下次请用协议标记」，把模型的输出习惯掰回来。
   */
  normalizedFrom?: "fence" | "prefix";
}

/**
 * 判断一段 shell 文本是否「结构未写完」—— 还需要后续行才能执行。
 *
 * 用途一：`splitCommandBlock` 用它把多行循环/条件**保成一整条命令**。
 * 用途二：准入闸门用它拦掉残缺命令 —— 把 `for x in *; do`（缺 done）单独下发，
 * 远端 shell 会停在续行提示符 `>` 上等输入，这一步要挂到硬超时（实测 300s）。
 *
 * 判据（任一成立即未写完）：
 *  - heredoc 开启了但终结符那一行还没出现；
 *  - 引号 / 反引号 / `(` 不平衡（含行尾 `\` 续行）；
 *  - 复合结构深度未归零：`do`↔`done`、`if`↔`fi`、`case`↔`esac`、`{`↔`}`；
 *  - 末行以 `&&` / `||` / `|` / `{` / `(` 收尾。
 *
 * 说明：`;` 收尾**不算**未写完（`ls;` 已经是完整命令）。
 */
export function shellIncomplete(text: string): boolean {
  if (!text.trim()) return false;
  const lines = text.split(/\r?\n/);

  // ① heredoc：开了就必须等到终结符单独成行
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (!m) continue;
    const term = m[1];
    if (!lines.slice(i + 1).some((l) => l.trim() === term)) return true;
  }

  // ② 引号 / 反引号 / 括号平衡（跳过反斜杠转义）
  let sq = 0;
  let dq = 0;
  let tick = 0;
  let paren = 0;
  let esc = false;
  for (const ch of text) {
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === "'" && dq === 0 && tick === 0) sq ^= 1;
    else if (ch === '"' && sq === 0 && tick === 0) dq ^= 1;
    else if (ch === "`" && sq === 0) tick ^= 1;
    else if (sq === 0 && dq === 0 && tick === 0) {
      if (ch === "(") paren += 1;
      else if (ch === ")") paren = Math.max(0, paren - 1);
    }
  }
  if (sq === 1 || dq === 1 || tick === 1 || paren > 0) return true;
  if (/\\(?:\r?\n)?$/.test(text)) return true; // 行尾续行符

  // ③ 复合结构深度（按单词边界扫，`echo done` 这类只是把深度钳在 0）
  let doDepth = 0;
  let ifDepth = 0;
  let caseDepth = 0;
  for (const w of text.match(/\b(?:do|done|if|fi|case|esac)\b/g) ?? []) {
    if (w === "do") doDepth += 1;
    else if (w === "done") doDepth = Math.max(0, doDepth - 1);
    else if (w === "if") ifDepth += 1;
    else if (w === "fi") ifDepth = Math.max(0, ifDepth - 1);
    else if (w === "case") caseDepth += 1;
    else if (w === "esac") caseDepth = Math.max(0, caseDepth - 1);
  }
  let brace = 0;
  for (const ch of text) {
    if (ch === "{") brace += 1;
    else if (ch === "}") brace = Math.max(0, brace - 1);
  }
  if (doDepth > 0 || ifDepth > 0 || caseDepth > 0 || brace > 0) return true;

  // ④ 末行以连接符收尾
  const last = [...lines].reverse().find((l) => l.trim() && !l.trim().startsWith("#"));
  if (!last) return false;
  return /(?:\|\||&&|\||\{|\()$/.test(last.trim());
}

/**
 * 把 <<<RUN>>> 块里的多行内容拆成命令列表（容忍模型自作主张加的序号/列表符号）。
 *
 * **多行是常态，不是多条命令**：模型写 `for d in *` 通配再接 `; do … done` 时，
 * 旧实现按行拆 → 第一条只到 `do` 就单独下发，远端 shell 停在续行提示符
 * `>` 上等输入，这一步挂到硬超时（用户实测 300s 不动），后面 `done` 又单独下发
 * 报 `syntax error`。现在按 shell 结构判断续行：结构没写完就继续并入同一条。
 */
export function splitCommandBlock(block: string): string[] {
  const out: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const rawLine of block.split(/\r?\n/)) {
    // 序号/列表符号只剥**每条命令的首行** —— 续行可能是 heredoc 正文
    // （缩进与 `- ` 都是内容的一部分，剥了就改了语义）。
    const line = cur
      ? rawLine.replace(/\s+$/, "")
      : rawLine.replace(/^\s*(?:\d+[.)、]|[-*•])\s*/, "").trim();
    if (!line.trim() || line.trim().startsWith("#")) continue; // 空行与纯注释行不属于任何命令
    cur = cur ? `${cur}\n${line}` : line;
    if (!shellIncomplete(cur)) push();
  }
  push();
  return out;
}

/**
 * 把一条命令行拆成「可独立计数的子命令」。
 *
 * 为什么要拆：`systemctl restart x && systemctl status x` 与单独的
 * `systemctl status x` 在去重台账里是两个不同的键，于是同一条查询可以被反复
 * 执行而闸门永远看不见 —— 实测截图里第 8 步与第 10 步逐字相同，中间那步把
 * status 包在 `restart && status` 里，闸门就当它是新命令。
 *
 * 只按**顶层** `&&` / `;` 拆：
 * - 引号内的分隔符不算（`grep "a;b" f` 是一条命令）；
 * - 不拆 `|`：管道两侧单独拿出来没有意义（`grep x` 不是一条可执行命令）；
 * - 不拆单 `&`：`2>&1` 里含 `&`，拆了会把重定向拆散。
 *
 * 已知边界：`$(...)` / 反引号里的 `;` 会被误拆（罕见，且只会让计数偏严，
 * 不会拦错命令 —— 闸门只在「子命令全部已成功执行过」时才拒绝）。
 */
/**
 * 按**顶层**分隔符切分命令行，并保留每条子命令**前面的**分隔符。
 *
 * 与 `splitSubCommands` 的区别：后者只关心「有哪些子命令」（用于去重计数），
 * 这里额外记住 `;` / `&&`，因为**净化后要按原样拼回去** —— 把 `a && b` 一律
 * 重拼成 `a ; b` 会丢掉 fail-fast 语义（`装完 && 启动` 与 `装完 ; 启动` 不等价）。
 *
 * 切分规则同 `splitSubCommands`：引号内不拆、不拆 `|`、不拆单 `&`（`2>&1` 里含 `&`）。
 */
export function splitCommandParts(command: string): { sep: string; text: string }[] {
  const parts: { sep: string; text: string }[] = [];
  let buf = "";
  let sep = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < (command ?? "").length; i++) {
    const ch = command[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    // 转义的分号不是分隔符（`echo a\;b`）——原样保留，计数键保持忠实
    if (ch === "\\" && command[i + 1] === ";") {
      buf += "\\;";
      i += 1;
      continue;
    }
    if (ch === ";") {
      parts.push({ sep, text: buf });
      buf = "";
      sep = ";";
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      parts.push({ sep, text: buf });
      buf = "";
      sep = "&&";
      i += 1;
      continue;
    }
    buf += ch;
  }
  parts.push({ sep, text: buf });
  return parts
    .map((p) => ({ sep: p.sep, text: p.text.trim() }))
    .filter((p) => p.text.length > 0);
}

/** 子命令列表（用于去重计数）：只取文本，丢弃分隔符 */
export function splitSubCommands(command: string): string[] {
  return splitCommandParts(command).map((p) => p.text);
}

/**
 * 单条命令行允许的最大字符数。
 *
 * 两个理由：① Linux 的 PTY 在规范模式下行缓冲有限，整行超长会被内核截断 ——
 * 而包装脚本把 `; echo "TERMAI_EXIT_x:$?"; echo "TERMAI_END_x"` 放在**末尾**，
 * 截断就等于丢掉结束哨兵：命令其实跑完了，引擎却一直等不到结束，只能耗到
 * 20s/60s 超时；② 一条上千字符的单行命令本身就是输出退化，人类不会这么写。
 */
const MAX_COMMAND_CHARS = 2000;

export interface CommandLineCleanup {
  /** 净化后可直接下发的命令；`overflow` 非空时为空串 */
  command: string;
  /** 被折叠掉的「逐字重复」子命令个数 */
  dedupedCount: number;
  /** 净化后的子命令条数 */
  subCommandCount: number;
  /** 非空 = 这条命令不该执行（子命令过多 / 整行过长），元素为被剔除的子命令 */
  overflow: string[];
}

/**
 * 单行命令净化：折叠逐字重复的子命令，并卡住子命令条数与整行长度。
 *
 * 为什么必须由引擎做：`splitCommandBlock` 只按换行拆，所以「一行里用 `;` 串起 N 条
 * 命令」在引擎眼里永远只是**一条**命令 —— 单轮条数上限（4 条）、风险确认粒度、
 * 跨轮去重台账（首次发出时所有计数都是 0）全都看不见它。
 * 实测截图：一条命令内部把 `rpm -qf /etc/cron.d/nsf 2>/dev/null` 逐字重复约 46 次，
 * 整条原样下发，把终端刷成一面墙。
 *
 * 只折叠**完全相同**的子命令（比较前把连续空白压成一个空格）。参数不同的同名命令
 * 一律保留 —— 合并它们会改变语义（`rm -rf /a` 与 `rm -rf /b` 是两件事）。
 */
export function sanitizeCommandLine(cmd: string): CommandLineCleanup {
  const raw = (cmd ?? "").trim();
  if (!raw) return { command: "", dedupedCount: 0, subCommandCount: 0, overflow: [] };

  const reject = (
    overflow: string[],
    dedupedCount: number,
    subCommandCount: number
  ): CommandLineCleanup => ({ command: "", dedupedCount, subCommandCount, overflow });

  const items = splitCommandParts(raw);
  // 无顶层分隔符：整行就是一条命令，只需卡长度
  if (items.length <= 1) {
    if (raw.length > MAX_COMMAND_CHARS) return reject([raw], 0, 1);
    return { command: raw, dedupedCount: 0, subCommandCount: 1, overflow: [] };
  }

  const seen = new Set<string>();
  const kept: { sep: string; text: string }[] = [];
  let dedupedCount = 0;
  for (const it of items) {
    const key = it.text.replace(/\s+/g, " ");
    if (seen.has(key)) {
      dedupedCount += 1;
      continue;
    }
    seen.add(key);
    kept.push(it);
  }

  if (kept.length > AGENT_MAX_SUB_COMMANDS_PER_LINE) {
    return reject(
      kept.slice(AGENT_MAX_SUB_COMMANDS_PER_LINE).map((i) => i.text),
      dedupedCount,
      kept.length
    );
  }

  // 什么都没折叠 → 原样返回，不改写模型写下的命令文本（连空格都不动）。
  // 重建会统一成 ` ; ` / ` && `，虽然语义等价，但让「净化」在无必要时保持零副作用，
  // 台账与终端里显示的命令才能和模型写的逐字一致。
  if (dedupedCount === 0) {
    if (raw.length > MAX_COMMAND_CHARS) return reject([raw], 0, kept.length);
    return { command: raw, dedupedCount: 0, subCommandCount: kept.length, overflow: [] };
  }

  let command = "";
  kept.forEach((it, i) => {
    if (i === 0) {
      command = it.text;
      return;
    }
    command += ` ${it.sep || ";"} ${it.text}`;
  });

  if (command.length > MAX_COMMAND_CHARS) {
    return reject(
      kept.map((i) => i.text),
      dedupedCount,
      kept.length
    );
  }

  return { command, dedupedCount, subCommandCount: kept.length, overflow: [] };
}

/**
 * 结构性 / 无信息量的行：取台账摘要时跳过。
 *
 * 大量命令的首行是**表头**——`df -h` 是 `Filesystem Size Used ...`、
 * `ls -la` 是 `total 12`、`systemctl status` 是 `● nfs-server.service - NFS server and services`。
 * 模型读到的台账片段若是这种行，等于什么都没读到：它想知道的是「服务在不在跑」，
 * 只看到一行服务描述，于是**只好再跑一遍** —— 这是重复执行最隐蔽的来源。
 */
const DIGEST_SKIP_RE =
  /^(total\b|Filesystem\b|[-=─]{3,}|●|Loaded:|Drop-In:|Process:|Main PID:|Tasks:|Memory:|CPU:|CGroup:|TriggeredBy:|Docs?:)/;

/**
 * 输出摘要：取输出里**前若干条有信息量**的行（跳过表头/单位提示这类结构性行）。
 *
 * 台账里带上它，模型才知道「这条命令得到了什么」，而不是只知道「跑过这条命令」——
 * 后者对它毫无价值（它本来就记得自己发过什么），正是它反复重跑的直接原因。
 * **只做原文摘录，不做任何生成式概括**，避免引入误导性信息。
 *
 * 为什么从「1 行 × 60 字符」放宽到「3 行 × 240 字符」：
 * 台账是模型跨轮的**唯一记忆**（展示窗口只有最近十几条）。只给一行时，`df -h`
 * 只看到一行挂载点、`ps aux` 只看到一个进程，模型对结果没有整体认知 —— 于是
 * 它「再换个写法看一眼」，这就是空转最隐蔽的来源。多给两行 + 总行数，它就能
 * 凭片段判断「够不够用」，不必重跑。
 */
/**
 * 失败输出的要点摘录：**错误行优先，其次尾部**。
 *
 * 为什么不复用 digestOutput：它恒定取头部，而包管理器/编译器的报错几乎都在最后几行。
 * 实测台账里长这样：
 *   `✗ yum install -y ... → Loaded plugins: fastestmirror | Loading mirror speeds...`
 * 而真正的 `Transaction check error: file /usr/bin/zabbix_get conflicts ...` 被丢掉了。
 * 模型重新接手时只看到「加载插件」，既不知道为什么失败、也不知道该改什么。
 */
const FAIL_LINE_RE =
  /(error|fail|conflict|denied|not found|no such|cannot|can't|unable|refused|already installed|already exists|in use|permission|could not|No package|missing)/i;

/** 只有标题、没有内容的行：`Error Summary` / `Errors:` 之类，占了位置却给不出信息 */
const FAIL_BARE_HEADER_RE = /^(?:error summary|errors?|failed|failure)[:：]?$/i;

export function digestFailure(text: string, maxChars = 200): string {
  const all = (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (all.length === 0) return "（无输出）";
  const hits = all.filter((l) => FAIL_LINE_RE.test(l) && !FAIL_BARE_HEADER_RE.test(l));
  // 命中行取**尾部**两条：yum/rpm 会先逐包打 `No package x available.` 这类提示，
  // 真正的结论（`Transaction check error:` + 冲突明细）在最后。取前两条会被这些
  // 中间提示占满，模型看到的仍然不是根因。
  const tailPool = all.filter((l) => !FAIL_BARE_HEADER_RE.test(l));
  const picked = hits.length > 0 ? hits.slice(-2) : (tailPool.length > 0 ? tailPool : all).slice(-2);
  let s = picked.join(" | ");
  if (s.length > maxChars) s = `${s.slice(0, maxChars)}…`;
  return s;
}

export function digestOutput(text: string, maxChars = 240, maxLines = 3): string {
  const all = (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (all.length === 0) return "（无输出）";
  const informative = all.filter((l) => !DIGEST_SKIP_RE.test(l));
  // 全是结构性行时**只**回退到首行：保证「永远有片段」而不是空，
  // 同时不把 total / Filesystem 这类无信息量的行铺开占满台账。
  const pool = informative.length > 0 ? informative : all.slice(0, 1);
  const picked = pool.slice(0, Math.max(1, maxLines));
  let s = picked.join(" | ");
  if (s.length > maxChars) s = `${s.slice(0, maxChars)}…`;
  // 标注总行数：模型据此判断「我看到的片段覆盖了多少」，信息不够时它会主动换目标，
  // 而不是换参数写法重看同一处。
  if (pool.length > picked.length) s += `（共 ${pool.length} 行）`;
  return s;
}

/**
 * 只读白名单：**只有**这些基础命令参与「命令族」计数。
 *
 * 为什么必须用白名单而不是黑名单：族计数会**拒绝第 3 次同族变体**，
 * 误判一条写操作（例如 `systemctl restart`）比漏判一条只读探测的代价大得多
 * —— 漏判只是退化成逐字去重，误判会打断用户真正在推进的任务。
 * 所以不认识的命令一律返回 null（不参与族计数）。
 */
const READONLY_CMDS = new Set([
  "ls", "dir", "vdir", "cat", "tac", "head", "tail", "wc", "nl", "grep", "egrep", "fgrep", "rg",
  "find", "stat", "file", "du", "df", "lsblk", "blkid", "free", "uptime",
  "w", "who", "whoami", "id", "groups", "last", "lastlog", "pwd",
  "ps", "pstree", "ss", "netstat", "lsof", "ip", "ifconfig", "route", "arp",
  "uname", "hostname", "hostnamectl", "timedatectl", "date", "cal",
  "echo", "printf", "which", "whereis", "type", "readlink", "realpath", "basename", "dirname",
  "sort", "uniq", "cut", "tr", "awk", "sed", "jq", "nproc", "lscpu", "lspci", "lsusb",
  "md5sum", "sha1sum", "sha256sum", "cksum", "strings", "od", "hexdump", "xxd",
  "journalctl", "dmesg", "vmstat", "iostat", "mpstat", "sar", "pidstat", "ulimit", "umask",
]);

/**
 * 需要看子命令才算只读的命令：基础命令 → 允许的只读子命令集合。
 *
 * 只列「同一基础命令既有只读子命令、又有写子命令」的情形：
 * `systemctl status` 只读，`systemctl restart` 是写 —— 不做区分就会拦错。
 * 含写子命令却整体不列（apt/yum/dnf/pip/npm/curl/wget）的命令一律不参与族计数，
 * 它们要么本身可能写盘，要么被用作健康轮询（重复本身就是合法用法）。
 */
const READONLY_SUBCMDS: Record<string, Set<string>> = {
  systemctl: new Set([
    "status", "is-active", "is-enabled", "is-failed", "list-units", "list-unit-files",
    "show", "cat", "list-dependencies", "get-default", "show-environment", "list-timers",
  ]),
  service: new Set(["status"]),
  docker: new Set([
    "ps", "images", "inspect", "logs", "version", "info", "stats", "top", "history",
    "image", "container", "volume", "network", "system", "port", "diff", "events",
  ]),
  kubectl: new Set(["get", "describe", "logs", "version", "top", "explain", "api-resources", "config"]),
  git: new Set([
    "status", "log", "diff", "show", "branch", "remote", "tag", "rev-parse", "describe", "ls-files",
    "config", "blame", "shortlog", "whatchanged", "reflog",
  ]),
  crontab: new Set(["-l"]),
  // 查询类 rpm：**必须逐个 flag 白名单**。`rpm -ivh x.rpm` 是安装，
  // 若按「以 - 开头就当只读」放行，族计数会把安装命令也当成可重复的探测。
  rpm: new Set(["-q", "-qa", "-qi", "-ql", "-qf", "-qc", "-qd", "-qv", "-V", "--query", "--info", "--verify", "--version", "--list", "--whatrequires", "--requires"]),
  // 查询类 npm/pip：只读子命令安全，install/uninstall 不在集合里
  npm: new Set(["ls", "list", "view", "info", "outdated", "config"]),
  pip: new Set(["list", "show", "freeze", "check"]),
  pip3: new Set(["list", "show", "freeze", "check"]),
};

/** 命令行前缀包装：剥掉后基础命令才是被观察对象 */
const CMD_PREFIXES = new Set(["sudo", "time", "command", "nohup", "nice", "ionice", "stdbuf", "env", "timeout", "watch"]);

/**
 * 「这条命令会改变系统状态」的粗判 —— **只用于清除族计数**，不用于拦截。
 *
 * 判错方向是安全的：漏判 → 计数不清零 → 网更严（与现状一致）；
 * 误判 → 计数被清 → 网更松（不会拦错命令）。所以这里可以写得宽。
 */
const WRITE_BASE = new Set([
  "rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "chgrp", "ln", "dd",
  "truncate", "tee", "install", "mkfifo", "mknod", "kill", "pkill", "killall",
  "shutdown", "reboot", "poweroff", "halt", "mount", "umount", "swapon", "swapoff",
  "iptables", "ip6tables", "firewall-cmd", "ufw", "useradd", "usermod", "userdel",
  "groupadd", "groupmod", "groupdel", "passwd", "chpasswd", "sysctl", "crontab", "at",
  "apt", "apt-get", "yum", "dnf", "rpm", "dpkg", "pip", "pip3", "npm", "yarn", "pnpm",
  "service", "systemctl", "tar", "unzip", "mkfs", "fdisk", "parted", "sed", "perl",
  "curl", "wget", "scp", "rsync", "git", "docker", "kubectl", "vi", "vim", "nano",
]);

/** 极简分词：按空白切，引号内的空白不切（不做变量展开等复杂解析） */
function tokenize(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (const ch of text ?? "") {
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf) out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

/** 剥掉 `sudo` / `env VAR=x` / `timeout 5` 等前缀，返回真正的基础命令 */
function normalizeBase(token: string | undefined): string {
  const t = (token ?? "").split("/").pop() ?? "";
  return t.trim();
}

/**
 * 有没有「写文件」的重定向。
 *
 * 注意三类**不是**写文件的重定向，必须放行，否则会丢掉绝大多数探测命令：
 * `2>&1` / `>&2`（fd 复制）、`2>/dev/null`（丢弃输出，极其常见）、`> /dev/tty`。
 */
function hasFileRedirect(cmd: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch !== ">") continue;
    if (cmd[i + 1] === "&") {
      // `>&1`：fd 复制
      i += 1;
      continue;
    }
    let j = i + 1;
    if (cmd[j] === ">") j += 1;
    while (cmd[j] === " " || cmd[j] === "\t") j += 1;
    let target = "";
    while (j < cmd.length && !/[\s;|&]/.test(cmd[j])) {
      target += cmd[j];
      j += 1;
    }
    // 丢弃输出 / 写到终端，不算状态变更
    if (/^(&\d+|-|\/dev\/(null|stdout|stderr|tty|fd\/\d+))$/.test(target)) continue;
    return true;
  }
  return false;
}

/** 按顶层 `|` / `;` / `&&` 切段（用于逐段判断只读） */
function pipelineSegments(cmd: string): string[] {
  const segs: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    // 单 `&` 不切：`2>&1` 里含 `&`，切了会把重定向拆散（同 splitCommandParts 的约定）
    if (ch === "|" || ch === ";") {
      segs.push(buf);
      buf = "";
      continue;
    }
    if (ch === "&" && cmd[i + 1] === "&") {
      segs.push(buf);
      buf = "";
      i += 1;
      continue;
    }
    buf += ch;
  }
  segs.push(buf);
  return segs.map((s) => s.trim()).filter(Boolean);
}

/** `2>/dev/null` / `>&1` 这类重定向 token —— 既不是子命令也不是被观察的目标 */
const isRedirectToken = (t: string) => /^\d*[<>]/.test(t);

/** 剥掉 `sudo` / `env A=B` / `timeout 5` 等前缀与重定向 token，返回基础命令与其余参数 */
function baseAndRest(seg: string): { base: string; rest: string[] } {
  const tokens = tokenize(seg);
  let i = 0;
  while (
    i < tokens.length &&
    (CMD_PREFIXES.has(normalizeBase(tokens[i])) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))
  ) {
    i += 1;
  }
  // 重定向必须在**取子命令之前**剔掉：`rpm -qa 2>/dev/null` 若不剔，
  // 第一个「非 flag」token 就是 `2>/dev/null`，子命令白名单查不到它，
  // 于是这条查询被误判成写操作（族计数只剩一半、写清零被误触发）。
  return { base: normalizeBase(tokens[i]), rest: tokens.slice(i + 1).filter((t) => !isRedirectToken(t)) };
}

/**
 * 取出命令的**子命令**（跳过 flag）。
 *
 * `service` 特殊：`service <名字> <动作>` 的动作在第二位 —— 直接取第一个非 flag
 * 会拿到服务名，`service nginx restart` 就会被当成只读。
 */
function subCommandOf(base: string, rest: string[]): { sub: string; flags: string[] } {
  const nonFlags = rest.filter((t) => !t.startsWith("-"));
  const flags = rest.filter((t) => t.startsWith("-"));
  const sub = base === "service" ? (nonFlags[1] ?? "") : (nonFlags[0] ?? "");
  return { sub, flags };
}

/** 单段是否只读（白名单 + 写迹象检查） */
function isReadOnlySegment(seg: string): boolean {
  const { base, rest } = baseAndRest(seg);
  if (!base) return false;

  if (READONLY_CMDS.has(base)) {
    // 这几个「只读命令」带写选项时会写盘，必须剔掉
    if (base === "find" && rest.some((t) => t === "-exec" || t === "-execdir" || t === "-delete" || t === "-fprint")) {
      return false;
    }
    if (base === "sed" && rest.some((t) => t === "-i" || /^-i\S/.test(t))) return false;
    return true;
  }

  const allowed = READONLY_SUBCMDS[base];
  if (!allowed) return false; // 不认识 → 不参与族计数（安全退化）
  const { sub, flags } = subCommandOf(base, rest);
  // 裸命令（`systemctl` = list-units）：没有 flag 就直接放行，有 flag 则逐个查白名单
  // （`crontab -l` 只读、`crontab -r` 是删除；`rpm -qa` 只读、`rpm -ivh` 是安装）
  if (sub === "") return flags.length === 0 || flags.every((f) => allowed.has(f));
  return allowed.has(sub);
}

/**
 * 计算一条命令的「族键」：**基础命令 + 目标（位置参数，排序），忽略 flag 差异**。
 *
 * 目的：`ls -1` / `ls -1t` / `ls -la` / `ls -1t | head -1` 是**同一件事的不同姿势**，
 * 只读、结果不会变。逐字去重对它们无能为力（换 flag 就是新键），族计数把它们
 * 归成一个键，于是第 3 次变体也会被拦下。
 *
 * 对复合命令（`rm x; du y`），写操作 segment 不参与族计数，只把其中的只读
 * segment 分别归族 —— 避免 `rm` 把后面的 `du` 一起拖下水。
 *
 * 返回 null = 没有可参与族计数的只读 segment，三种情形：
 * ① 所有 segment 都是写操作 / 基础命令不在只读白名单；
 * ② 含 `$(...)` / 反引号（目标无法静态确定）；
 * ③ 空命令。
 */
export function cmdFamily(command: string): string | null {
  const raw = (command ?? "").trim();
  if (!raw) return null;
  if (/\$\(|`/.test(raw)) return null;
  if (hasFileRedirect(raw)) return null;

  const segs = pipelineSegments(raw);
  if (segs.length === 0) return null;

  for (const seg of segs) {
    if (isStateChangingSegment(seg)) continue; // 写操作 segment 不参与族计数
    if (!isReadOnlySegment(seg)) continue; // 不认识的命令也不参与
    const { base, rest } = baseAndRest(seg);
    if (!base) continue;
    const positionals = rest
      .filter((t) => !t.startsWith("-"))
      // `2>/dev/null`、`>&1`、`>f` 只是重定向，不是被观察的目标
      .filter((t) => !isRedirectToken(t))
      // 末尾斜杠与 `./` 只是写法差异，归一到同一目标
      .map((t) => t.replace(/\/+$/, "") || "/")
      .map((t) => (t === "./" ? "." : t));
    const target = positionals.length > 0 ? [...positionals].sort().join(" ") : ".";
    return `${base}|${target}`;
  }
  return null;
}

/** 单段是否改变系统状态 */
function isStateChangingSegment(seg: string): boolean {
  const raw = (seg ?? "").trim();
  if (!raw) return false;
  if (hasFileRedirect(raw)) return true;
  const { base, rest } = baseAndRest(seg);
  if (!base) return false;
  // 白名单里的只读命令带写选项时也算状态变更（`find -exec rm`）
  if (base === "find" && rest.some((t) => t === "-exec" || t === "-execdir" || t === "-delete")) return true;
  if (!WRITE_BASE.has(base)) return false;
  // 「既能读又能写」的命令，只在真的写了才算状态变更
  if (READONLY_SUBCMDS[base]) {
    const { sub, flags } = subCommandOf(base, rest);
    const allowed = READONLY_SUBCMDS[base];
    const readOnly = sub === "" ? flags.length === 0 || flags.every((f) => allowed.has(f)) : allowed.has(sub);
    return !readOnly;
  }
  if (base === "sed" || base === "perl") return rest.some((t) => t === "-i" || /^-i\S/.test(t));
  if (base === "rpm") return rest.some((t) => /^-(i|U|e|F)/.test(t));
  if (base === "tar") return rest.some((t) => /^-[a-z]*[xC]/.test(t));
  if (base === "curl" || base === "wget") {
    return rest.some((t) => t === "-o" || t === "-O" || t === "--output" || t.startsWith("--output="));
  }
  return true;
}

/** 这条命令会不会改变系统状态 */
export function isStateChanging(command: string): boolean {
  const raw = (command ?? "").trim();
  if (!raw) return false;
  if (hasFileRedirect(raw)) return true;
  return pipelineSegments(raw).some(isStateChangingSegment);
}

/** 单条命令的执行统计（去重台账的条目） */
interface DupEntry {
  /** 执行次数 */
  n: number;
  /** 最后一次是否成功 */
  lastOk: boolean;
  /** 最后一次失败发生的执行序号（-1 = 没失败过），用于判断「失败之后前提有没有变」 */
  failAt: number;
  /** 最后一次失败的错误片段（用于拒绝重跑时直接回灌，省掉一次必然重复的往返） */
  failDigest: string;
  /** 最后一次成功执行拿到的输出片段（原文摘录） */
  digest: string;
  /** 最后一次成功执行拿到的**较长**输出（用于模型「想再看一眼」时回填，见 DUP_BACKFILL_MAX_CHARS） */
  full: string;
}

/**
 * 去重闸门拒绝时，回填给模型的单个命令输出上限。
 *
 * 模型重发一条已执行过的只读命令，真实动机十有八九是「上一轮那段被截断了，我没看清」。
 * 旧实现只回填 240 字符的 digest，它拿到的信息量比第一次还少 → 下一轮继续换写法重发，
 * 连拒 3 轮任务提前结束，而真正的原因（输出被截断）从头到尾没人说。
 * 这里保存一份**更长**的原文（聚焦视图），拒绝时原样回填，让「再看一眼」这一次就满足。
 */
const DUP_BACKFILL_MAX_CHARS = 6000;

export interface DupTracker {
  /** 记录一次真实执行（只有真的下发执行过才调用） */
  record(command: string, ok: boolean, output?: string): void;
  /** 是否属于「已成功执行过 ≥2 次、不必再跑」的命令 */
  isDuplicate(command: string): boolean;
  /** 该命令此前成功执行时拿到的输出片段（用于拒绝时回填，省掉「再确认一次」的往返） */
  lastDigest(command: string): string;
  /**
   * 该命令此前成功执行时拿到的**较长**输出（聚焦视图，最多 DUP_BACKFILL_MAX_CHARS）。
   * 用于「模型重发同一条命令，其实是想看全被截断的输出」这种情形：直接把它要的东西给它。
   */
  lastFull(command: string): string;
  /** 拒绝原因（逐字重复 / 同族变体），null = 放行。附带可直接展示给模型的说明 */
  dupReason(command: string): DupReason | null;
}

/**
 * 拒绝原因：`exact` = 逐字相同；`family` = 同一目标换 flag 再看一遍；
 * `failed` = 逐字相同且上次就失败了（期间前提没变，重跑必然同一份报错）。
 */
export interface DupReason {
  kind: "exact" | "family" | "failed";
  /** 同族的其它写法（用于告诉模型「你已经用这几种姿势看过同一个目标了」） */
  siblings: string[];
  /** `failed` 专用：上一次失败时拿到的错误片段（直接回灌，省掉一次必然重复的往返） */
  failDigest?: string;
}

const normalizeCmd = (cmd: string) => (cmd ?? "").trim().replace(/\s+/g, " ");

/**
 * 重复命令台账（Agent 接管用）。
 *
 * 阈值双轨：
 * - **写操作子命令**：已成功 ≥1 次（第 2 次起）就拒绝。写操作不应反复执行，
 *   装完/删完后的「复查」由同条命令里的只读子命令承担。
 * - **只读子命令**：已成功 ≥2 次（第 3 次起）才拒绝，给「启动后再确认」留余量。
 *
 * 为什么按**子命令**计数：`systemctl restart x && systemctl status x` 与单独的
 * `systemctl status x` 若各算各的键，把查询包进别的命令里就能绕开去重 ——
 * 实测截图里第 8 步与第 10 步逐字相同，中间那步把 status 包在 `restart && status`
 * 里，闸门就当它是新命令、只数到 1 次，于是放行。
 *
 * 复合命令的子命令共用同一份输出片段（PTY 只回传一条合并后的输出），
 * 归因上略有粗粒度，但片段始终是**原文**，不会编造。
 */
/**
 * 从「已执行台账」尾部取要展示给模型的行：**条数 + 字符双约束**。
 *
 * 为什么不能只给固定条数（旧实现 12 条）：
 * - 去重硬闸门用的是全量历史，而模型只看得见窗口内的内容。窗口外的旧命令一旦
 *   被重发，会被判「重复」并计入连拒 —— 连拒 3 轮直接结束任务，模型完全不知道
 *   自己错在哪。窗口越小，这种「看不见的误杀」越多。
 * - 单纯把条数调大又会撑爆上下文：条目自带输出片段，一条 100~300 字符很常见。
 *   字符预算才是真正的约束（4000 字符 ≈ 20~30 条），所以两个约束都要有。
 */
export function pickLedgerLines(
  lines: string[],
  maxLines: number,
  charBudget: number
): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (out.length >= maxLines) break;
    const line = lines[i];
    // 至少保留 1 条：单行就超预算也得给，否则模型看不到「刚刚做了什么」。
    if (used + line.length > charBudget && out.length > 0) break;
    out.unshift(line);
    used += line.length + 1;
  }
  return out;
}

export function createDupTracker(): DupTracker {
  const stats = new Map<string, DupEntry>();
  // 执行序号 + 「最近一次成功的状态变更」序号。
  //
  // 用来回答一个去重闸门必须区分的问题：**失败之后，前提变了没有？**
  // 变了（中间成功跑过装包/改配置/启动服务）→ 原样重试是合理的，必须放行；
  // 没变 → 同样的输入必然产生同样的输出，重发只是白烧一轮 + 一次长输出。
  // 实测事故：zabbix 安装因文件冲突失败 → 想 `yum remove` 冲突包被用户跳过 →
  // 第 5 步**原样重跑**同一条 install，报错一字不差，然后模型放弃并写「请手动执行」。
  let seq = 0;
  let lastOkChangeSeq = -1;
  // 族计数：族键 → 执行次数 / 最后是否成功 / 族内出现过的写法（最多留 3 条用于解释）
  const fam = new Map<string, { n: number; lastOk: boolean; members: string[] }>();
  const countKeys = (cmd: string): string[] => {
    const subs = splitSubCommands(cmd);
    // 单条命令只算自己一个键：拆开只会得到它自身，徒增重复计数
    return (subs.length > 1 ? subs : [cmd]).map(normalizeCmd).filter((k) => k.length > 0);
  };
  // 逐字重复判定（`isDuplicate` / `dupReason` 共用，避免依赖 `this` 绑定）
  const exactDupKind = (command: string): "exact" | "failed" | null => {
    const keys = countKeys(command);
    if (keys.length === 0) return null;

    // 失败重跑：逐字相同 + 上次失败 + 期间没有任何成功的变更动作。
    // 放在最前面判 —— 否则这类命令会一路落到「纯读命令」分支，因为 lastOk=false
    // 永远满足不了「成功 ≥2 次」，于是被当成新命令放行（这就是上面那次事故的成因）。
    const failedDup = keys.every((k) => {
      const st = stats.get(k);
      return !!st && !st.lastOk && st.failAt >= 0 && st.failAt > lastOkChangeSeq;
    });
    if (failedDup) return "failed";

    // 写操作子命令阈值 = 1：已经成功过一次就不该再跑，哪怕同条命令里还有新的读操作。
    // 这拦住截图里 `rm x; du y` 与 `rm x; du y z` 反复执行的顽疾。
    const writeDup = keys
      .filter((k) => isStateChanging(k))
      .some((k) => {
        const st = stats.get(k);
        return !!st && st.n >= 1 && st.lastOk;
      });
    if (writeDup) return "exact";

    // 纯读命令：全部子命令都成功 ≥2 次才算重复，给「启动后再确认」留一次复查余量。
    const readDup = keys.every((k) => {
      const st = stats.get(k);
      return !!st && st.n >= 2 && st.lastOk;
    });
    return readDup ? "exact" : null;
  };
  const isExactDup = (command: string): boolean => exactDupKind(command) !== null;
  return {
    record(command, ok, output) {
      const keys = countKeys(command);
      if (keys.length === 0) return;
      seq += 1;
      const digest = output === undefined ? "" : digestOutput(output);
      // 留一份较长的聚焦视图：截断标注会一并保留，模型据此知道自己缺哪几行。
      // 只在成功时更新（失败那次的输出对「继续推进」没有参考价值）。
      // 行数上限同样放到很大：太小会先把中段（含错误行）砍掉，最后回填的「完整输出」
      // 反而比第一次给的更没信息量 —— 那就完全失去了回填的意义。
      const full =
        output === undefined || !ok
          ? ""
          : focusOutput(sanitizeOutput(output, 20000), DUP_BACKFILL_MAX_CHARS);
      // 成功的状态变更命令 = 前提变了，此前所有失败记录都不再代表「必然重复」。
      // 必须在写 stats 之前算，否则本条自己会被当成「前提没变」。
      if (ok && keys.some((k) => isStateChanging(k))) lastOkChangeSeq = seq;
      for (const key of keys) {
        const prev = stats.get(key);
        stats.set(key, {
          n: (prev?.n ?? 0) + 1,
          lastOk: ok,
          failAt: ok ? (prev?.failAt ?? -1) : seq,
          failDigest: ok ? (prev?.failDigest ?? "") : digest,
          // 失败那次的片段没有参考价值，保留上一次成功拿到的
          digest: ok || !prev?.digest ? digest : prev.digest,
          full: full || prev?.full || "",
        });
      }
      // 族计数：只读 segment 各自归族；写 segment 不再清空全族，避免
      // `rm x; du y` 这种复合命令每次都能借 `rm` 把 `du` 的计数清零。
      const famKey = cmdFamily(command);
      if (famKey) {
        const prev = fam.get(famKey);
        const members = prev?.members ?? [];
        const shown = normalizeCmd(command);
        fam.set(famKey, {
          n: (prev?.n ?? 0) + 1,
          lastOk: ok,
          members: members.includes(shown) ? members : [...members, shown].slice(-3),
        });
      }
    },
    isDuplicate(command) {
      return isExactDup(command);
    },
    dupReason(command) {
      const kind = exactDupKind(command);
      if (kind === "failed") {
        const failDigest =
          countKeys(command)
            .map((k) => stats.get(k)?.failDigest ?? "")
            .find((d) => d.length > 0) ?? "";
        return { kind: "failed", siblings: [], failDigest };
      }
      if (kind === "exact") return { kind: "exact", siblings: [] };
      const famKey = cmdFamily(command);
      if (!famKey) return null;
      const st = fam.get(famKey);
      // 族计数统一按 ≥2 次：只读命令换 flag/套管道「再看一眼」最多给 2 次机会
      if (st && st.n >= 2 && st.lastOk) {
        return { kind: "family", siblings: st.members };
      }
      return null;
    },
    lastDigest(command) {
      for (const k of countKeys(command)) {
        const d = stats.get(k)?.digest;
        if (d) return d;
      }
      return "";
    },
    lastFull(command) {
      for (const k of countKeys(command)) {
        const d = stats.get(k)?.full;
        if (d) return d;
      }
      return "";
    },
  };
}

/**
 * 从 Markdown 代码围栏里取出命令（**仅在整轮没有任何协议标记时**兜底使用）。
 *
 * 为什么必须有这一步：小模型（8B 级、以及任何被通用提示词「带偏」的模型）极高频
 * 地把命令写成 ```bash 围栏，而不是 `<<<RUN>>>`。旧实现走「兜底 2 → 整段当最终结论」，
 * 于是引擎**一条都没下发**，用户看到的是「命令给我了，但它没有执行」，连打回 3 轮后
 * 任务以「模型未按协议输出」结束。实测用户让 Agent 固定 IP 就是死在这里。
 *
 * 安全边界（很关键，别放宽）：
 * - 只认 shell 家族语言标注（bash/sh/shell/console/终端…）；`bash:risk=low` 也算。
 * - 无语言标注的围栏**只在不含中文散句时**接受 —— 无标注围栏也常用来贴输出/配置示例，
 *   里面混着中文说明就说明它是给人看的，不能当命令跑。
 * - 围栏里若整段都是 `#` 注释或空行，直接丢弃。
 * 命中后每条命令**仍然**要过 reviewCommand 与去重闸门，执行侧的安全不在这里放宽。
 */
export function extractFencedCommands(text: string): string[] {
  const out: string[] = [];
  const re = /```[ \t]*([A-Za-z0-9_+.:=-]*)[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text ?? ""))) {
    const lang = (m[1] ?? "").toLowerCase().split(":")[0];
    const body = (m[2] ?? "").trim();
    if (!body) continue;
    const isShellLang = /^(?:ba|z|k|da|fi)?sh$|^shell$|^console$|^term(?:inal)?$|^powershell$|^ps1$/.test(lang);
    if (lang && !isShellLang) continue;
    if (!lang) {
      // 无标注：有中文散句就当作「给人看的示例」，不执行
      const cjk = (body.match(/[\u4e00-\u9fa5]/g) ?? []).length;
      if (cjk > 0) continue;
    }
    // 剥掉终端提示符前缀（`$ cmd` / `# cmd`），模型常整段复制粘贴
    const cleaned = body
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*[$#]\s+/, ""))
      .join("\n");
    for (const c of splitCommandBlock(cleaned)) {
      if (!/^[#\s]*$/.test(c)) out.push(c);
    }
  }
  return out;
}

/**
 * 解析 Agent 的回复，严格遵循 <<<RUN>>> / <<<DONE>>> 协议。
 * 若模型没按协议输出（常见），则退化为「整段就是最终结论」，避免死循环。
 */
export function parseAgentReply(text: string): AgentReply {
  const raw = (text ?? "").trim();

  const runRegex = new RegExp(
    `${escapeRegExp(AGENT_RUN_START)}([\\s\\S]*?)${escapeRegExp(AGENT_RUN_END)}`
  );

  const doneIdx = raw.indexOf(AGENT_DONE);
  if (doneIdx !== -1) {
    const after = raw.slice(doneIdx + AGENT_DONE.length).trim();
    const before = raw.slice(0, doneIdx).trim();
    // 「命令 + 结论」写在同一轮（小模型高频）：**命令优先执行，结论降级为草稿**。
    // 旧实现把命令整段丢弃、照收结论 —— 模型说「已清理完成」而实际一条没跑，
    // 用户拿到的结论是编的。这里仍返回 done=false，让 run() 先把命令跑完，
    // 再把「你之前的结论是在命令执行前写的」回灌，由模型核对真实输出后重新收尾。
    const runM = before.match(runRegex);
    const commands = runM ? splitCommandBlock(runM[1] ?? "") : [];
    if (commands.length > 0) {
      return {
        thought: before.slice(0, runM!.index ?? 0).trim(),
        commands,
        done: false,
        finalAnswer: null,
        raw,
        deferredAnswer:
          after || before.replace(runM![0], "").trim() || undefined,
      };
    }
    // 绝不能用 `|| raw` 兜底：模型只吐一个 `<<<DONE>>>`（被截断、或单纯偷懒不写正文）
    // 时，raw 就是那个协议标记本身，于是「任务总结」卡片里只剩一行 `<<<DONE>>>`。
    // 这里留空，交给 run() 判定「空总结」并打回重写。
    return {
      thought: before,
      commands: [],
      done: true,
      finalAnswer: after || before,
      raw,
    };
  }

  // 计划声明：优先于命令执行。run() 据此把计划存为任务蓝图并继续，
  // 不会当作命令执行，也不会误判为结束。
  const planIdx = raw.indexOf(AGENT_PLAN);
  if (planIdx !== -1) {
    // 提示词约定 <<<PLAN>>> 既做开头也做结尾标记：剥掉结尾那个多余标记，
    // 避免蓝图文本里混入协议串（会进 UI 计划卡片与后续注入的 pinned 消息）。
    const plan = raw
      .slice(planIdx + AGENT_PLAN.length)
      .trim()
      .replace(new RegExp(`${escapeRegExp(AGENT_PLAN)}\\s*$`), "")
      .trim();
    const before = raw.slice(0, planIdx).trim();
    // 「计划 + 首条命令」写在同一条回复里是合法且高频的形态（小模型尤其如此）。
    // 旧实现把 RUN 块整段丢弃（实测探针：PLAN+RUN 同轮 → commands 为 0），
    // 这一轮就白跑：模型以为命令已下发，实际什么都没执行，下一轮还得重发一遍。
    // 现在把计划之后的 RUN 块一并解析出来，run() 存完计划直接执行，省掉一个往返。
    const runM = raw.slice(planIdx).match(runRegex);
    const commands = runM ? splitCommandBlock(runM[1] ?? "") : [];
    return { thought: before, commands, done: false, finalAnswer: null, raw, plan };
  }

  const m = raw.match(runRegex);
  if (m) {
    const commands = splitCommandBlock(m[1] ?? "");
    const before = raw.slice(0, m.index ?? 0).trim();
    if (commands.length > 0) {
      return { thought: before, commands, done: false, finalAnswer: null, raw };
    }
  }

  // 兜底 1：只写了开标记没写闭标记
  const looseIdx = raw.indexOf(AGENT_RUN_START);
  if (looseIdx !== -1) {
    const commands = splitCommandBlock(raw.slice(looseIdx + AGENT_RUN_START.length));
    if (commands.length > 0) {
      return { thought: "", commands, done: false, finalAnswer: null, raw };
    }
  }

  // 兜底 1.5：整轮**没有任何协议标记**，但内容里有 shell 代码围栏 / `RUN:` 前缀。
  // 这是「命令给我了却没执行」的唯一根因：模型用通用格式写了命令，引擎认协议不认围栏。
  // 只在完全没有标记时启用（有 <<<DONE>>> 时的围栏可能是「需要手动执行的操作」示例，
  // 那属于结论的一部分，绝不能自动跑）。
  const prefixRun = raw.match(/^RUN\s*[:：]\s*([\s\S]+)$/i);
  if (prefixRun) {
    const commands = splitCommandBlock(prefixRun[1]);
    if (commands.length > 0) {
      return { thought: "", commands, done: false, finalAnswer: null, raw, normalizedFrom: "prefix" };
    }
  }
  const fenced = extractFencedCommands(raw);
  if (fenced.length > 0) {
    return {
      thought: raw.replace(/```[\s\S]*?```/g, "").trim(),
      commands: fenced,
      done: false,
      finalAnswer: null,
      raw,
      normalizedFrom: "fence",
    };
  }

  // 兜底 2：当成最终结论（无协议标记，run() 会据此判断是否真的结束）
  return { thought: "", commands: [], done: true, finalAnswer: raw, raw, noMarkerFallback: true };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ExecResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  /** 发给终端的完整脚本（含哨兵），用于在 UI 上说明真实执行了什么 */
  script: string;
  /** 执行本身抛异常时的错误信息（区别于命令返回非 0） */
  error?: string;
  /** 输出超过缓冲上限被截断（多半是读了二进制 / 命令在死循环刷屏） */
  flooded?: boolean;
  /**
   * 命令停在交互式提问上（密码 / [Y/n] / 按键确认），已被引擎主动中断。
   *
   * 与 `timedOut` 分开记：超时是「不知道它在干嘛」，交互是「明确知道它在等输入」，
   * 两者给模型的下一步完全不同（后者只要加非交互参数就能过）。
   */
  interactive?: InteractivePrompt;
  /**
   * 逐段退出码（仅当命令由顶层 `;` 串联时才有）。
   *
   * 为什么必须单独记录：`$?` **只反映最后一条子命令**。`rm /nope; du /tmp` 里
   * `rm` 明明失败了，末条 `du` 成功 → 整条退出码 0 → 界面绿、模型也读到「成功」，
   * 于是它在错误的前提上继续推进。这是整条链路上唯一一处「信息在源头就是错的」。
   * `&&`/`||` 不参与分段（插打点会破坏短路语义），此时该字段为空。
   */
  segmentStatus?: { index: number; code: number; skipped?: boolean }[];
  /**
   * 逐段独立输出（仅当命令由顶层 `;` 串联时才有）。
   *
   * 与 `segmentStatus` 配对：`segmentStatus` 只给「序号 + 退出码」，`segments` 额外给出
   * **每一段自己的标准输出**，让模型能把输出归因到具体段。没有它，整条命令的多段输出
   * 会被混成一坨喂给模型 —— 模型看不出「哪段没匹配到 / 哪段失败了」，只能换 pattern 重发，
   * 这就是「接管效果差、命令越跑越多」的核心机制之一。
   */
  segments?: SegmentOutput[];
}

export interface ExecOptions {
  /** 基础超时（默认 20s）。超时后若仍在持续产生输出，会自动延长 */
  timeoutMs?: number;
  /** 硬上限（默认 60s），无论如何到此为止 */
  maxTimeoutMs?: number;
  signal?: AbortSignal;
  /** 实时输出回调（已清理 ANSI，供 UI 流式展示） */
  onOutput?: (output: string) => void;
}

/**
 * 行尾处于「等后续内容」状态，下一段只能用空格拼（插 `;` 会语法出错）：
 * 连接符、以及 do/then/else/elif/in 这类**后面必须直接跟命令列表**的关键字。
 * 反面教材（旧实现）：`for d in *` 后面插 `;` 再接 `do`，会形成非法的 `do ;`。
 */
const NEEDS_MORE_END_RE = /(?:\|\||&&|;|\||&|\{|\(|\\)$|\b(?:do|then|else|elif|in)$/;

/**
 * 多行命令折叠成单行（AI 偶尔会输出多行命令/脚本）。
 *
 * 修复的两个真实故障（2026-09-11，用户实测「执行的什么东西，啥都不是」）：
 *  1. 注释行被 `;` 平接后，`#` 会把**后面所有内容**（含收尾的 done 与哨兵）注释掉，
 *     远端 shell 停在续行提示符 `>>` 上等输入 → 这一步挂到超时。注释行直接丢弃。
 *  2. `do`/`then` 之后插 `;`（`for x in *; do ; cmd`）是非法 bash，报语法错误后
 *     整步作废。改为「等后续内容」状态只空格拼。
 *
 * 注意：带结构关键字（while/for/if…）的多行脚本不会走到这里 ——
 * execCommand 会让它们落盘成临时脚本，由 bash 按原始换行解析。
 */
export function flattenCommand(cmd: string): string {
  const lines = cmd
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\\\s*$/, "").trim())
    // 纯注释行没有语义，平坦化时必须丢掉（见上面故障 1）
    .filter((l) => Boolean(l) && !l.startsWith("#"));
  if (lines.length <= 1) return lines[0] ?? "";

  let out = lines[0];
  for (let i = 1; i < lines.length; i++) {
    const prev = out.trimEnd();
    const line = lines[i];
    out = NEEDS_MORE_END_RE.test(prev) ? `${prev} ${line}` : `${prev} ; ${line}`;
  }
  return out;
}

/**
 * 打断远程仍在运行的前台进程，把 shell 抢回可交互状态。
 *
 * 这是「装软件装到一半之后满屏乱输出」的根因修复：等待循环超时/被中止时，
 * 远端那条命令并没有停（可能是 wget 卡在下载、apt 卡在 [Y/n]、编译还在跑），
 * 它依然占着 PTY 的 stdin。此时本轮后续命令、乃至下一轮 Agent 发下的任何
 * 脚本，都会被它当成输入吞掉 —— 哨兵错位、退出码丢失、输出张冠李戴，
 * 模型拿到一堆互相穿插的残片，只能退化成反复发无关探测命令。
 *
 * 只做两件事：Ctrl+C 中断前台进程，再补一个空回车逼 shell 刷新提示符。
 * 中断失败不影响调用方，异常一律吞掉。
 */
async function abortRemoteCommand(
  w: { __termai_writeTerminal?: (sid: string, data: string) => Promise<boolean> },
  sessionId: string
): Promise<void> {
  try {
    await w.__termai_writeTerminal?.(sessionId, "\x03");
    await sleep(120);
    // Ctrl+C 之后 shell 往往要等下一次回车才回显提示符，补一下确认已恢复
    await w.__termai_writeTerminal?.(sessionId, "\r");
    await sleep(120);
  } catch {
    // 终端已断开等情况下写入会抛错，此时也没有可中断的进程
  }
}

/**
 * 多行脚本是否应该「落盘成临时脚本执行」而不是压平成一行。
 *
 * 压平只对「简单的多行命令序列」（`ls` 换行 `cd /tmp`）安全；一旦包含 shell
 * 结构（if/for/while/case…）或注释，压平就不可靠：
 *  - 注释行被接进一行后，`#` 会吞掉后面全部内容（含收尾的 done 与哨兵），
 *    远端 shell 停在续行提示符 `>>` 等输入 → 这一步挂到超时（用户实测故障）；
 *  - `do` / `then` 后插 `;`（`for x in *; do ; cmd`）是非法 bash，整步作废。
 * 落盘后由 bash 按**原始换行**解析，语义与模型写下的完全一致；即便脚本本身
 * 有语法错误，也只是 bash 退出码非 0，不会把交互式 shell 卡在续行状态。
 */
export function needsScriptFile(command: string): boolean {
  if (!command.includes("\n")) return false;
  if (/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(command)) return true; // heredoc
  if (/(^|\n)[ \t]*#/.test(command)) return true; // 注释行
  return /(^|\n)[ \t]*(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|select)\b/.test(
    command
  );
}

/**
 * 组装要下发给远端 shell 的包装脚本（纯函数，便于单测）。
 *
 * 三种形态：
 * ① 多行脚本（heredoc / 循环 / 条件 / 注释）→ 落盘 + `bash <path>`，保留原始换行；
 * ② 顶层全部由 `;` 串联的普通命令 → **逐段打点**，每段后面紧跟一条分段退出码；
 * ③ 其余（单条命令、含 `&&`/`||`/后台 `&`）→ 只有一条整体退出码。
 *
 * 两处刻意的设计：
 * - **不外包 ` 2>&1`**：PTY 本身就把 stderr 与 stdout 合流，外包重定向唯一的实际作用
 *   是把**末条子命令自己的** `2>/dev/null` 抵消掉（重定向从左到右生效），于是系统
 *   明确要求模型使用的 `2>/dev/null` 全部失效、stderr 灌进观察。
 * - **分段打点只用 `;`**：`&&`/`||` 插打点会破坏短路语义（`a && b` 里 a 失败时 b 本不该跑）；
 *   行尾 `&`（后台任务）插打点会生成非法的 `{ cmd &; echo ...; }`，一律整体放行。
 *   打点串带 `:seg:` 中缀，不会被整体退出码正则误匹配；且沿用 exitTag 前缀，
 *   自动被 stripEcho / stripAgentLines 当哨兵行剔除 —— 终端显示零噪声。
 */
/**
 * 顶层裸花括号是否配平（引号内的不算，`${a}` 这类参数展开会自平衡）。
 *
 * 用途：分段打点靠 `{ cmd; echo ...; }` 分组。若命令本身含未配平的 `}`，
 * 它会提前闭合分组 → 整条脚本语法错误，比「拿不到分段退出码」严重得多。
 * 配平检查不通过就退回整体退出码（安全退化）。
 * 例：`echo ${x}; ls` → 配平，可分段；`echo }; ls` → 不配平，整体放行。
 */
export function balancedBraces(cmd: string): boolean {
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * 等待命令结束时的熔断判据（纯函数，便于单测）。
 *
 * 两个独立阈值：
 * - `idleTimeoutMs`：**只有过了它、且连续 3 秒没有新输出**才算卡死。
 * - `hardTimeoutMs`：绝对上限，到点无条件切。
 *
 * 旧实现两者同值，且硬上限判断无条件命中 —— 「还在下载进度条上慢慢爬」的
 * 长命令会在第 5 分钟被切成半截，模型拿着半截输出下结论，错的不是模型。
 */
export function shouldAbortWait(p: {
  now: number;
  startedAt: number;
  lastDataAt: number;
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  flooded?: boolean;
  aborted?: boolean;
  sawEnd?: boolean;
}): boolean {
  if (p.sawEnd || p.aborted || p.flooded) return true;
  const elapsed = p.now - p.startedAt;
  if (elapsed >= p.hardTimeoutMs) return true;
  if (elapsed >= p.idleTimeoutMs && p.now - p.lastDataAt >= 3000) return true;
  return false;
}

/** 命中交互式提问时给出的「这是什么 + 怎么改」 */
export interface InteractivePrompt {
  /** 提问类型（密码 / 是-否确认 / 任意键继续…） */
  what: string;
  /** 推荐的改法 */
  fix: string;
}

/**
 * 交互式提问的特征。**只在「输出已安静 + 提问出现在末尾」时才用**（见 execCommand）。
 *
 * 为什么必须提前识别：这些命令不会退出，也不会报错 —— 它就是在等键盘输入。
 * 旧实现只能干等到静默超时（120s）才把「可能在等输入」写进观察，
 * 每踩一次白烧两分钟，20 分钟的任务上限经常被一两次密码提示吃掉。
 *
 * 全部按「整行匹配」写，且要求提问在输出末尾：`grep password: /etc/x` 这类
 * 把关键字当正文打出来的场景不会命中（正文行不会以 `Password:` 单独结尾）。
 */
const INTERACTIVE_PROMPT_RULES: { re: RegExp; p: InteractivePrompt }[] = [
  {
    re: /^\[sudo\] password for .+:\s*$/im,
    p: {
      what: "sudo 密码",
      fix: "引擎无法代你输密码 —— 换具备 NOPASSWD 的 sudo 规则，或直接用无需提权的账号/命令",
    },
  },
  {
    re: /^(?:enter\s+|input\s+)?(?:the\s+)?(?:current\s+|new\s+|retype\s+|repeat\s+|confirm\s+)?(?:password|passwd|passphrase)(?: for [^:\n]+)?\s*:\s*$/im,
    p: {
      what: "密码",
      fix: "改用密钥/免密方式；确需密码时由人在终端里手动执行这一步",
    },
  },
  {
    re: /^enter passphrase for key [^\n]*:\s*$/im,
    p: { what: "私钥口令", fix: "用 `ssh-agent` 预先加载带口令的私钥，或换无口令的部署密钥" },
  },
  {
    re: /(?:\[(?:y\/n|yes\/no|Y\/n|y\/N)\]|\((?:y\/n|yes\/no)\))\s*[:?]?\s*$/im,
    p: {
      what: "是/否确认",
      fix: "加非交互参数重发：`-y` / `--assumeyes` / `--yes` / `DEBIAN_FRONTEND=noninteractive`",
    },
  },
  {
    re: /^(?:are you sure you want to (?:continue|proceed)|do you want to (?:continue|proceed|remove|overwrite|install))[^\n]*\?\s*$/im,
    p: {
      what: "确认提问",
      fix: "加 `-y` / `--force` / `--non-interactive` 等非交互参数重发；先看清它要确认什么再决定",
    },
  },
  {
    re: /^(?:press (?:any key|the enter key|enter)|hit enter)[^\n]*$/im,
    p: { what: "等待按键", fix: "换成非交互参数（`-y` / `--batch` / `--quiet`），或用 `yes |` 喂输入" },
  },
  {
    re: /^are you sure you want to continue connecting \(yes\/no\)\?/im,
    p: {
      what: "SSH 主机指纹确认",
      fix: "先在终端里手动接受一次指纹（或预置 known_hosts），再重试",
    },
  },
];

/** 尾部安静多久才判定「它在等输入」（有输出在动就说明不是等输入） */
const INTERACTIVE_QUIET_MS = 700;

/**
 * 从输出尾部判断是否停在交互式提问。
 *
 * 只看**最后两行**：提问必然在末尾，且引擎只在输出安静 700ms 后调用，
 * 因此不会被「先打印一句 Password: 再继续跑」的正常日志骗到。
 */
export function detectInteractivePrompt(tail: string): InteractivePrompt | null {
  const lines = tail
    .split(/\r?\n/)
    // **先剥掉引擎自己的哨兵片段再匹配**：包装脚本的 `echo "TERMAI_EXIT_x:seg:N:$?"`
    // 会紧跟在不带换行的提问后面，拼成 `Password: TERMAI_EXIT_x:seg:1:0` 一行。
    // 各条规则都要求提问在**行尾**（`:\s*$`），被哨兵一粘就全部失效 ——
    // 真实主机实测 `echo -n "Password: "; read -s pw` 因此硬等满 120 秒才超时。
    // 哨兵只可能由引擎产生，剥掉它不影响对真实输出的判断。
    .map((l) => l.replace(/TERMAI_(?:BEGIN|EXIT|END)_[A-Za-z0-9]+(?::[A-Za-z0-9]+)*/g, ""))
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  const last = lines.slice(-2).join("\n");
  for (const r of INTERACTIVE_PROMPT_RULES) {
    if (r.re.test(last)) return r.p;
  }
  return null;
}

/**
 * 按顶层 `&&` / `||` 切分（引号内不拆、不拆 `|`、不拆单 `&`）。
 *
 * 与 `splitCommandParts` 分开写：后者还拆 `;`，而这里只需要逻辑链。
 * 单独一个函数是为了不动已被真实主机验证过的 `;` 分段路径 —— 那条路
 * 每段无条件执行，语义简单；`&&`/`||` 有短路，必须连带短路状态一起建模。
 */
export function splitLogicChain(command: string): { sep: string; text: string }[] {
  const parts: { sep: string; text: string }[] = [];
  let buf = "";
  let sep = "";
  let quote: '"' | "'" | null = null;
  const s = command ?? "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "\\") {
      buf += ch + (s[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === "&" && s[i + 1] === "&") {
      parts.push({ sep, text: buf });
      buf = "";
      sep = "&&";
      i += 1;
      continue;
    }
    if (ch === "|" && s[i + 1] === "|") {
      parts.push({ sep, text: buf });
      buf = "";
      sep = "||";
      i += 1;
      continue;
    }
    buf += ch;
  }
  parts.push({ sep, text: buf });
  return parts.map((p) => ({ sep: p.sep, text: p.text.trim() })).filter((p) => p.text.length > 0);
}

/** 链式包装用的状态变量名（前缀够生僻，不会撞上模型自己起的名字） */
const CHAIN_VAR = "__termai_rc";

export function buildExecScript(command: string, tags: AgentEchoTags, scriptPath: string): string {
  const { begin, exitTag, end } = tags;
  if (needsScriptFile(command)) {
    return [
      `cat > ${scriptPath} <<'TERMAI_AGENT_EOF'`,
      command.trim(),
      `TERMAI_AGENT_EOF`,
      `echo "${begin}"`,
      `bash ${scriptPath}`,
      `echo "${exitTag}:$?"`,
      `echo "${end}"`,
      `rm -f ${scriptPath}`,
    ].join("\n");
  }

  const flat = flattenCommand(command);
  const parts = splitCommandParts(flat);
  const canSegment =
    parts.length > 1 &&
    !parts.some((p) => /&\s*$/.test(p.text)) &&
    balancedBraces(flat) &&
    parts.every((p, i) => i === 0 || p.sep === ";");

  if (canSegment) {
    const segs = parts.map((p, i) => `{ ${p.text}; echo "${exitTag}:seg:${i + 1}:$?"; }`);
    return `echo "${begin}"; ${segs.join("; ")}; echo "${exitTag}:$?"; echo "${end}"`;
  }

  // ---- 逻辑链（`a && b` / `a || b`）：逐段打点，但**不破坏短路语义** ----
  //
  // 为什么必须逐段：`A && B || C` 的整条退出码只反映「最后执行的那一段」。
  // `cd /tmp && rm -rf build || echo failed` 里 cd 失败 → rm 根本没跑 → echo 成功
  // → 整条退出码 0，模型收到「成功」，在错误前提上继续推进。
  //
  // 为什么不能简单套 `{ A; echo $?; } && B`：花括号组的退出码是组内最后一条
  // （即 echo）的退出码，恒为 0 —— 一插就把短路语义改成了「永远继续」。
  // 所以这里改成「把链展开成等价的 if 阶梯」，状态存在 `${CHAIN_VAR}` 里：
  //   A; rc=$?;            # `;`/首段无条件执行
  //   if rc==0 → B; rc=$?   else 打 skip（短路跳过，rc 保持不变）
  //   if rc!=0 → C; rc=$?   else 打 skip
  // 跳过不动 rc，正是 bash 的语义（`A && B` 失败后 `|| C` 该执行）。
  const chain = splitLogicChain(flat);
  const canChain =
    chain.length > 1 &&
    chain.length <= 8 &&
    !chain.some((p) => /&\s*$/.test(p.text)) &&
    balancedBraces(flat) &&
    chain.every((p, i) => i === 0 || p.sep === "&&" || p.sep === "||");

  if (canChain) {
    const out: string[] = [`echo "${begin}"`];
    chain.forEach((p, i) => {
      const n = i + 1;
      const run = `{ ${p.text}; ${CHAIN_VAR}=$?; }`;
      const mark = `echo "${exitTag}:seg:${n}:$${CHAIN_VAR}"`;
      if (i === 0) {
        out.push(`${run}; ${mark}`);
      } else if (p.sep === "&&") {
        out.push(`if [ "$${CHAIN_VAR}" -eq 0 ]; then ${run}; ${mark}; else echo "${exitTag}:seg:${n}:skip"; fi`);
      } else {
        out.push(`if [ "$${CHAIN_VAR}" -ne 0 ]; then ${run}; ${mark}; else echo "${exitTag}:seg:${n}:skip"; fi`);
      }
    });
    // 整条链的退出码 = 最后一段（含被跳过时保持的）状态。
    // 用子 shell `(exit N)` 把状态原样落成 $?：不能写成 `false`，那会把 2 抹成 1。
    // 这一行本身不含哨兵 token，会随 PTY 回显漏进输出 —— 由 stripEcho /
    // isWrapperEchoLine 按 CHAIN_VAR 特征剔除（见两处实现）。
    out.push(`if [ "$${CHAIN_VAR}" -eq 0 ]; then true; else (exit $${CHAIN_VAR}); fi`);
    out.push(`echo "${exitTag}:$?"`);
    out.push(`echo "${end}"`);
    // 多行下发：每行都被 PTY 单独当一条输入，不会撞上行缓冲上限
    return out.join("\n");
  }

  return `echo "${begin}"; ${flat}; echo "${exitTag}:$?"; echo "${end}"`;
}

/**
 * 在终端里执行一条命令，并返回它的输出与退出码。
 *
 * 实现要点：
 * - 用 echo 打上 BEGIN/EXIT/END 三个唯一哨兵，从数据流中精确切分
 * - BEGIN/END 的匹配要求「独占一行」，从而跳过 PTY 对整条脚本的回显
 * - 支持 heredoc / 多行脚本：落盘为临时脚本再执行，结束后自动清理
 * - 超时或中断时，退化为返回已收集到的全部输出
 */
export async function execCommand(
  sessionId: string,
  command: string,
  opts: ExecOptions = {}
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const maxTimeoutMs = Math.max(opts.maxTimeoutMs ?? 60000, timeoutMs);
  const token = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const begin = `TERMAI_BEGIN_${token}`;
  const end = `TERMAI_END_${token}`;
  const exitTag = `TERMAI_EXIT_${token}`;
  /** 三条哨兵打包成一个对象：显示侧过滤与 switch 都要用（token 唯一，可按精确子串匹配） */
  const echoTags: AgentEchoTags = { begin, exitTag, end };

  const script = buildExecScript(command, echoTags, `/tmp/termai_agent_${token}.sh`);

  let buffer = "";
  let display = ""; // 已清理并推送的累积显示文本
  let sawEnd = false;
  let lastFlush = 0;
  let cleanedLen = 0; // 已清理过的 buffer 长度，下次只扫增量
  /**
   * 输出洪水开关。上限按字符而非字节数，够用且和 buffer.length 同口径。
   *
   * 真实故障：`cat /usr/local/bin/prometheus` 把 100MB+ 的 ELF 倒进 PTY ——
   * buffer 一路涨到上百 MB，每 200ms 还要把累积 display 全量推给 UI，
   * 这一步跑了 320 秒、卡在输出超时，整个终端被乱码刷满。
   * 这里做兜底：任何命令（含死循环刷屏、无 head 的 journalctl）一旦超过上限，
   * 立即停止收集并打断远端命令，只保留头尾片段用于判因。
   */
  const MAX_BUFFER_CHARS = 600_000;
  const MAX_DISPLAY_CHARS = 120_000;
  let flooded = false;
  /** 命中交互式提问：记下来用于提前收尾（见下面的 while 循环） */
  let interactive: InteractivePrompt | null = null;

  // 结束哨兵必须「独占一行」才算数，详见 makeSentinelMatcher 的说明。
  const matchEnd = makeSentinelMatcher(end);

  const unsub = subscribeTerminalOutput((sid, data) => {
    if (sid !== sessionId) return;
    // 已判定洪水：后续数据一律丢弃（远端会被 wait 循环里的中断尽快掐掉）
    if (flooded) return;
    buffer += data;
    if (buffer.length > MAX_BUFFER_CHARS) {
      flooded = true;
      // 保留头尾：头部能看出是什么命令在刷，尾部可能含着结束哨兵/退出码
      const half = Math.floor(MAX_BUFFER_CHARS / 2);
      buffer =
        buffer.slice(0, half) + "\n…（输出过大，中段已丢弃）…\n" + buffer.slice(-half);
    }
    if (!sawEnd && matchEnd(buffer)) sawEnd = true;

    const now = Date.now();
    // 节流 400ms：每次回调都会 zustand set → 重建 buckets → React 重渲染，而这些
    // 全部跑在 renderer 主线程上，与 Agent 循环是同一个线程。200ms 时刷屏输出
    // 会明显拖慢循环本身的推进（表现为「AI 变慢了」，其实是被自己的 UI 拖住）。
    if (now - lastFlush >= 400) {
      lastFlush = now;
      // 只清理「本次新增」的片段并拼进累积显示，避免每 200ms 全量扫描整个
      // （可能很大的）buffer —— 那是 O(n²) 的根源，cat 大日志时会卡顿。
      const chunk = buffer.slice(cleanedLen);
      cleanedLen = buffer.length;
      if (chunk) display += stripEcho(chunk, echoTags);
      // 显示缓冲同样设上限：终端窗口本身有全量输出，这里没必要把上百 MB
      // 反复推给 UI（那是卡顿的直接来源）。
      if (display.length > MAX_DISPLAY_CHARS) {
        const half = Math.floor(MAX_DISPLAY_CHARS / 2);
        display = display.slice(0, half) + "\n…（更早输出已省略）…\n" + display.slice(-half);
      }
      opts.onOutput?.(display);
    }
  });

  try {
    const w = window as unknown as {
      __termai_writeTerminal?: (sid: string, data: string) => Promise<boolean>;
    };

    // 下发前先确认终端仍然在线：若连接中途断开，直接报错而非傻等 60s 硬超时
    const session = useTerminalStore.getState().sessions.find((s) => s.id === sessionId);
    if (!session?.connected) {
      throw new Error("终端已断开连接，无法执行命令");
    }

    // PTY 里「回车」是 \r，把脚本里的换行统一转成 \r，等价于逐行敲回车
    const payload = script.replace(/\r?\n/g, "\r") + "\r";
    // 开启哨兵过滤窗口：从下发到命令收尾，终端窗口里不再出现包装噪声。
    // 只影响「显示」与「终端上下文」，emitTerminalOutput 的原始流不经过它 ——
    // 下面收集 buffer 的订阅必须拿到含哨兵的原文，否则判不出命令结束。
    beginAgentEchoFilter(sessionId, echoTags, command);
    const wrote = (await w.__termai_writeTerminal?.(sessionId, payload)) ?? false;
    if (!wrote) {
      endAgentEchoFilter(sessionId);
      throw new Error("命令下发失败：终端未就绪或已断开");
    }

    // 等待输出收尾。两条优化：
    // 1) 轮询 25ms：纯感知延迟优化 —— 哨兵判定逻辑一个字没动（仍是「独占一行」匹配），
    //    只是更快发现命令已经结束，每条命令省下几十毫秒。
    // 2) 超时自适应：超过基础超时后，只要「最近 3 秒仍有新数据」就继续等，
    //    直到硬上限。find / du 这类慢命令不会被硬切成半截输出误导 AI 判断。
    const startedAt = Date.now();
    let lastDataAt = startedAt;
    let lastLen = 0;

    while (!sawEnd) {
      const now = Date.now();
      // 交互式提问提前收尾：输出安静 700ms + 尾部命中提问特征 → 它就是在等键盘。
      // 不再干等 120s 静默超时：那段时间里远端进程占着 stdin，后续命令会被当输入吞掉，
      // 而且任务 20 分钟上限常被一两次密码提示吃掉。
      if (!interactive && !flooded && now - lastDataAt >= INTERACTIVE_QUIET_MS) {
        const hit = detectInteractivePrompt(buffer.slice(-800));
        if (hit) interactive = hit;
      }
      if (interactive) break;
      // 熔断判据抽成纯函数（shouldAbortWait）：输出洪水、中断、静默卡死、
      // 到达硬上限 —— 四种终止条件集中一处，便于单测覆盖「还在吐输出时不该切」。
      if (
        shouldAbortWait({
          now,
          startedAt,
          lastDataAt,
          idleTimeoutMs: timeoutMs,
          hardTimeoutMs: maxTimeoutMs,
          flooded,
          aborted: opts.signal?.aborted,
        })
      ) {
        break;
      }
      await sleep(25);
      if (buffer.length !== lastLen) {
        lastLen = buffer.length;
        lastDataAt = Date.now();
      }
    }
    // 没能正常收尾（超时 / 用户中止）：远端进程多半还占着 shell 的 stdin。
    // 不把它打断，本轮后续脚本乃至下一轮 Agent 的命令都会被它当输入吞掉，
    // 输出彻底错位 —— 详见 abortRemoteCommand 的说明。
    if (!sawEnd) {
      await abortRemoteCommand(w, sessionId);
    }
    // 收到结束标记后只需极短缓冲（END 是最后一条输出，后面只剩提示符）
    await sleep(sawEnd ? 80 : 150);
  } finally {
    unsub();
    // 收尾后关闭过滤窗口：之后的数据（下一次命令、用户手敲）一律原样显示
    endAgentEchoFilter(sessionId);
  }

  // 交互式提问被提前掐掉 ≠ 超时：超时是「不知道它在干嘛」，交互是「明确在等输入」，
  // 给模型的下一步完全不同（后者加个 -y 就能过），所以两个标记必须分开。
  const timedOut = !sawEnd && !interactive;
  // 收尾时基于完整 buffer 再清理一次，消除增量拼接可能残留的哨兵边界碎片
  opts.onOutput?.(stripEcho(buffer, echoTags));

  const parsed = extractResult(buffer, begin, end, exitTag);
  if (parsed) {
    return {
      output: parsed.output,
      exitCode: parsed.exitCode,
      segmentStatus: parsed.segmentStatus,
      segments: parsed.segments,
      timedOut,
      script,
      flooded,
      interactive: interactive ?? undefined,
    };
  }
  // 兜底：没切到哨兵（脚本回显丢失等极端情况），退化为返回已清理的整段缓冲。
  // 注意必须走 stripEcho 而不是裸 cleanTerminalText —— 后者会把 PTY 回显的整条
  // 包装脚本（`echo "TERMAI_BEGIN_xxx"; ls ...; echo "TERMAI_EXIT_xxx:$?"`）原样
  // 交给模型，模型可能照抄这个模式自己拼哨兵，导致下一轮嵌套哨兵、切分全乱。
  return {
    output: stripEcho(buffer, echoTags),
    exitCode: null,
    segmentStatus: [],
    segments: [],
    timedOut,
    script,
    flooded,
    interactive: interactive ?? undefined,
  };
}

export interface BatchExecOptions extends ExecOptions {
  /** 某条命令开始执行 */
  onItemStart?: (index: number) => void;
  /** 某条命令的实时输出 */
  onItemOutput?: (index: number, output: string) => void;
  /** 某条命令结束（成功或失败都会回调） */
  onItemDone?: (index: number, result: ExecResult) => void;
}

/**
 * 批量执行一批命令（按顺序串行，避免输出在终端里交织导致哨兵失效），
 * 全部完成后一次性返回。用于把「多次 AI 往返的只读探测」压缩成一次。
 */
export async function execCommandBatch(
  sessionId: string,
  commands: string[],
  opts: BatchExecOptions = {}
): Promise<ExecResult[]> {
  const results: ExecResult[] = [];
  for (let i = 0; i < commands.length; i++) {
    if (opts.signal?.aborted) break;
    const cmd = commands[i];
    opts.onItemStart?.(i);
    try {
      const res = await execCommand(sessionId, cmd, {
        timeoutMs: opts.timeoutMs,
        maxTimeoutMs: opts.maxTimeoutMs,
        signal: opts.signal,
        onOutput: (out) => opts.onItemOutput?.(i, out),
      });
      results.push(res);
      opts.onItemDone?.(i, res);
    } catch (e) {
      const failed: ExecResult = {
        output: "",
        exitCode: null,
        timedOut: false,
        script: cmd,
        error: (e as Error)?.message ?? String(e),
      };
      results.push(failed);
      opts.onItemDone?.(i, failed);
    }
  }
  return results;
}

/**
 * 生成「哨兵是否已出现」的判定器。
 *
 * 判据是**独占一行**，而不是简单的子串包含 —— PTY 会把整段脚本原样回显回来，
 * 回显里同样含有 `TERMAI_END_xxx` 字样（形如 `echo "TERMAI_END_xxx"`）。
 * 若用 includes 判定，命令还没开始执行就会误认为已结束，循环立刻退出，
 * 慢命令只能拿到残缺输出，且 timedOut=false / exitCode=null 会被上层 isOk()
 * 当成「执行成功」，AI 会基于假成功继续操作远程主机。
 *
 * 返回的判定器内部缓存正则，并先用 includes 做廉价预筛 —— 命中才跑正则，
 * 避免在大 buffer（cat 大日志）上每次输出都全量匹配。
 */
export function makeSentinelMatcher(sentinel: string): (buffer: string) => boolean {
  const re = new RegExp(`(?:^|\\r?\\n)${sentinel}`);
  return (buffer: string) => buffer.includes(sentinel) && re.test(buffer);
}

/**
 * 从缓冲区里切出 BEGIN..END 之间的真实输出，并解析退出码（含逐段退出码）。
 *
 * 导出仅为可单测：它是「哨兵 → 输出/退出码」的唯一出口，分段打点的解析正确性
 * 直接决定模型看到的是成功还是失败，必须有端到端用例锁住。
 */
/** 单段命令的执行结果（整体命令里被 `;` 串联的某一子段） */
export interface SegmentOutput {
  /** 段序号（与分段打点一致，1-based） */
  index: number;
  /** 该段的退出码 */
  code: number;
  /** 该段因短路条件不成立被跳过（`a && b` 里 a 失败时的 b） */
  skipped?: boolean;
  /** 该段独立的标准输出：从整段输出里按 seg 边界行切分出来，模型可据此归因 */
  output: string;
}

/**
 * 判断一行是不是「包装脚本自身的回显」，而非命令的真实输出。
 *
 * 单行包装时整条脚本都在 BEGIN 之前被回显，按 BEGIN 切片天然不含它；
 * **多行脚本（heredoc 落盘）不是这样**：脚本先写盘，BEGIN 打印出来之后
 * 才逐条执行 `bash /tmp/termai_agent_<token>.sh`、`echo "TERMAI_EXIT_…:$?"`、
 * `echo "TERMAI_END_…"`，这些行就落在切片区间里。真实主机实测（CentOS 7）
 * 输出会变成：
 *   `[root@mgt ~]# bash /tmp/termai_agent_xxx.sh` + `n=1…` + `[root@mgt ~]# echo "TERMAI_EXIT_xxx:$?"`
 * 模型拿到这段会以为终端协议就是这样的，下一轮照抄 `echo "TERMAI_EXIT_..."`，
 * 于是嵌套哨兵、切分全乱。这里按 token 精确剔除（token 随机，不会误伤真实输出）。
 */
function isWrapperEchoLine(line: string, tags: AgentEchoTags): boolean {
  if (
    line.includes(tags.begin) ||
    line.includes(tags.exitTag) ||
    line.includes(tags.end)
  ) {
    return true;
  }
  if (line.includes("TERMAI_AGENT_EOF")) return true;
  // 逻辑链包装的状态行（`if [ "$__termai_rc" -eq 0 ]; then true; ...`）不含哨兵 token，
  // 只能按状态变量名认领 —— 它是引擎生成的，绝不可能是命令的真实输出。
  if (line.includes(CHAIN_VAR)) return true;
  const token = tags.begin.replace(/^TERMAI_BEGIN_/, "");
  return line.includes(`termai_agent_${token}.sh`);
}

export function extractResult(
  buffer: string,
  begin: string,
  end: string,
  exitTag: string
): {
  output: string;
  exitCode: number | null;
  segmentStatus: { index: number; code: number; skipped?: boolean }[];
  segments: SegmentOutput[];
} | null {
  // 要求哨兵独占一行：避免匹配到 PTY 回显的 `echo "TERMAI_BEGIN_xxx"; ...`
  const beginRe = new RegExp(`(?:^|\\r?\\n)${begin}\\r?\\n`);
  const bm = buffer.match(beginRe);
  if (!bm || bm.index === undefined) return null;

  let rest = buffer.slice(bm.index + bm[0].length);

  const endRe = new RegExp(`(?:^|\\r?\\n)${end}`);
  const em = rest.match(endRe);
  if (em && em.index !== undefined) {
    rest = rest.slice(0, em.index);
  }

  // 逐段打点（`<exitTag>:seg:<序号>:<退出码>`）：脚本里 `{ ${p.text}; echo "${exitTag}:seg:${i+1}:$?"; }`
  // 会让它**独占一行**地印在终端上。用「整行」匹配，既能解析退出码，又能以这些边界行为界
  // 切出「每一段各自的输出」—— 模型才能把输出归因到具体段，而不是拿到一坨混在一起的文本
  // （这是「命令越跑越多」的根因：模型分不清哪段失败，只好换个 pattern 重发）。
  const segLineRe = new RegExp(`^\\s*(?:echo\\s+)?["']?${exitTag}:seg:(\\d+):(\\d+|skip)["']?\\s*$`);
  const overallExitLineRe = new RegExp(`^\\s*(?:echo\\s+)?["']?${exitTag}:\\d+["']?\\s*$`);
  const lines = rest.split(/\r?\n/);
  const boundaries: { lineIdx: number; index: number; code: number; skipped: boolean }[] = [];
  lines.forEach((line, i) => {
    const m = line.match(segLineRe);
    if (m)
      boundaries.push({
        lineIdx: i,
        index: Number(m[1]),
        code: m[2] === "skip" ? 0 : Number(m[2]),
        skipped: m[2] === "skip",
      });
  });

  const segmentStatus: { index: number; code: number; skipped?: boolean }[] = [];
  const segments: SegmentOutput[] = [];
  for (let k = 0; k < boundaries.length; k++) {
    const b = boundaries[k];
    segmentStatus.push(b.skipped ? { index: b.index, code: 0, skipped: true } : { index: b.index, code: b.code });
    // 本段输出 = 上一边界行（或开头）到本边界行之间的文本
    const startLine = k === 0 ? 0 : boundaries[k - 1].lineIdx + 1;
    const endLine = b.lineIdx - 1;
    // **必须逐行剔掉包装回显**：PTY 会把脚本本身回显出来，而逻辑链包装是**多行下发**的，
    // 于是 `[root@mgt ~]# { true; __termai_rc=$?; }; echo "TERMAI_EXIT_xxx:seg:1:$__termai_rc"`
    // 这类行会落在「上一段的输出区间」里。整体 output 走了 isWrapperEchoLine 所以干净，
    // 分段输出若不过滤，模型就会在观察里看到哨兵 token —— 它可能照抄这个模式自己拼哨兵，
    // 导致下一轮嵌套哨兵、切分全乱（heredoc 形态踩过同一个坑，链式包装是新增形态）。
    const segLines =
      endLine >= startLine
        ? lines.slice(startLine, endLine + 1).filter((l) => !isWrapperEchoLine(l, { begin, exitTag, end }))
        : [];
    segments.push({
      index: b.index,
      code: b.code,
      skipped: b.skipped || undefined,
      output: cleanTerminalText(segLines.join("\n")),
    });
  }
  segmentStatus.sort((a, b) => a.index - b.index);
  segments.sort((a, b) => a.index - b.index);

  let exitCode: number | null = null;
  const exitRe = new RegExp(`${exitTag}:(\\d+)`);
  const xm = rest.match(exitRe);
  if (xm) {
    exitCode = Number(xm[1]);
  }

  // 去掉 seg 边界行与整体退出码行，得到与旧实现一致的整体输出（各段输出拼接）
  const tags: AgentEchoTags = { begin, exitTag, end };
  const cleanedLines = lines.filter(
    (line, i) =>
      !boundaries.some((b) => b.lineIdx === i) &&
      !overallExitLineRe.test(line) &&
      !isWrapperEchoLine(line, tags)
  );
  const output = cleanTerminalText(cleanedLines.join("\n"));

  return { output, exitCode, segmentStatus, segments };
}

/**
 * 去掉 PTY 对脚本自身的回显、清理控制符。
 *
 * 两类噪声都要走这里：
 *   1. 回显行 —— `<提示符> echo "TERMAI_BEGIN_xxx"; <命令> 2>&1; …`；
 *   2. 哨兵自身的输出行 —— `TERMAI_BEGIN_xxx` / `TERMAI_EXIT_xxx:0` / `TERMAI_END_xxx`。
 * 旧实现只按 `echo "TERMAI_` 前缀判断，第 2 类里只有 BEGIN 靠 split 顺带清掉，
 * EXIT / END 两行会留在 Agent 面板的实时输出里（纯显示噪声）。
 * 按精确 token 匹配后三类一并处理，且不会误伤命令自身的真实输出。
 */
function stripEcho(buffer: string, tags: AgentEchoTags): string {
  const lines = buffer.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (line.includes('echo "TERMAI_BEGIN_')) continue;
    if (line.includes('echo "TERMAI_END_')) continue;
    if (line.includes('echo "TERMAI_EXIT_')) continue;
    if (line.includes(tags.begin)) continue;
    if (line.includes(tags.exitTag)) continue;
    if (line.includes(tags.end)) continue;
    if (line.includes("TERMAI_AGENT_EOF")) continue;
    // 逻辑链包装的状态行：不含 token，按状态变量名剔除（见 buildExecScript）
    if (line.includes(CHAIN_VAR)) continue;
    kept.push(line);
  }
  const text = cleanTerminalText(kept.join("\n"));
  // 极端情况下 BEGIN 标记泄漏到展示里，顺手清掉
  return text.split(tags.begin).join("").trim();
}

function cleanTerminalText(s: string): string {
  // 先归一换行，再整段剥控制序列（含 ESC(B —— 见 stripControlSequences 的说明）
  return stripControlSequences(s.replace(/\r\n/g, "\n").replace(/\r/g, "")).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 输出清洗：把终端原始输出变成「信息密度高、体量可控」的文本。
 * 终端输出常带 ANSI 颜色/光标控制符、大量空行、以及几万行的日志（cat 大文件、
 * find /、journalctl 全量），直接喂给模型既浪费 token 又淹没关键信息。
 * 只做无损或近无损的收敛：去控制符、压连续空行、超行数时保留头尾、
 * 单行过长时截断。**不改行内内容**，保证模型仍能读到真实错误原文。
 */
// ESC 用运行时拼接：直接写 \x1B 会触发 eslint 的 no-control-regex。
const ESC_CHAR = String.fromCharCode(27);

/**
 * 终端控制序列（全部 ESC 引导的形态）。
 *
 * 只剥 CSI（`ESC [ … m`）远远不够 —— 真机实测（CentOS 7 + yum）：
 * ```
 * 原始字节：No package package-does-not-exist-xyz<27>(B<27>[m available.
 * 旧清理后：No package package-does-not-exist-xyz(B available.
 * ```
 * yum 用 `ESC(B`（切换字符集）+ `ESC[m`（复位属性）把**包名**包起来：
 * CSI 被剥掉，剩下的 `ESC(B` 里 ESC 又被「删 C0 控制符」吃掉，`(B` 就
 * **粘在包名后面**了。模型拿到的是 `docker-ce(B`，于是反复安装一个不存在的
 * 包名，装几个小时都装不完 —— 这不是显示瑕疵，是观察原文被污染。
 *
 * 所以必须整段匹配剥除，而不是只删 ESC 这一个字节。
 */
const ANSI_SEQ_RE = new RegExp(
  [
    // OSC：ESC ] … BEL 或 ESC \
    `${ESC_CHAR}\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)`,
    // DCS / SOS / PM / APC：ESC P|X|^|_ … ESC \
    `${ESC_CHAR}[PX^_][^\\x1b]*(?:\\x1b\\\\)`,
    // CSI：ESC [ 参数 中间字节 终止字节
    `${ESC_CHAR}\\[[0-9;?]*[\\x20-\\x2F]*[@-~]`,
    // 字符集指定：ESC ( B / ESC ) 0 / ESC # 8
    `${ESC_CHAR}[()#][0-9A-Za-z]`,
    // 单字符序列：ESC 7 / 8 / = / > / M / E / D / H / c
    `${ESC_CHAR}[=>78cDEHM]`,
  ].join("|"),
  "g"
);

/** C0 控制符（保留 \t \n \r，这三个由调用方各自处理） */
// eslint-disable-next-line no-control-regex
const C0_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * 剥掉终端控制序列，不改变可见文本。
 * 调用方负责先处理 \r（进度条回显），这里只管 ESC 序列与不可见控制符。
 */
export function stripControlSequences(s: string): string {
  return s.replace(ANSI_SEQ_RE, "").replace(C0_RE, "");
}

/**
 * 「内容确实被省略了」的标注（sanitizeOutput 的行数收敛 / focusOutput 的区间省略）。
 *
 * 用它判断观察是否不完整，而不是比较字符长度：去掉 ANSI 颜色码、\r、连续空行
 * 都会让文本变短，但那不是丢信息。用长度判定会给几乎所有正常输出都挂上
 * 「已截断」的标签，模型因此以为自己缺数据，反复换写法重取同一个目标。
 */
const OMIT_MARK_RE = /（已省略 \d+ 行中间输出）|（省略第 \d+/;

/** 包管理器 / 容器拉取的命令族（这类命令的输出 80% 是进度与包列表噪声） */
const PKG_MANAGER_RE =
  /(?:^|[;&|]\s*|\bsudo\s+)(?:yum|dnf|apt-get|apt|zypper|pacman|rpm|dpkg|pip3?|npm|yarn|gem|docker\s+(?:pull|build))\b/;

export function isPackageManagerCommand(command: string): boolean {
  return PKG_MANAGER_RE.test(command);
}

/**
 * 安装类命令的噪声行特征。
 *
 * 背景：`yum install -y docker-ce` 真实输出常 1000–3000 行，其中 90% 是
 * `---> Package ...` 列表、`Downloading packages:`、`[=====>   ] 45%` 进度条。
 * 这些行进上下文毫无价值，却会：① 吃掉 8000 字符观察预算（把真正有用的
 * 「依赖冲突 / GPG 错误 / 磁盘不足」挤掉）；② 让模型每轮都在读无关文本。
 * 只删「确定性噪声」，任何含错误关键词的行**一律保留**。
 */
const INSTALL_NOISE_RE =
  /^\s*(?:--->\s*(?:Package|Running|Verifying|Dependency)|-->\s*(?:Processing Dependency|Running transaction check|Finished Dependency Resolution|Checking deps for|Resolving Dependencies)|Downloading|Retrieving|Loaded plugins|Resolving Dependencies|Dependencies Resolved|Running transaction|Transaction (?:check|test)|Importing GPG key|Reading package lists|Building dependency tree|Reading state information|Preparing to unpack|Unpacking|Selecting previously unselected|Setting up |Processing triggers|Get:\d+|Ign:\d+|Hit:\d+|Fetched |Looking in indexes|Collecting |Requirement already satisfied|(?:Installing|Upgrading|Erasing|Verifying|Cleanup|Obsoleting|Downgrading)\s*:|\[\d+\/\d+\]|\*\s+[A-Za-z0-9_.-]+:\s+\S+|={10,})/i;

/**
 * 去掉安装日志里的确定性噪声，保留错误行与结果行。
 *
 * 判据刻意保守：**只要一行里出现错误关键词就保留**，宁可多留也不误删 ——
 * 删错一行「冲突/磁盘不足」的代价，远大于多留 10 行包列表。
 */
export function stripInstallNoise(text: string): { text: string; dropped: number } {
  const out: string[] = [];
  let dropped = 0;
  for (const line of text.split("\n")) {
    const noise =
      INSTALL_NOISE_RE.test(line) ||
      // 进度条：`[====>    ] 45%` / `  45% [======]`
      /\[\s*[=#>*.-]{3,}\s*\]|\b\d{1,3}%\s*\[=/.test(line);
    if (noise && !OUT_ERR_RE.test(line)) {
      dropped++;
      continue;
    }
    out.push(line);
  }
  return { text: out.join("\n"), dropped };
}

export function sanitizeOutput(text: string, maxLines = 80, maxLineLen = 0): string {
  // \r 常见于 PTY 进度条回显；ESC 序列（不止 CSI，还有 ESC(B 这类字符集切换）
  // 对模型全是噪音，必须整段剥除 —— 见 stripControlSequences 的真机案例。
  // 最后一步做凭证脱敏：密码/token/私钥进了上下文就等于上传到第三方，且对诊断无价值。
  const cleaned = redactSecrets(stripControlSequences(text.replace(/\r/g, "")));
  let lines = cleaned.split("\n");
  if (maxLineLen > 0) {
    lines = lines.map((l) =>
      l.length > maxLineLen ? `${l.slice(0, maxLineLen)} …（该行过长已截断）` : l
    );
  }
  // 连续空行压成一个，纯空白行直接去掉
  const compact: string[] = [];
  let blank = 0;
  for (const l of lines) {
    if (!l.trim()) {
      blank += 1;
      if (blank > 1) continue;
    } else {
      blank = 0;
    }
    compact.push(l);
  }
  if (compact.length <= maxLines) return compact.join("\n");
  const headN = Math.max(1, Math.floor(maxLines * 0.3));
  const tailN = maxLines - headN;
  const head = compact.slice(0, headN);
  const tail = compact.slice(-tailN);
  return [
    ...head,
    `……（已省略 ${compact.length - headN - tailN} 行中间输出）`,
    ...tail,
  ].join("\n");
}

/**
 * 输出里的「错误 / 异常」行。
 *
 * 这是模型判断「上一步到底成没成」的第一依据，必须在任何预算分配里**最优先**保住。
 * 曾经的做法是「有错误关键词就走聚焦、没有就直接取前 N 字符」——
 * 但真实日志（journalctl / 编译输出 / systemctl status）里正常行远多于错误行，
 * 一旦按字符数硬切，错误行几乎必然落在被切掉的中间段：模型拿到一屏「看起来正常」的
 * 输出，于是判定「没问题」继续往下推，或者在下一轮换个写法把同一条命令再跑一遍。
 */
const OUT_ERR_RE =
  /error|fail|exception|refused|denied|not found|cannot|unable|traceback|fatal|no such|permission|could not|abort|busy|read-?only|not permitted|invalid|missing|unsupported|timed? ?out|out of memory|oom-kill|killed process|segmentation fault|core dumped|no space left|disk quota|too many open files|connection reset|broken pipe/i;

/**
 * 高信息量「状态行」：端口 / 监听 / 服务状态 / 版本 / 容量。
 *
 * 与错误行分开是因为它们数量大、价值次一档（df/ps/ss 的输出里几乎每行都命中），
 * 只能在小额度内补充，不能和错误行抢预算。
 */
const OUT_INFO_RE =
  /\b(?:listening|bound|active|inactive|enabled|disabled|running|stopped|version|release|architecture|uptime|load average|used|avail)\b|(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}|\*:\d{2,5}/i;

/**
 * 超长输出聚焦：在字符预算内按**优先级**取行，并把「省掉了哪几行」明确告诉模型。
 *
 * 优先级（这是本函数存在的全部意义）：
 *   ① 首行 —— 版本号 / 路径 / 表头，决定「这是什么、从哪来」
 *   ② 末行 —— 最终状态 / 汇总 / 退出前的最后一条日志，决定「成了没有」
 *   ③ 错误/异常行 —— 决定「错在哪」
 *   ④ 状态行（端口/服务/容量）—— 决定「现在是什么状态」
 *   ⑤ 头部连续正文、尾部连续正文对半分剩余预算
 *
 * 旧实现有两个硬伤：
 * - **没有错误关键词时直接 `text.slice(0, budget)`** —— 尾部（最终状态、最后一条报错）
 *   被整段丢弃，且没有任何提示，模型以为输出就这么多；
 * - 有错误关键词时，超预算的兜底顺序是「错误行 → 头部」，尾部同样会丢。
 *
 * 现在无论有没有错误关键词都保留尾部，并且用 `…（省略第 a~b 行）` 标注空洞：
 * 模型知道自己缺什么、缺在哪里，需要时可以用 `原命令 | sed -n 'a,bp'` 精确取回，
 * 而不是把整条命令重跑一遍（重跑会被重复闸门拒绝，白烧一轮往返）。
 */
function focusOutput(text: string, budget: number): string {
  const lines = text.split("\n");
  // 少于 8 行没有「中间段」可省，按字符截断即可（同时保住单行巨串 / 无换行二进制的老行为）
  if (lines.length < 8) return text.slice(0, budget);

  const errIdx: number[] = [];
  const infoIdx: number[] = [];
  const seen = new Set<string>();
  /** 命中错误模式的总行数（去重前）：用来告诉模型「同类错误重复了多少处」 */
  let errTotal = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const isErr = OUT_ERR_RE.test(t);
    if (isErr) errTotal += 1;
    if (seen.has(t)) continue;
    if (isErr) {
      errIdx.push(i);
      seen.add(t);
    } else if (OUT_INFO_RE.test(t)) {
      infoIdx.push(i);
      seen.add(t);
    }
  }

  // 留 8% 给下面插入的「省略第 a~b 行」标注，避免正文把预算吃满后标注又被挤掉
  const cap = Math.floor(budget * 0.92);
  const picked = new Set<number>();
  let used = 0;
  /** 逐行装入：装不下就跳过（后面更短的行仍有机会进来），不做整段截断 */
  const take = (i: number): void => {
    if (picked.has(i)) return;
    const cost = lines[i].length + 1;
    if (used + cost > cap) return;
    picked.add(i);
    used += cost;
  };

  take(0);
  take(lines.length - 1);
  // 错误行上限 40、状态行上限 20：grep -r / 编译告警能匹配上千行，全塞进来一样爆上下文
  for (const i of errIdx.slice(0, 40)) take(i);
  for (const i of infoIdx.slice(0, 20)) take(i);

  // 剩余预算对半分给头部与尾部正文，保证「开头怎么开始的」和「结尾怎么结束的」都在
  const half = Math.floor(Math.max(0, cap - used) / 2);
  let headUsed = 0;
  for (let i = 1; i < lines.length - 1 && headUsed < half; i++) {
    const before = used;
    take(i);
    headUsed += used - before;
  }
  let tailUsed = 0;
  for (let i = lines.length - 2; i > 0 && tailUsed < half; i--) {
    const before = used;
    take(i);
    tailUsed += used - before;
  }

  const order = [...picked].sort((a, b) => a - b);
  const gapNote = (from: number, to: number): string =>
    from >= to
      ? `…（省略第 ${from} 行）`
      : `…（省略第 ${from}~${to} 行，共 ${to - from + 1} 行）`;
  const out: string[] = [];
  let prev = -1;
  for (const i of order) {
    if (i > prev + 1) out.push(gapNote(prev + 2, i));
    out.push(lines[i]);
    prev = i;
  }
  if (prev < lines.length - 1) out.push(gapNote(prev + 2, lines.length));

  // 错误行号必须点出来：模型据此知道「要去哪儿看」，
  // 也让「输出里没有错误行」这件事变得可判定（而不是靠它自己扫一遍猜）。
  // **只报真正展开出来的那几行** —— 报了行号却没给内容，模型会以为自己去读过，
  // 实际上什么都看不到，比不报更糟。
  const shownErr = errIdx.filter((i) => picked.has(i));
  // 完全相同的内容只留一条（日志刷屏时 5000 行同样的错误没有额外信息量），
  // 但必须把「重复了多少处」说清楚 —— 否则模型会把「刷屏 5000 次」读成「只错了一次」，
  // 严重程度判断直接错一个量级。
  const repeatErr = errTotal - errIdx.length;
  const errHint =
    (shownErr.length > 0
      ? `错误/异常行在第 ${shownErr.slice(0, 8).map((i) => i + 1).join("、")} 行` +
        (shownErr.length > 8 ? ` 等 ${shownErr.length} 处` : "")
      : errIdx.length > 0
        ? `共 ${errIdx.length} 处错误/异常行（预算不足未展开，用 \`grep -n 关键词\` 直接定位）`
        : "未发现错误/异常行") +
    (repeatErr > 0 ? `；另有 ${repeatErr} 行同类错误内容重复，已合并` : "");
  return (
    out.join("\n") +
    `\n（${shownErr.length > 0 ? "已聚焦错误/异常行" : "已聚焦头部与结尾"}：原始输出共 ${
      lines.length
    } 行 / ${text.length} 字符；${errHint}。` +
    `需要被省略的行时：输出来自**文件**就用 \`sed -n 'a,bp' 文件\`；来自**命令**就换更窄的参数重取` +
    `（\`-n 50\`、\`grep 关键词\`、\`--since\`），**不要原样重跑整条命令**。）`
  );
}

/**
 * 从命令里提取「HTTP 探测目标」（host[:port]）。
 *
 * 用途：识别「对着同一个服务反复更换 URL 路径」的空转。真实故障里模型为了确认
 * Prometheus 有没有起来，连发了 `/-/health`、`/-/status`、`/api/v1/status` 等
 * 多个**猜出来的**路径，大部分是 404 —— 它换了字符串，但没有换方法。
 * 只识别 curl / wget 的显式 URL，解析不出就返回 null（不做任何猜测）。
 */
export function probeTargetOf(cmd: string): string | null {
  const m = cmd.match(/\b(?:curl|wget)\b[^|;&]*?\bhttps?:\/\/([^\s/'"`]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * 探测输出是否「没有提供任何有效信息」。
 *
 * 判据是空输出，或 404 / 连接失败 / 超时这类**没有区分度**的响应 ——
 * 模型从这种输出里学不到任何东西，于是只能不断换一个 URL 字符串再试。
 * 反过来，只要拿到了 200 的真实内容，就说明这条路是通的，不该提示换代。
 */
export function isNoInfoProbeOutput(text: string): boolean {
  if (!text.trim()) return true;
  return /\b404\b|not found|connection refused|no route to host|could not resolve|empty reply|timed out|failed to connect/i.test(
    text
  );
}

/** 可能出现在「失败行」里的关键词（命中才纳入签名统计） */
const ERR_LINE_RE =
  /error|fail|denied|not permitted|permission|no such|cannot|unable|refused|busy|read-?only|exception|fatal|traceback/i;

/**
 * 从失败输出里抽取归一化的「错误签名」。
 *
 * 用途：识别「同一个错误反复出现」的原地打转。
 *
 * 真实故障：模型为了清掉 NFS 残留，连发两轮 `rm -rf`（第二轮把子目录列得更全），
 * 十几条命令全部返回 `rm: cannot remove '<路径>': Operation not permitted` ——
 * 它换了更细的路径，但没有换方法；而这条结论就写在它自己刚拿到的输出里，它没读。
 *
 * 归一化：把引号内的内容、裸路径、数字替换成占位符再折叠空白，于是
 * 「同一类错误、不同路径」会落到同一个签名上（`rm: cannot remove <>: operation not permitted`）。
 * 取出现次数**最多**的形态，让「刷屏式重复报错」压过零星的其他错误；
 * 没有可识别的错误行时返回 null —— 不做任何猜测。
 */
export function errorShapeOf(output: string): string | null {
  const shapes = new Map<string, number>();
  for (const raw of (output ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !ERR_LINE_RE.test(line)) continue;
    const shape = line
      .replace(/["'`][^"'`]*["'`]/g, "<>") // 引号包裹的内容（路径 / 名字 / 报错原文）
      .replace(/\/[\w./@+-]+/g, "<>") // 没被引号包的裸路径
      .replace(/\b\d+\b/g, "N") // 行号 / errno / 计数
      .replace(/\s+/g, " ")
      .toLowerCase()
      .slice(0, 120)
      .trim();
    if (!shape) continue;
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [shape, n] of shapes) {
    if (n > bestN) {
      best = shape;
      bestN = n;
    }
  }
  return best;
}

/**
 * 挂载点占用（EBUSY）的**确定性**提示。
 *
 * 为什么要单独做这个：`Device or resource busy` 是**内核状态**，不是参数写错。
 * 实测（CentOS 7，真实主机）：
 * - 目录里含挂载点时，`rm -rf 父目录` 逐条报 busy 并返回 **1**；
 * - 紧接着 `umount 父目录` 报 `not mounted` 并返回 **32**（父目录根本不是挂载点）；
 * - `umount` 真正的挂载点后才删得掉。
 * 截图里模型正是「find → rm -rf → umount 父目录」三步连续踩空：错误签名每步都不同，
 * 连击提醒（createFailTreadmill）永远凑不够两次，于是它继续换写法打转。
 *
 * 失败信息已经进了上下文仍然打转 → 按项目约定要补**不依赖模型记忆**的确定性提示，
 * 而不是只加提示词规则。
 */
export function busyMountHint(output: string): string {
  const text = output ?? "";
  if (!/device or resource busy|target is busy|device is busy|mount point is busy/i.test(text)) {
    return "";
  }
  return (
    `\n\n[系统] 上面的 \`Device or resource busy\` / \`target is busy\` 是**挂载点被占用**（内核状态），` +
    `不是权限问题、也不是路径写错 —— 换参数、换写法、换 rm 的形式重试都不会成功。\n` +
    `1. 目录里**含有挂载点**时，\`rm -rf\` 只能删掉普通文件，挂载点本身必然 busy；\n` +
    `2. 先 \`mount | grep -F "要删的路径"\` 找出真正的挂载点，\`umount <挂载点>\` 成功后再删父目录；\n` +
    `3. \`umount\` 报 \`not mounted\` 说明那一条根本不是挂载点 —— 不要重复试，先在 \`mount\` 列表里确认；\n` +
    `4. \`/run\`、\`/proc\`、\`/sys\` 是内核/运行时目录（\`/run\` 是 tmpfs，重启即清空），删它们**不释放磁盘空间**；` +
    `容器运行时目录（\`/run/containerd\`、\`/run/docker\`、\`/var/lib/containerd\`）必须先 \`systemctl stop kubelet containerd\` 再处理；\n` +
    `5. 如果目标其实是**释放磁盘空间**，先用 \`df -h\` 看哪个挂载点真的满了，去清那里的数据（\`/run\` 不计入磁盘占用）。`
  );
}

/** systemd 启动失败的三种原文形态 → 服务名 */
function failedServiceOf(text: string): string | null {
  const m =
    text.match(/Job for ([\w@.:-]+?)\.service failed/i) ||
    text.match(/Failed to start ([\w@.:-]+?)(?:\.service)?\b/i) ||
    text.match(/Unit ([\w@.:-]+?)\.service (?:entered|is) failed/i);
  const name = (m?.[1] ?? "").replace(/\.service$/i, "").trim();
  return name || null;
}

/** 从 `systemctl is-active/status/start X` 里取服务名 */
function serviceNameFromCommand(command?: string): string | null {
  if (!command) return null;
  const m = command.match(
    /systemctl\s+(?:--\S+\s+)*(?:is-active|is-failed|status|start|restart|enable|show)\s+(?:--\S+\s+)*([\w@.:-]+)/i
  );
  const name = (m?.[1] ?? "").replace(/\.service$/i, "").trim();
  return name && name !== "--now" ? name : null;
}

/**
 * 服务起不来时的**确定性**提示（systemd / journald）。
 *
 * 为什么必须由引擎注入而不是只写进提示词：`systemctl start` 失败时 systemd 只回
 * `Job for docker.service failed because the control process exited with error code` ——
 * **根因一个字都没有**。模型只能反复 start，而每次失败要空等 60~90 秒
 * （启动超时 + systemd 自动重启 holdoff）。真机实测（CentOS 7）：一次 `systemctl start docker`
 * 耗时 65 秒，三轮下来十几分钟就没了，这正是「装几个小时也装不完」的主要耗时来源。
 *
 * 另外两类原文也在这里一并解释，它们几乎总是伴随出现：
 * - `exec: "runc": executable file not found in $PATH`：包记录里装了、文件却不在（安装被中断的半装状态）；
 * - `failed to dial "/run/containerd/containerd.sock": context deadline exceeded`：上游服务没起。
 */
export function serviceDiagHint(output: string, command?: string): string {
  const text = output ?? "";
  const parts: string[] = [];

  // 两种命中方式：
  // 1) 输出里有 systemd 的失败原文（带服务名）；
  // 2) `systemctl is-active X` 只回一个 `failed` —— 真机实测（Type=simple 的服务）
  //    `systemctl start` 会返回 **0**，服务其实立刻退出了，唯一的线索就是这行 `failed`。
  //    模型很容易把 start 的 0 当成「起来了」，所以这条必须同样提示。
  const svc =
    failedServiceOf(text) ??
    (/^\s*failed\s*$/m.test(text) ? serviceNameFromCommand(command) : null);
  if (svc) {
    parts.push(
      `\n\n[系统] \`${svc}\` 现在是失败状态，而 systemd **没有给出根因** —— 它只说「进程退出了」，` +
        `真正的原因在 journald 里。注意 \`systemctl start\` 返回 0 **不代表起来了**（Type=simple 的服务会立即返回），` +
        `以 \`is-active\` 的结果为准。\n` +
        `**不要重复 start**：每次失败要空等 60~90 秒（启动超时 + 自动重启的 holdoff），` +
        `连试几次就把时间耗光了，而信息一个字都没多。\n` +
        `下一步用**一条**命令取根因：\n` +
        `\`systemctl status ${svc} --no-pager; journalctl -u ${svc} -n 40 --no-pager\`\n` +
        `读到具体错误行（缺依赖 / 端口被占 / 配置写错 / 权限 / 内核不支持）再动手修。`
    );
  }

  const missing = text.match(/exec: \\?"?([\w.+-]+)\\?"?: executable file not found in \$?PATH/i);
  if (missing?.[1]) {
    const bin = missing[1];
    parts.push(
      `\n\n[系统] \`${bin}\` 找不到，**不代表它对应的包没装**。真机上最常见的是「包管理器记录里是已安装，` +
        `文件却不在」（上一次安装被中断/被强杀留下的半装状态），此时装别的包、改 PATH、加软链全都无效。\n` +
        `先分清三件事：\n` +
        `1. 谁提供它：\`rpm -q --whatprovides '*/${bin}'\`（Debian：\`dpkg -S '*/${bin}'\`）；\n` +
        `2. 记录里装了没：\`rpm -q <包名>\` 回 \`is installed\` 但 \`command -v ${bin}\` 为空 → 就是半装；\n` +
        `3. 半装直接重装：\`yum reinstall -y <包名>\`（Debian：\`apt-get install --reinstall -y <包名>\`），` +
        `装完立刻 \`command -v ${bin}\` 验收。`
    );
  }

  if (/failed to dial \\?"?[^"\s]*\.sock|dial unix [^\s:]+: connect: no such file/i.test(text)) {
    const sock = text.match(/([\w./-]+\.sock)/)?.[1] ?? "服务自己的 .sock";
    parts.push(
      `\n\n[系统] \`${sock}\` 连不上，说明**它依赖的上游服务没在跑**（socket 不存在），不是网络问题、` +
        `也不是数据目录坏了。下游每次都要空等 60 秒左右才报 \`context deadline exceeded\`。\n` +
        `按依赖顺序先起上游，再起下游，例如容器运行时：\n` +
        `\`systemctl enable --now containerd && systemctl is-active containerd && systemctl restart docker\`\n` +
        `（上游 \`is-active\` 不是 \`active\` 时不要去重启下游，先把上游修好。）`
    );
  }

  return parts.join("");
}

/**
 * 「同类错误连击」跟踪器。
 *
 * 与去重台账的分工：去重台账看**命令文本**，抓不到「每轮换一条相似命令、错误却完全一样」
 * 这种原地打转（模型把路径列得越来越细，文本去重认为是新命令）；这里看**错误签名**，互补。
 *
 * 节奏：连续 2 次同一签名 → 判定「换写法」这条路已经走不通，提醒一次；
 * 之后每再连击 2 次重复提醒（既不每轮刷屏，也不只提醒一次就沉默）。
 */
export function createFailTreadmill(): {
  observe: (output: string, ok: boolean) => void;
  note: () => string;
} {
  let shape = "";
  let streak = 0;
  let notifiedAt = 0;
  return {
    observe(output: string, ok: boolean) {
      if (ok) return;
      const next = errorShapeOf(output);
      if (!next) return;
      if (next === shape) {
        streak += 1;
      } else {
        shape = next;
        streak = 1;
        notifiedAt = 0;
      }
    },
    note() {
      if (streak < 2 || streak - notifiedAt < 2) return "";
      notifiedAt = streak;
      return (
        `\n\n[系统] 你已经连续 ${streak} 次失败，都栽在**同一个原因**上：\`${shape}\`。\n` +
        `**换命令不等于换方法** —— 在同一个错误签名上继续换路径 / 换参数 / 换写法都是原地打转。请换到**不同层面**：\n` +
        `① 先判性质：\`Operation not permitted\` / \`Device or resource busy\` / \`Read-only file system\` 属于「内核或权限拒绝」，**加 sudo、换更细的路径都不会有用**；\n` +
        `② 再用 \`mount | grep 目标路径\` 确认目标是不是**挂载点**，\`ls -ld 目标\` 看它的真实身份；\n` +
        `③ 是挂载点就 \`umount 挂载点\` 卸载（或重启对应服务让它重建），**不是去删里面的文件**。\n` +
        `如果确实无路可走，请用 ${AGENT_DONE} 写明根因与需要人工执行的命令。`
      );
    },
  };
}

/** 单条命令观察的保底字符数：低于它模型连一条完整报错行都读不全 */
export const OBS_MIN_PER_COMMAND = 800;

/**
 * 按任务类型给步数预算。
 *
 * 旧实现一刀切 20 步。但「装一个 docker」的真实步数是：查系统 → 配源 → 装依赖 →
 * 装包 → 启动 → 自启 → 验证 → 失败重试，正常也要 12–18 步，一次 GPG 错误重试就直接
 * 撞上限被强制收尾 —— 用户看到的正是「跑几个小时也装不完」。
 * 安装/部署/编译这类**长事务**必须有更多步；纯排查/查询类仍然 20 步，避免它空转。
 *
 * 步数不是白给的：每步都是一次完整请求。所以只对「确实需要多步」的动词放宽，
 * 且上限锁死 36 —— 再多就该怀疑它跑偏了，而不是给它更多子弹。
 */
export function stepBudgetFor(goal: string): number {
  const longTask =
    /(安装|部署|搭建|配置|迁移|升级|编译|扩容|接入|对接|初始化|install|deploy|setup|configure|provision|migrate|upgrade|bootstrap|compile)/i;
  return longTask.test(goal ?? "") ? 36 : 20;
}

/**
 * 整条命令是否算成功：任一分段失败即视为失败。
 *
 * 不能只看 `exitCode`：它只反映**最后一条**子命令（见 ExecResult.segmentStatus）。
 * `rm /nope; du /tmp` 会给出 exitCode 0 —— 若据此标绿并记入「已成功」，模型就被
 * 告知了一个错误的成功，后面所有判断都建立在错误前提上。
 */
export function isExecOk(res: ExecResult): boolean {
  if (res.error) return false;
  // 停在交互提问上被掐掉的命令，什么都没完成 —— 不能算成功（否则台账会标 ✓，
  // 下一轮用它当「已成功」的依据，直接在错误前提上推进）。
  if (res.interactive) return false;
  if (res.segmentStatus?.some((s) => !s.skipped && s.code !== 0)) return false;
  return res.exitCode === 0 || res.exitCode === null;
}

/**
 * 观察预算分配：每条先给保底，剩余预算按「还差多少」从大到小补给被截断最严重的条目。
 *
 * 取代原先的「按条数均摊」：一次 4 条只读探测时，均摊会把每条压到 `maxChars/4`
 * （3000 预算下只有 750 字符）。`df -h` / `ps aux` / `journalctl` 轻轻超 ——
 * 模型只能在残缺信息上决策，决策错了反被上层判成「空转」。按需分配下，
 * 输出短的那几条不会白占预算，长的那条能拿到最多，总预算不变。
 */
export function allocateObservationBudget(lengths: number[], total: number, minPer: number): number[] {
  const n = lengths.length;
  if (n === 0) return [];
  const budgets = lengths.map((l) => Math.min(minPer, Math.max(0, l)));
  let left = Math.max(0, total - budgets.reduce((a, b) => a + b, 0));
  // 每轮把剩余预算整份交给「缺口最大」的那条；缺口填满后自动轮到下一条。
  // n 最多 4，循环次数有界。
  while (left > 0) {
    let idx = -1;
    let need = 0;
    for (let i = 0; i < n; i++) {
      const d = lengths[i] - budgets[i];
      if (d > need) {
        need = d;
        idx = i;
      }
    }
    if (idx === -1) break;
    const give = Math.min(left, need);
    budgets[idx] += give;
    left -= give;
  }
  return budgets;
}

/**
 * 分段退出码渲染：任一段非 0 就显式点出来。
 *
 * 必须显式，因为整条命令的退出码只反映最后一段 —— 不点明的话模型会把
 * 「末段成功」当成「整条成功」，然后在错误前提上继续推进。
 */
export function renderSegmentStatus(segs?: { index: number; code: number; skipped?: boolean }[]): string {
  if (!segs || segs.length < 2) return "";
  const text = segs.map((s) => `第 ${s.index} 段 → ${s.skipped ? "未执行" : s.code}`).join("，");
  const failed = segs.filter((s) => !s.skipped && s.code !== 0);
  if (failed.length === 0) return `分段退出码：${text}`;
  const skipped = segs.filter((s) => s.skipped);
  return (
    `分段退出码：${text}\n` +
    `⚠️ 这条命令里有 ${failed.length} 段执行失败（第 ${failed.map((s) => s.index).join("、")} 段）` +
    (skipped.length > 0
      ? `；另有第 ${skipped.map((s) => s.index).join("、")} 段因前一条件不成立被跳过（没跑，不要当成成功）`
      : "") +
    `。**整条命令的退出码只反映最后一段，不能当作成功依据** —— 请针对失败的那几段排查。`
  );
}

/**
 * 把执行结果包装成喂给模型的观察（observation）消息。
 * 支持一次传入多条（批量探测）：预算按「保底 + 按需」分配（见 allocateObservationBudget），
 * 而不是按条数简单均摊 —— 避免长输出条目把预算吃光、其余条目只剩残片。
 */
export function buildObservation(
  entries: Array<{ command: string; result: ExecResult }>,
  maxChars = 6000,
  goal?: string
): string {
  const total = Math.max(1, entries.length);
  const lines: string[] = [
    total > 1
      ? `[系统] 已在终端真实执行 ${entries.length} 条命令，以下是各自结果（多段命令已按段拆分，每段带自己的退出码与输出）。`
      : "[系统] 命令已在终端真实执行完毕。",
  ];

  // 先把每条命令展开成「输出块」：多段命令（顶层 `;` 串联）拆成每段一块，
  // 每段带自己的退出码与输出，模型才能把输出归因到具体段 —— 否则多段输出混成一坨，
  // 模型看不出「哪段没匹配到 / 哪段失败」，只会换 pattern 重发（命令越跑越多的根因）。
  type Chunk = {
    headerLines: string[];
    rawOut: string;
  };
  const chunks: Chunk[] = [];
  /**
   * 安装类命令先去噪声（进度条 / 包列表），再走正常的聚焦与预算。
   * 只在输出确实很长时才动：短输出里的每一行都可能有用。
   */
  const prepInstall = (cmd: string, raw: string): string => {
    if (raw.length < 1500 || !isPackageManagerCommand(cmd)) return raw;
    const { text, dropped } = stripInstallNoise(raw);
    return dropped > 0
      ? `${text}\n…（已省略 ${dropped} 行安装进度/包列表噪声；错误行与结果行均保留，完整日志在终端里）`
      : text;
  };
  entries.forEach((entry, idx) => {
    const { command, result } = entry;
    const num = total > 1 ? `${idx + 1}` : "";
    const segs = result.segments;
    const timedOutFlag = result.timedOut
      ? "（等待输出超时被强制终止。若是长耗时任务，请改用后台启动 + 轮询日志的方式；若是安装/配置类命令，请加非交互参数（-y、DEBIAN_FRONTEND=noninteractive 等）后重发）"
      : "";
    const interactiveFlag = result.interactive
      ? `（⚠️ 命令停在交互式提问「${result.interactive.what}」上、已被引擎主动中断 —— 它不是在跑，是在等键盘输入，` +
        `再等多久都不会有结果。改法：${result.interactive.fix}）`
      : "";
    const errFlag = result.error ? ` 执行异常：${result.error}` : "";

    if (segs && segs.length >= 1) {
      if (segs.length === 1) {
        const rawOut = prepInstall(command, segs[0].output || "(无输出)");
        const exitText = segs[0].code === null ? "未知（未捕获到退出码）" : String(segs[0].code);
        chunks.push({
          headerLines: [
            total > 1 ? `### ${num}. \`${command}\`` : `命令：\`${command}\``,
            `退出码：${exitText}${timedOutFlag}${interactiveFlag}${errFlag}`,
          ],
          rawOut,
        });
      } else {
        // 多段：命令头只显示一次，下面逐段列「第 N 段 + 退出码 + 输出」
        const segNote = renderSegmentStatus(result.segmentStatus);
        segs.forEach((seg, si) => {
          const rawOut = prepInstall(command, seg.output || "(无输出)");
          const segLabel = seg.skipped
            ? `· 第 ${seg.index} 段 未执行（前一条件不成立，短路跳过）`
            : `· 第 ${seg.index} 段 退出码：${seg.code}`;
          const headerLines =
            si === 0
              ? [
                  total > 1 ? `### ${num}. \`${command}\`` : `命令：\`${command}\``,
                  ...(segNote ? [segNote] : []),
                  segLabel,
                ]
              : [segLabel];
          chunks.push({ headerLines, rawOut });
        });
      }
    } else {
      const rawOut = prepInstall(command, result.output || "(无输出)");
      const exitText = result.exitCode === null ? "未知（未捕获到退出码）" : String(result.exitCode);
      const segNote = renderSegmentStatus(result.segmentStatus);
      chunks.push({
        headerLines: [
          total > 1 ? `### ${num}. \`${command}\`` : `命令：\`${command}\``,
          `退出码：${exitText}${timedOutFlag}${interactiveFlag}${errFlag}`,
          // 兼容「有 segmentStatus 但没 segments」的旧 shape（测试与极少数历史记录）：
          // 仍把分段退出码总览带出来，否则模型看不到「中间段失败」的提示。
          ...(segNote ? [segNote] : []),
        ],
        rawOut,
      });
    }
  });

  // 先做无损清洗（控制符/空行收敛），再按块分配预算。
  //
  // 这里的行数上限**故意放到几乎不生效**（100000 行）：行数收敛和字符聚焦是两道
  // 独立的闸门，而 `sanitizeOutput` 是先按行数砍头尾、再交给 `focusOutput` 按字符取，
  // 只要行数上限真的生效，中间整段（包括错误行）会在第一步就被丢掉 ——
  // focusOutput 根本没有机会看到它们，模型拿到的全是头尾正常输出，误判成「没问题」。
  // 唯一的体积上限交给下面的「预算 + focusOutput」，它按字符算，才是真实占用。
  const cleaned = chunks.map((c) => sanitizeOutput(c.rawOut, 100000));
  const budgets = allocateObservationBudget(
    cleaned.map((o) => o.length),
    maxChars,
    OBS_MIN_PER_COMMAND
  );

  chunks.forEach((chunk, idx) => {
    const budget = budgets[idx] ?? OBS_MIN_PER_COMMAND;
    let out = cleaned[idx];
    const overBudget = out.length > budget;
    if (overBudget) out = focusOutput(out, budget);
    // 「是否真的丢了内容」只能看**省略标注**，不能比长度。
    // sanitizeOutput 会去掉 ANSI 颜色码、\r 和连续空行 —— 那些不是信息，长度必然变短；
    // 旧实现用 `out.length < rawOut.length` 判定，于是**任何带颜色或空行的正常输出**
    // 都会被标成「输出过长已截断」。模型看到这句会以为自己缺了一半信息，
    // 于是换个写法再取一遍（实测就是「同一个目标反复看」的源头之一）。
    const truncated = overBudget || OMIT_MARK_RE.test(cleaned[idx]);
    // focusOutput 自己已经在尾部说明了「省了哪几行、怎么取回」，这里不再重复一篇；
    // 只有「单行超长被字符截断」和「被 sanitizeOutput 的行数上限砍掉」两种情况才补一句。
    const focused = out.includes("（已聚焦");
    lines.push(
      "",
      ...chunk.headerLines,
      "输出：",
      "```",
      out,
      "```",
      truncated && !focused
        ? `（输出过长已截断：原始 ${chunk.rawOut.split("\n").length} 行 / ${chunk.rawOut.length} 字符；` +
          `上面是按「首行 + 错误行 + 结尾」聚焦后的视图，被省略的行有「省略第 a~b 行」标注。` +
          `需要它们时：文件输出用 \`sed -n 'a,bp' 文件\`；命令输出换更窄的参数重取，不要原样重跑整条命令。）`
        : ""
    );
  });

  lines.push(
    "",
    "基于以上真实输出决定下一步：还缺信息就用 <<<RUN>>> 给命令（只读无依赖的可批量一次给）；已达成目标用 <<<DONE>>> 给总结。"
  );
  if (goal) lines.push(`目标：${goal}`);
  return lines.join("\n");
}
