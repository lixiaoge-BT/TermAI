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
  /** 最后一次成功执行拿到的输出片段（原文摘录） */
  digest: string;
}

export interface DupTracker {
  /** 记录一次真实执行（只有真的下发执行过才调用） */
  record(command: string, ok: boolean, output?: string): void;
  /** 是否属于「已成功执行过 ≥2 次、不必再跑」的命令 */
  isDuplicate(command: string): boolean;
  /** 该命令此前成功执行时拿到的输出片段（用于拒绝时回填，省掉「再确认一次」的往返） */
  lastDigest(command: string): string;
  /** 拒绝原因（逐字重复 / 同族变体），null = 放行。附带可直接展示给模型的说明 */
  dupReason(command: string): DupReason | null;
}

/** 拒绝原因：`exact` = 逐字相同；`family` = 同一目标换 flag 再看一遍 */
export interface DupReason {
  kind: "exact" | "family";
  /** 同族的其它写法（用于告诉模型「你已经用这几种姿势看过同一个目标了」） */
  siblings: string[];
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
export function createDupTracker(): DupTracker {
  const stats = new Map<string, DupEntry>();
  // 族计数：族键 → 执行次数 / 最后是否成功 / 族内出现过的写法（最多留 3 条用于解释）
  const fam = new Map<string, { n: number; lastOk: boolean; members: string[] }>();
  const countKeys = (cmd: string): string[] => {
    const subs = splitSubCommands(cmd);
    // 单条命令只算自己一个键：拆开只会得到它自身，徒增重复计数
    return (subs.length > 1 ? subs : [cmd]).map(normalizeCmd).filter((k) => k.length > 0);
  };
  // 逐字重复判定（`isDuplicate` / `dupReason` 共用，避免依赖 `this` 绑定）
  const isExactDup = (command: string): boolean => {
    const keys = countKeys(command);
    if (keys.length === 0) return false;

    // 写操作子命令阈值 = 1：已经成功过一次就不该再跑，哪怕同条命令里还有新的读操作。
    // 这拦住截图里 `rm x; du y` 与 `rm x; du y z` 反复执行的顽疾。
    const writeDup = keys
      .filter((k) => isStateChanging(k))
      .some((k) => {
        const st = stats.get(k);
        return !!st && st.n >= 1 && st.lastOk;
      });
    if (writeDup) return true;

    // 纯读命令：全部子命令都成功 ≥2 次才算重复，给「启动后再确认」留一次复查余量。
    return keys.every((k) => {
      const st = stats.get(k);
      return !!st && st.n >= 2 && st.lastOk;
    });
  };
  return {
    record(command, ok, output) {
      const keys = countKeys(command);
      if (keys.length === 0) return;
      const digest = output === undefined ? "" : digestOutput(output);
      for (const key of keys) {
        const prev = stats.get(key);
        stats.set(key, {
          n: (prev?.n ?? 0) + 1,
          lastOk: ok,
          // 失败那次的片段没有参考价值，保留上一次成功拿到的
          digest: ok || !prev?.digest ? digest : prev.digest,
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
      if (isExactDup(command)) return { kind: "exact", siblings: [] };
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
  };
}

/**
 * 解析 Agent 的回复，严格遵循 <<<RUN>>> / <<<DONE>>> 协议。
 * 若模型没按协议输出（常见），则退化为「整段就是最终结论」，避免死循环。
 */
export function parseAgentReply(text: string): AgentReply {
  const raw = (text ?? "").trim();

  const doneIdx = raw.indexOf(AGENT_DONE);
  if (doneIdx !== -1) {
    const after = raw.slice(doneIdx + AGENT_DONE.length).trim();
    const before = raw.slice(0, doneIdx).trim();
    // 兼容：模型可能在 <<<DONE>>> 之前先给了命令，则命令作废，以结论为准
    return {
      thought: before,
      commands: [],
      done: true,
      finalAnswer: after || before || raw,
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
    return { thought: before, commands: [], done: false, finalAnswer: null, raw, plan };
  }

  const runRegex = new RegExp(
    `${escapeRegExp(AGENT_RUN_START)}([\\s\\S]*?)${escapeRegExp(AGENT_RUN_END)}`
  );
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
   * 逐段退出码（仅当命令由顶层 `;` 串联时才有）。
   *
   * 为什么必须单独记录：`$?` **只反映最后一条子命令**。`rm /nope; du /tmp` 里
   * `rm` 明明失败了，末条 `du` 成功 → 整条退出码 0 → 界面绿、模型也读到「成功」，
   * 于是它在错误的前提上继续推进。这是整条链路上唯一一处「信息在源头就是错的」。
   * `&&`/`||` 不参与分段（插打点会破坏短路语义），此时该字段为空。
   */
  segmentStatus?: { index: number; code: number }[];
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
      if (opts.signal?.aborted) break;
      // 输出洪水：不再等哨兵，立刻跳出并打断远端命令（否则会一直刷到硬超时）
      if (flooded) break;
      const now = Date.now();
      const elapsed = now - startedAt;
      if (elapsed >= maxTimeoutMs) break;
      if (elapsed >= timeoutMs && now - lastDataAt >= 3000) break;
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

  const timedOut = !sawEnd;
  // 收尾时基于完整 buffer 再清理一次，消除增量拼接可能残留的哨兵边界碎片
  opts.onOutput?.(stripEcho(buffer, echoTags));

  const parsed = extractResult(buffer, begin, end, exitTag);
  if (parsed) {
    return {
      output: parsed.output,
      exitCode: parsed.exitCode,
      segmentStatus: parsed.segmentStatus,
      timedOut,
      script,
      flooded,
    };
  }
  // 兜底：没切到哨兵（脚本回显丢失等极端情况），退化为返回已清理的整段缓冲。
  // 注意必须走 stripEcho 而不是裸 cleanTerminalText —— 后者会把 PTY 回显的整条
  // 包装脚本（`echo "TERMAI_BEGIN_xxx"; ls ...; echo "TERMAI_EXIT_xxx:$?"`）原样
  // 交给模型，模型可能照抄这个模式自己拼哨兵，导致下一轮嵌套哨兵、切分全乱。
  return { output: stripEcho(buffer, echoTags), exitCode: null, segmentStatus: [], timedOut, script, flooded };
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
export function extractResult(
  buffer: string,
  begin: string,
  end: string,
  exitTag: string
): { output: string; exitCode: number | null; segmentStatus: { index: number; code: number }[] } | null {
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

  // 逐段打点（`<exitTag>:seg:<序号>:<退出码>`）先解析并从输出里剔除。
  // 注意它带 `seg:` 中缀，因此不会被下面的整体退出码正则误匹配。
  const segmentStatus: { index: number; code: number }[] = [];
  const segRe = new RegExp(`${exitTag}:seg:(\\d+):(\\d+)`, "g");
  rest = rest.replace(segRe, (_m, i: string, c: string) => {
    segmentStatus.push({ index: Number(i), code: Number(c) });
    return "";
  });
  segmentStatus.sort((a, b) => a.index - b.index);

  let exitCode: number | null = null;
  const exitRe = new RegExp(`${exitTag}:(\\d+)`);
  const xm = rest.match(exitRe);
  if (xm) {
    exitCode = Number(xm[1]);
    rest = rest.replace(exitRe, "");
  }

  return { output: cleanTerminalText(rest), exitCode, segmentStatus };
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
    kept.push(line);
  }
  const text = cleanTerminalText(kept.join("\n"));
  // 极端情况下 BEGIN 标记泄漏到展示里，顺手清掉
  return text.split(tags.begin).join("").trim();
}

function cleanTerminalText(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .trim();
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
// ANSI CSI 序列（颜色/光标控制）。ESC 用运行时拼接：直接写 \x1B 会触发
// eslint 的 no-control-regex，而这类控制符对模型全是噪音，必须剥掉。
const ANSI_CSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[\\x20-\\x2F]*[@-~]`, "g");

export function sanitizeOutput(text: string, maxLines = 80, maxLineLen = 0): string {
  // \r 常见于 PTY 进度条回显；ANSI CSI 序列是颜色/光标控制，对模型全是噪音
  const cleaned = text.replace(/\r/g, "").replace(ANSI_CSI_RE, "");
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
 * 超长输出聚焦：在字符预算内优先保住「头部 20 行 + 错误/异常行 + 尾部 40 行」。
 * docker build / npm run build 失败时报错几乎总在结尾，所以错误行与尾部是重点；
 * 但头部同样不能丢 —— 版本号、监听端口、路径、配置项这些「正常信息」恰恰是
 * 模型判断下一步要不要换策略的依据。若输出里没有任何错误关键词，则回退为
 * 原「取前 N 字符」截断，保持向后兼容（agent.test.ts 锁定该行为）。
 */
function focusOutput(text: string, budget: number): string {
  const lines = text.split("\n");
  const KEY_RE =
    /error|fail|exception|refused|denied|not found|cannot|unable|traceback|fatal|warning|no such|permission|could not|abort/i;
  // 错误行也设上限：grep -r / 编译告警这类场景能匹配上千行，全塞进来一样会爆上下文
  const errorLines = Array.from(new Set(lines.filter((l) => KEY_RE.test(l)))).slice(0, 30);
  if (errorLines.length === 0) {
    return text.slice(0, budget);
  }
  // 头部 20 行保底：命令开头的正常信息（版本号、监听端口、路径、配置项、统计概要）
  // 恰恰是模型判断「下一步要不要换策略」的依据。此前只留错误行+尾部，模型拿不到
  // 这些字段，只能换个写法把同一条命令再问一遍 —— 那是实打实的浪费。
  // 行数随预算放大（预算大时多留正文），但**下限锁死在 20/40**：
  // 那是实测出来「够模型判断下一步」的底线，往下调会让小预算场景退化。
  const headN = Math.max(20, Math.min(40, Math.round(budget / 200)));
  const tailN = Math.max(40, Math.min(80, Math.round(budget / 100)));
  const head = lines.slice(0, headN);
  const tail = lines.slice(-tailN);
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const l of [...head, ...errorLines, ...tail]) {
    const key = l.trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(l);
  }
  let result = picked.join("\n");
  if (result.length > budget) {
    // 超预算：按「错误行 → 头部」的优先级逐行装入直到用满预算。
    // 旧版这里直接取 errorLines 且**不截断** —— 既可能丢掉头部，也可能比原文更长。
    // 注意必须逐行装入而不是先拼好再 slice：后者会把排在后面的错误行整段切掉。
    const kept: string[] = [];
    let used = 0;
    for (const l of [...errorLines, ...head]) {
      if (used + l.length + 1 > budget) break;
      kept.push(l);
      used += l.length + 1;
    }
    result = kept.join("\n");
  }
  return result + `\n（已聚焦错误/异常行，原始输出 ${text.length} 字符）`;
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
 * 整条命令是否算成功：任一分段失败即视为失败。
 *
 * 不能只看 `exitCode`：它只反映**最后一条**子命令（见 ExecResult.segmentStatus）。
 * `rm /nope; du /tmp` 会给出 exitCode 0 —— 若据此标绿并记入「已成功」，模型就被
 * 告知了一个错误的成功，后面所有判断都建立在错误前提上。
 */
export function isExecOk(res: ExecResult): boolean {
  if (res.error) return false;
  if (res.segmentStatus?.some((s) => s.code !== 0)) return false;
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
export function renderSegmentStatus(segs?: { index: number; code: number }[]): string {
  if (!segs || segs.length < 2) return "";
  const text = segs.map((s) => `第 ${s.index} 段 → ${s.code}`).join("，");
  const failed = segs.filter((s) => s.code !== 0);
  if (failed.length === 0) return `分段退出码：${text}`;
  return (
    `分段退出码：${text}\n` +
    `⚠️ 这条命令里有 ${failed.length} 段执行失败（第 ${failed.map((s) => s.index).join("、")} 段）。` +
    `**整条命令的退出码只反映最后一段，不能当作成功依据** —— 请针对失败的那几段排查。`
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
      ? `[系统] 已在终端真实执行 ${entries.length} 条命令，以下是各自结果。`
      : "[系统] 命令已在终端真实执行完毕。",
  ];

  // 先做无损清洗（控制符/空行收敛），再分配预算。
  // 行数上限从 80 提到 200：`ps aux` / `journalctl` 这类 100+ 行的输出，
  // 原来在「行数收敛」这一步就把中间整段丢了（模型永远看不到感兴趣的进程），
  // 而真正的字符上限由下面的预算 + focusOutput 兜住。
  const cleaned = entries.map((e) => sanitizeOutput(e.result.output || "(无输出)", 200));
  const budgets = allocateObservationBudget(
    cleaned.map((o) => o.length),
    maxChars,
    OBS_MIN_PER_COMMAND
  );

  entries.forEach((entry, idx) => {
    const { command, result } = entry;
    const budget = budgets[idx] ?? OBS_MIN_PER_COMMAND;
    const rawOut = result.output || "(无输出)";
    let out = cleaned[idx];
    let truncated = out.length < rawOut.length;
    if (out.length > budget) {
      out = focusOutput(out, budget);
      truncated = true;
    }
    const exitText = result.exitCode === null ? "未知（未捕获到退出码）" : String(result.exitCode);
    const flags = [
      result.timedOut
        ? "（等待输出超时被强制终止。最常见原因：命令在等待交互输入——如 [Y/n] 确认、密码、配置向导。若是安装/配置类命令，请加非交互参数（-y、DEBIAN_FRONTEND=noninteractive 等）后重发；若是长耗时任务，请改用后台启动 + 轮询日志的方式）"
        : "",
      result.error ? ` 执行异常：${result.error}` : "",
    ].join("");
    const segNote = renderSegmentStatus(result.segmentStatus);

    lines.push(
      "",
      total > 1 ? `### ${idx + 1}. \`${command}\`` : `命令：\`${command}\``,
      `退出码：${exitText}${flags}`,
      ...(segNote ? [segNote] : []),
      "输出：",
      "```",
      out,
      "```",
      truncated ? `（输出过长已截断，共 ${rawOut.length} 字符）` : ""
    );
  });

  lines.push(
    "",
    "基于以上真实输出决定下一步：还缺信息就用 <<<RUN>>> 给命令（只读无依赖的可批量一次给）；已达成目标用 <<<DONE>>> 给总结。"
  );
  if (goal) lines.push(`目标：${goal}`);
  return lines.join("\n");
}
