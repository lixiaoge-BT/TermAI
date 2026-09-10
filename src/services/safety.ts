import type { ParsedCommand } from "@/types";

export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

const RISK_ORDER: RiskLevel[] = ["none", "low", "medium", "high", "critical"];

/** 风险等级排序值（用于比较/取最大值） */
const rank = (r: RiskLevel): number => {
  const i = RISK_ORDER.indexOf(r);
  return i === -1 ? 0 : i;
};

/** 取两个风险里更高的那个 */
export const higherRisk = (a: RiskLevel, b: RiskLevel): RiskLevel =>
  rank(a) >= rank(b) ? a : b;

/** 把风险限制在 ceil 以内（用于压制模型过高的自评） */
export const capRisk = (r: RiskLevel, ceil: RiskLevel): RiskLevel =>
  rank(r) > rank(ceil) ? ceil : r;

/** 风险提升 n 档（用于「模型认为更危险，但我们只认一部分」的折中） */
export const raiseRisk = (r: RiskLevel, steps = 1): RiskLevel =>
  RISK_ORDER[Math.min(RISK_ORDER.length - 1, rank(r) + steps)];

export interface CommandReviewResult {
  command: string;
  riskLevel: RiskLevel;
  isSafe: boolean;
  requireConfirmation: boolean;
  riskDescription: string;
  confirmationItems: string[];
  suggestedAlternative?: string;
  backupSuggestion?: string;
}

// ==================================================================
// 词法层：把复合命令切成最小可执行片段
// ------------------------------------------------------------------
// 旧实现只取「第一个 token」去匹配只读命令表，导致：
//   - `sed -i s/a/b/ f` 命中 sed → 判为只读（漏判，实际会改文件）
//   - `find /tmp -name x -delete` 命中 find → 判为只读（漏判，实际会删文件）
//   - `curl -I xxx` 因为表里存的是 "curl -I" 而永远匹配不上（误判）
// 这里改成：先按顶层分隔符切段（尊重引号），再逐段取 bin + args 判断。
// ==================================================================

/** 顶层分隔符切分，`;` `|` `||` `&&` `&` 换行；引号内的分隔符不切 */
export function splitTopLevel(cmd: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  let lastNonSpace = "";
  const flush = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = "";
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      buf += c;
      if (c === "\\" && quote === '"' && i + 1 < cmd.length) {
        buf += cmd[i + 1];
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
      if (c !== "\\") lastNonSpace = c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      buf += c;
      lastNonSpace = c;
      continue;
    }
    if (c === "\\") {
      buf += c;
      if (i + 1 < cmd.length) buf += cmd[i + 1];
      i += 1;
      continue;
    }
    if (c === "\n") {
      flush();
      continue;
    }
    if (c === ";" || c === "|") {
      flush();
      continue;
    }
    if (c === "&") {
      // `2>&1` 这类重定向里的 & 不是命令分隔符
      if (lastNonSpace === ">") {
        buf += c;
        continue;
      }
      flush();
      continue;
    }
    buf += c;
    if (!/\s/.test(c)) lastNonSpace = c;
  }
  flush();
  return out;
}

/**
 * 去掉 heredoc 正文。
 * `cat > /etc/nginx.conf <<'EOF' ... EOF` 的配置正文里若出现 `rm -rf`、`DROP` 之类的
 * 字面量，不应被当成真正要执行的命令来升风险；同样，heredoc 正文也不该被逐行
 * 当命令解析（每行都是配置文本，会被判成未知命令）。
 */
export function stripHeredocs(cmd: string): string {
  if (!/<</.test(cmd)) return cmd;
  const lines = cmd.split("\n");
  const out: string[] = [];
  let terminator: string | null = null;
  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    out.push(line);
    const m = /(?:^|\s)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*$/.exec(line);
    if (m) terminator = m[2];
  }
  return out.join("\n");
}

export interface CommandSegment {
  raw: string;
  /** 去掉路径后的程序名（/usr/bin/rm → rm） */
  bin: string;
  args: string[];
}

const PRIV_PREFIX = /^(?:sudo|doas|pkexec)\s+/i;
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;

export function parseSegment(raw: string): CommandSegment {
  let s = raw.trim();
  for (;;) {
    const before = s;
    s = s.replace(PRIV_PREFIX, "").trim();
    s = s.replace(ENV_ASSIGN, "").trim();
    if (s === before) break;
  }
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(s) ?? null;
  const rawBin = m?.[1] ?? "";
  const bin = rawBin.replace(/^["']|["']$/g, "").split("/").pop() ?? rawBin;
  const rest = (m?.[2] ?? "").trim();
  return { raw: s, bin, args: rest ? rest.split(/\s+/) : [] };
}

// ==================================================================
// 路径敏感度
// ==================================================================

/** 正好等于这些顶层路径（不带子路径）时，删除 = 系统级不可恢复 */
const FATAL_ROOT =
  /^(?:\/|\/\*|\/etc|\/usr|\/boot|\/root|\/bin|\/sbin|\/lib(?:x32|32|64)?|\/sys|\/proc|\/dev)$/;

/** 删掉/格式化会直接让系统不可用的路径（含其子路径） */
const FATAL_PATH =
  /^(?:\/|\/\*|\/etc|\/usr|\/boot|\/root|\/bin|\/sbin|\/lib(?:x32|32|64)?|\/sys|\/proc|\/dev)(?:\/.*)?$/;

/** 递归删除这些顶层目录后果严重，但通常还不至于让系统起不来 */
const BROAD_PATH = /^(?:\/var|\/opt|\/srv|\/home|\/mnt|\/media)(?:\/.*)?$/;

/**
 * 写入会影响系统/服务行为的路径（比 FATAL 宽，但比「任何路径」窄）。
 * 刻意排除 /usr/local 与 /opt —— 那是用户自装软件的常规落点，
 * `chmod +x /usr/local/bin/x`、`cp x /usr/local/bin/` 不该被抬成中危。
 */
const SYSTEM_WRITE_PATH =
  /^(?:\/|\/etc|\/usr(?!\/local)|\/boot|\/root|\/bin|\/sbin|\/lib(?:x32|32|64)?|\/sys|\/proc|\/dev|\/var\/lib|\/var\/spool)(?:\/.*)?$/;

/** 明显是「临时/构建产物」的删除目标，rm -rf 这类目标降到 low */
const THROWAWAY_TARGET =
  /^(?:\/tmp|\/var\/tmp)(?:\/|$)|(?:^|\/)(?:node_modules|dist|build|target|\.cache|__pycache__|\.next|\.nuxt|\.venv|venv|vendor|\.gradle|\.m2|\.tox|coverage)(?:\/|$)/;

const isFlag = (a: string) => a.startsWith("-") && a.length > 1;

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

function isFatalRoot(p: string): boolean {
  return FATAL_ROOT.test(stripQuotes(p));
}
function isFatalPath(p: string): boolean {
  return FATAL_PATH.test(stripQuotes(p));
}
function isBroadPath(p: string): boolean {
  return BROAD_PATH.test(stripQuotes(p));
}
function isSystemWritePath(p: string): boolean {
  return SYSTEM_WRITE_PATH.test(stripQuotes(p));
}

// ==================================================================
// 规则表：无条件命中的危险模式（对整条命令 + 每个片段分别匹配）
// ==================================================================

interface Rule {
  pattern: RegExp;
  risk: RiskLevel;
  description: string;
  confirm?: string[];
  alternative?: string;
}

const DANGEROUS_RULES: Rule[] = [
  // ---------------- 致命 ----------------
  {
    pattern: /\brm\s+(?:-[a-zA-Z]+\s+)*--no-preserve-root\b/,
    risk: "critical",
    description: "使用 --no-preserve-root 删除根目录，系统将完全不可恢复",
    confirm: ["已备份全系统数据", "确认是在测试机/虚拟机操作", "理解命令将破坏操作系统"],
  },
  {
    // rm -rf / 与 rm -rf /* 的兜底（覆盖 $() / 反引号等切不进片段的写法）；
    // 其余路径交给 rmRisk 按「顶级系统目录 = 致命 / 其子路径 = 高危」细分。
    pattern: /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\s+)+(?:--\s+)?(?:\/|\/\*)(?:\s|$)/,
    risk: "critical",
    description: "递归删除根目录，系统将完全不可恢复",
    confirm: ["已备份全系统数据", "确认不是在生产主机", "理解此命令等价于重装系统"],
  },
  {
    pattern: /\brm\s+(-[rRfFiv]+\s+)*(\.\.?|\*)\s*$/,
    risk: "high",
    description: "删除当前目录（或上级目录）全部内容",
    confirm: ["已确认当前目录正确（非系统目录）", "已备份目录数据"],
    alternative: "先 `pwd` 确认目录，再指定明确的子目录名，如 rm -rf ./app-old",
  },
  {
    pattern: /\b(?:mkfs|mkfs\.[a-z0-9]+|mkswap|wipefs|sgdisk|parted|fdisk|cfdisk)\b/,
    risk: "critical",
    description: "磁盘/分区格式化或分区表操作，目标设备上全部数据将丢失",
    confirm: ["已选择正确的磁盘设备（非系统盘）", "已备份分区内数据", "确认无挂载中的进程在使用"],
  },
  {
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(?:sd[a-z]+\d*|nvme\d+n\d+p?\d*|hd[a-z]+\d*|vd[a-z]+\d*|xvd[a-z]+\d*)/,
    risk: "critical",
    description: "直接写入块设备，可能覆盖分区表或整个磁盘",
    confirm: ["of= 设备正确", "输入镜像文件正确", "已备份目标设备上所有数据"],
  },
  {
    pattern: />>?\s*\/dev\/(?:sd[a-z]+|nvme\d+n\d+|hd[a-z]+|vd[a-z]+)/,
    risk: "critical",
    description: "重定向写入块设备，会直接破坏分区数据",
    confirm: ["确认目标设备正确", "已备份该设备上所有数据"],
  },
  {
    pattern: /DROP\s+(?:DATABASE|SCHEMA|TABLE)\b/i,
    risk: "critical",
    description: "删除数据库/表，所有数据丢失且不可回滚",
    confirm: ["已用 mysqldump/pg_dump 完成备份", "确认库名/表名正确", "已通知相关业务方"],
  },
  {
    pattern: /\b(?:yum|dnf|apt-get|apt|rpm|dpkg|pacman|zypper)\s+(?:-y\s+)?(?:remove|erase|purge)\s+(?:.*\b)?(?:glibc|systemd|bash|kernel|coreutils|apt|rpm|dpkg|python3?|openssh|sudo|util-linux)\b/,
    risk: "critical",
    description: "卸载系统核心包，会导致系统损坏甚至无法启动",
    confirm: ["理解后果并确认需要这么做"],
  },
  {
    pattern: /\bchown\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)\S+\s+(\/|\/etc|\/usr|\/var|\/boot|\/root|\/bin|\/sbin|\/lib(?:x32|32|64)?|\/sys|\/proc|\/dev)(?:\/|\s|$)/,
    risk: "critical",
    description: "递归修改系统目录所有者，极可能导致系统无法启动",
    confirm: ["已备份系统", "理解可能需要重装系统"],
  },
  {
    pattern: /\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?[0-7]*777\s+(\/|\/etc|\/usr|\/var|\/boot|\/root|\/bin|\/sbin|\/lib(?:x32|32|64)?)(?:\/|\s|$)/,
    risk: "critical",
    description: "给系统目录 777 权限，造成严重安全漏洞",
    confirm: ["确认目录正确", "了解安全后果并接受风险"],
    alternative: "用 755（目录）/ 644（文件）替代 777",
  },
  {
    // fork bomb：:(){ :|:& };:  —— 自引用函数名 + 管道 + 后台
    pattern: /:\s*\(\s*\)\s*\{[^}]*:[^}]*\|[^}]*&\s*\}\s*;?\s*:/,
    risk: "critical",
    description: "疑似 fork 炸弹，会迅速耗尽系统资源导致死机",
    confirm: ["确认这不是 fork 炸弹"],
  },
  {
    pattern: /\bkill\s+(?:-9\s+|-KILL\s+)?1\b|\bpkill\s+(?:-9\s+)?(?:-f\s+)?(?:systemd|init)\b/,
    risk: "critical",
    description: "杀死 PID 1 / init 进程，系统会立即崩溃",
    confirm: ["确认目标进程不是 PID 1"],
  },
  {
    pattern: /\bkubectl\s+delete\s+(?:namespace|ns)\b/,
    risk: "critical",
    description: "删除 Kubernetes 命名空间，其中所有资源会被级联删除",
    confirm: ["已确认命名空间名称", "已备份其中的资源配置", "已通知相关业务方"],
  },

  // ---------------- 高危 ----------------
  {
    pattern: /\b(?:shutdown|reboot|halt|poweroff|init\s+[06]|telinit\s+[06]|systemctl\s+(?:reboot|poweroff|halt))\b/,
    risk: "high",
    description: "系统将关机或重启，正在运行的服务会中断",
    confirm: ["确认非生产高峰期", "已通知相关用户/业务方", "已保存好所有未保存数据"],
  },
  {
    pattern: /\biptables\s+(?:-F|--flush)\b|\bip6tables\s+(?:-F|--flush)\b|\bnft\s+flush\b|\bufw\s+reset\b|\bfirewall-cmd\s+--complete-reload\b/,
    risk: "high",
    description: "清空防火墙规则，可能暴露端口到公网或导致网络中断",
    confirm: ["已备份当前规则（iptables-save）", "确认有带外/控制台访问方式", "理解 SSH 可能被断开"],
  },
  {
    pattern: /TRUNCATE\s+(?:TABLE\s+)?[\w."`]+/i,
    risk: "high",
    description: "清空表，不可回滚",
    confirm: ["已备份该表", "确认无正在执行的事务依赖此表"],
  },
  {
    pattern: /DELETE\s+FROM\s+[\w."`]+(?:\s|$|;)/i,
    risk: "high",
    description: "DELETE 不带 WHERE 条件，将删除表中全部数据",
    confirm: ["确认不需要 WHERE 条件", "已备份该表数据", "已在测试环境验证"],
    alternative: "先 `SELECT COUNT(*)` 确认影响范围，再带上 WHERE 条件",
  },
  {
    pattern: /UPDATE\s+[\w."`]+\s+SET\b(?![\s\S]*\bWHERE\b)/i,
    risk: "high",
    description: "UPDATE 不带 WHERE 条件，将更新表中全部记录",
    confirm: ["确认需要全表更新", "已备份该表数据"],
  },
  {
    pattern: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|fi)?sh\b|\b(?:ba|z|fi)?sh\s*<\s*\(\s*(?:curl|wget)\b|\b(?:curl|wget)\b[^\n]*-O-\s*\|/,
    risk: "high",
    description: "下载远程脚本并直接交给 shell 执行，内容未经审查",
    confirm: ["已确认脚本来源可信", "已阅读脚本内容", "理解将以当前权限执行任意代码"],
    alternative: "先 `curl -fsSL URL -o /tmp/install.sh && cat /tmp/install.sh` 检查后再执行",
  },
  {
    pattern: /\bgit\s+push\s+(?:--force|-f)\b|\bgit\s+push\s+[^\n]*--force-with-lease\b/,
    risk: "high",
    description: "强制推送会覆盖远程分支历史，他人提交可能丢失",
    confirm: ["已确认分支正确", "已通知协作者", "已确认不需要远程上的提交"],
  },
  {
    pattern: /\bgit\s+clean\s+-[a-zA-Z]*[fd]/,
    risk: "high",
    description: "git clean 会删除未被版本控制的文件，且无法恢复",
    confirm: ["已确认待删除文件清单（git clean -n）", "已备份重要文件"],
    alternative: "先 `git clean -nd` 预览将被删除的文件",
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    risk: "high",
    description: "git reset --hard 会丢弃工作区与暂存区的所有改动",
    confirm: ["已确认无需保留本地改动", "已用 git stash 备份"],
    alternative: "需要回退请优先用 `git revert` 或先 `git stash`",
  },
  {
    pattern: /\bdocker\s+system\s+prune\b[^\n]*-a|\bdocker\s+volume\s+prune\b|\bdocker\s+image\s+prune\b[^\n]*-a/,
    risk: "high",
    description: "清理未被使用的 Docker 镜像/卷，已停止容器的卷数据会被删除且不可恢复",
    confirm: ["已确认无重要数据在未运行的容器卷里", "已备份需要保留的数据卷"],
  },
  {
    pattern: /\bkubectl\s+delete\b|\bkubectl\s+scale\b[^\n]*--replicas=0/,
    risk: "high",
    description: "删除 K8s 资源或把副本缩到 0，会造成服务中断",
    confirm: ["已确认资源名称与命名空间", "已确认影响范围", "已通知相关业务方"],
  },
  {
    pattern: /\b(?:userdel|deluser|groupdel)\b/,
    risk: "high",
    description: "删除用户/用户组，其文件会变成无主文件，业务可能异常",
    confirm: ["已确认用户名", "已备份该用户家目录", "确认无服务以该用户运行"],
  },
  {
    pattern: /\b(?:FLUSHALL|FLUSHDB)\b/i,
    risk: "high",
    description: "清空 Redis 全部数据，不可恢复",
    confirm: ["已确认实例正确", "已做 RDB/AOF 备份", "已通知相关业务方"],
  },
  {
    pattern: /\bcrontab\s+-r\b|\brm\s+[^\n]*\/var\/spool\/cron\//,
    risk: "high",
    description: "删除全部定时任务，且难以恢复",
    confirm: ["已用 crontab -l > /tmp/cron.bak 备份", "确认不需要这些定时任务"],
    alternative: "先 `crontab -l > /tmp/cron.bak` 备份再删",
  },
  {
    pattern: /\bmv\s+\/etc\/|\bmv\s+[^\s]+\s+\/etc\//,
    risk: "high",
    description: "移动/覆盖 /etc 下的系统或配置文件，可能导致服务或系统异常",
    confirm: ["已备份原文件", "确认目标路径正确"],
  },

  // ---------------- 中危 ----------------
  {
    pattern: /\bsed\s+-[a-zA-Z]*i|--in-place\b/,
    risk: "medium",
    description: "sed 原地修改文件内容，改动不可自动回滚",
    confirm: ["已确认匹配范围正确", "已备份目标文件"],
    alternative: "先 `sed -n '...p' file` 预览，或用 `sed -i.bak` 留备份",
  },
  {
    pattern: /\bfind\b[^\n]*(?:-delete|-exec\s+rm|-ok\s+rm|-exec\s+\/bin\/rm)/,
    risk: "medium",
    description: "find 带删除动作，会按匹配条件批量删除文件",
    confirm: ["已确认匹配条件（建议先去掉 -delete 跑一遍看清单）", "已备份重要数据"],
    alternative: "先不带 -delete 执行一次，确认匹配清单后再删",
  },
  {
    pattern: /\bchmod\s+[0-7]*777\b|\bchmod\s+-R\s+[0-7]*[67][0-7][0-7]\b/,
    risk: "medium",
    description: "开放 777 / 过宽权限，存在安全风险",
    confirm: ["确认必须开放此权限", "了解可能带来的安全风险"],
    alternative: "优先 755 / 644，或用 chown 指定归属而不是放开全部权限",
  },
  {
    pattern: /\b(?:kill|killall)\s+[^\n]*-9\b|\b(?:kill|killall|pkill)\b/,
    risk: "medium",
    description: "终止进程，可能造成服务中断或数据未落盘",
    confirm: ["已确认目标进程", "确认不会误杀其他服务"],
  },
  {
    pattern: /\bsystemctl\s+(?:stop|disable|mask)\b|\bservice\s+\S+\s+stop\b/,
    risk: "medium",
    description: "停止/禁用服务，会造成对应业务中断",
    confirm: ["已确认服务名称", "确认可以接受短暂中断", "已通知相关业务方"],
  },
  {
    pattern: /\bdocker\s+(?:rm|rmi|container\s+rm|image\s+rm)\b[^\n]*-f|\bdocker\s+(?:rm|rmi)\b/,
    risk: "medium",
    description: "删除容器/镜像，容器内未持久化的数据会丢失",
    confirm: ["已确认容器/镜像名称", "已备份容器内重要数据"],
  },
  {
    pattern: /\b(?:passwd|chpasswd|usermod|gpasswd)\b/,
    risk: "medium",
    description: "修改账号或密码，可能影响他人登录",
    confirm: ["已确认账号名称", "已通知相关使用者"],
  },
  {
    pattern: /\b(?:yum|dnf|apt-get|apt|rpm|dpkg|pacman|zypper)\s+(?:-y\s+)?(?:remove|erase|purge)\b/,
    risk: "medium",
    description: "卸载软件包，可能影响依赖它的其他服务",
    confirm: ["已确认包名", "已确认无关键服务依赖它"],
  },
  {
    pattern: /\b(?:ufw|firewall-cmd|iptables|nft)\b/,
    risk: "medium",
    description: "修改防火墙/网络规则，配错可能导致无法远程连接",
    confirm: ["已确认规则内容", "保留当前 SSH 连接作为回退通道"],
  },
  {
    pattern: /\b(?:reboot|shutdown)[^\n]*-f\b/,
    risk: "high",
    description: "强制重启/关机，不会正常结束进程与同步磁盘",
    confirm: ["理解可能导致数据损坏"],
  },
];

// ==================================================================
// 只读命令：bin 级 + 子命令级（带「危险开关」排除）
// ==================================================================

/** 纯只读的程序（不带危险参数时） */
const READONLY_BINS = new Set([
  "ls", "ll", "dir", "pwd", "echo", "printf", "cat", "tac", "head", "tail", "less", "more",
  "nl", "od", "xxd", "base64", "grep", "egrep", "fgrep", "rg", "ag", "zgrep", "wc", "sort",
  "uniq", "cut", "tr", "sed", "awk", "gawk", "find", "file", "stat", "du", "df", "free",
  "top", "htop", "atop", "ps", "pstree", "pgrep", "netstat", "ss", "ip", "ifconfig", "hostname",
  "hostnamectl", "uname", "date", "uptime", "whoami", "id", "groups", "who", "w", "last",
  "lastlog", "printenv", "env", "which", "whereis", "type", "command", "locate", "man", "info",
  "help", "history", "ping", "traceroute", "tracepath", "mtr", "nslookup", "dig", "host",
  "getent", "ldd", "readlink", "realpath", "basename", "dirname", "diff", "vimdiff", "cmp",
  "md5sum", "sha1sum", "sha256sum", "journalctl", "dmesg", "lsblk", "blkid", "mount", "findmnt",
  "lscpu", "lsblk", "lsmod", "lspci", "lsusb", "free", "vmstat", "iostat", "mpstat", "sar",
  "cd", "true", "false", "test", "dirname", "sleep",
]);

/** 这些只读程序一旦带上下列参数就不再只读 */
const READONLY_DENY_FLAGS: Record<string, RegExp> = {
  sed: /-i\b|--in-place/,
  find: /-delete|-exec|-ok|-fprint|-fls|-fprintf/,
  awk: /-i\s+inplace|inplace::/,
  xxd: /-r\b/,
  base64: /-d\b/,
  mount: /(?:\s|^)-(?:a|t|o\s+remount)/,
};

/** 子命令决定读写性质的复合工具 */
const SUBCOMMAND_READONLY: Record<string, RegExp> = {
  // 注意：不要把 `config` 放进只读白名单 —— `git config --global` 会写 ~/.gitconfig
  git: /^(?:status|log|diff|show|branch|tag|ls-files|ls-remote|remote\s+-v|describe|rev-parse|stash\s+list|blame|reflog|shortlog|count-objects|fsck)$/i,
  docker: /^(?:ps|logs|images|inspect|version|info|stats|top|history|diff|port|search|manifest|compose\s+ps|compose\s+logs|compose\s+config|compose\s+top)$/i,
  systemctl: /^(?:status|is-active|is-enabled|is-failed|show|list-units|list-unit-files|list-dependencies|cat|help)$/i,
  kubectl: /^(?:get|describe|logs|explain|top|version|cluster-info|config\s+view|api-resources)$/i,
  apt: /^(?:list|show|search|policy|showsrc|depends|rdepends|-cache\s+(?:search|show|policy))$/i,
  "apt-get": /^(?:-s|-simulate|--dry-run|-u)$/i,
  yum: /^(?:list|info|search|provides|whatprovides|repolist|history\s+(?:list|info)|check-update)$/i,
  dnf: /^(?:list|info|search|provides|repolist|history\s+(?:list|info))$$/i,
  rpm: /^(?:-q|-qa|-qi|-ql|-qf|-qc|-qd|-V|--verify)$/i,
  dpkg: /^(?:-l|-s|-L|-S|--print-architecture|--get-selections)$/i,
  nginx: /^(?:-t|-T|-v|-V)$/i,
  npm: /^(?:ls|list|view|info|search|outdated|audit|why|config\s+get)$/i,
  pip: /^(?:list|show|search|freeze|check)$/i,
  python3: /^(?:-c|-V|--version)$/i,
  python: /^(?:-c|-V|--version)$/i,
};

/**
 * 无副作用的 shell 内建：cd / export / alias / source 等。
 * 单独列出来是因为它们既不在只读命令表里，也不该落到「非常见命令 → 低危」。
 */
const SHELL_BUILTINS = new Set([
  "cd", "export", "unset", "set", "alias", "unalias", "source", ".", "shift", "readonly",
  "local", "declare", "typeset", "let", "trap", "wait", "jobs", "fg", "bg",
]);

/** 有写副作用、但通常属于常规运维的程序（默认 low，落到系统路径则 medium） */
const WRITE_BINS = new Set([
  "cp", "mv", "rsync", "scp", "sftp", "install", "ln", "mkdir", "rmdir", "touch", "chmod",
  "chown", "chgrp", "tee", "dd", "truncate", "unlink", "patch", "unzip", "tar", "git",
  "docker", "systemctl", "service", "crontab", "useradd", "adduser", "usermod", "groupadd",
  "npm", "pip", "pip3", "yarn", "pnpm", "apt", "apt-get", "yum", "dnf", "rpm", "dpkg",
  "make", "cmake", "curl", "wget", "sed", "awk", "python", "python3", "node", "bash", "sh",
  "nohup", "setcap", "update-rc.d", "debconf-set-selections", "locale-gen", "sysctl",
  "mysql", "psql", "redis-cli", "mongosh", "chpasswd",
]);

/** 明确「安装/构建/启动」类，落到 low */
const INSTALL_BINS = new Set([
  "apt", "apt-get", "yum", "dnf", "rpm", "dpkg", "pacman", "zypper", "apk", "brew",
  "npm", "npx", "yarn", "pnpm", "pip", "pip3", "conda", "go", "cargo", "gem", "composer",
  "make", "cmake", "mvn", "gradle", "docker", "docker-compose", "systemctl", "service",
  "unzip", "gunzip", "gzip", "7z", "unrar", "git",
]);

const RUNNABLE_BASH_LIKE = /^(?:bash|sh|shell|zsh|fish|ksh|console|shell-session)$/i;

// ==================================================================
// 片段级判定
// ==================================================================

/** 片段里是否存在写重定向 / 写文件动作，并取出目标路径 */
function extractWriteTargets(seg: CommandSegment): string[] {
  const targets: string[] = [];
  if (seg.bin === "tee") {
    for (const a of seg.args) if (!isFlag(a)) targets.push(a);
    return targets;
  }
  if (seg.bin === "dd") {
    const m = /\bof=(\S+)/.exec(seg.raw);
    if (m) targets.push(m[1]);
    return targets;
  }
  // 重定向：> / >> / 2> / &>
  const re = /(?:^|\s)(?:[12&]?)>>?\s*([^\s;&|]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg.raw)) !== null) targets.push(m[1]);
  // curl/wget 输出到文件
  const outRe = /(?:^|\s)(?:-o|--output)\s+([^\s;&|]+)/g;
  while ((m = outRe.exec(seg.raw)) !== null) targets.push(m[1]);
  if (/\bwget\b/.test(seg.raw) && /\s-O\s+([^\s;&|]+)/.test(seg.raw)) {
    const wm = /\s-O\s+([^\s;&|]+)/.exec(seg.raw);
    if (wm) targets.push(wm[1]);
  }
  return targets;
}

function hasWriteRedirect(seg: CommandSegment): boolean {
  if (seg.bin === "tee" || seg.bin === "dd") return true;
  return extractWriteTargets(seg).length > 0;
}

/** 只看片段本身（不含 sudo 前缀）是否为只读 */
function classifySegment(seg: CommandSegment): RiskLevel | null {
  const { bin, args } = seg;

  // `curl URL` 不带输出文件时只是发一个请求，视为只读；
  // `wget URL` 一定会落盘，落到写路径规则里按 low 处理（不在此判只读）。
  if (bin === "curl") {
    const writesFile = /(?:\s|^)(?:-o|--output|-O\b|--remote-name|-P\s)/.test(seg.raw);
    if (writesFile || hasWriteRedirect(seg)) return null;
    if (/\|\s*(?:ba|z|fi)?sh\b/.test(seg.raw)) return null; // 交给 curl|bash 规则
    return "none";
  }

  if (SHELL_BUILTINS.has(bin) && !hasWriteRedirect(seg)) return "none";

  const deny = READONLY_DENY_FLAGS[bin];
  if (deny && deny.test(seg.raw)) return null;

  const subRe = SUBCOMMAND_READONLY[bin];
  if (subRe) {
    const sub = (args[0] ?? "").toLowerCase();
    // 形如 `nginx -t`、`apt -v`：首个参数本身就是开关，直接拿去匹配子命令白名单
    if (subRe.test(sub)) return "none";
    const two = `${sub} ${(args[1] ?? "").toLowerCase()}`.trim();
    if (subRe.test(two)) return "none";
    return null;
  }

  if (READONLY_BINS.has(bin)) {
    // 只读程序 + 写重定向 = 写文件（如 echo x > f、cat a > b）
    if (hasWriteRedirect(seg)) return null;
    return "none";
  }
  return null;
}

/** 写操作的落点风险：系统路径 medium，其余 low */
function writeTargetRisk(seg: CommandSegment): RiskLevel {
  const targets = extractWriteTargets(seg);
  if (targets.length > 0) {
    if (targets.some((t) => isSystemWritePath(t))) return "medium";
    return "low";
  }
  return "low";
}

/** cp/mv/ln/install/mkdir/touch/chmod/chown 等到系统路径 → medium */
function writeBinRisk(seg: CommandSegment): RiskLevel {
  if (!WRITE_BINS.has(seg.bin)) return "low";
  const positional = seg.args.filter((a) => !isFlag(a)).map(stripQuotes);
  if (positional.length === 0) return "low";
  // tar 解压到 / 需要 -C 指定，取最后一个位置参数作为目的地
  const dest = positional[positional.length - 1];
  if (isSystemWritePath(dest)) return "medium";
  if (positional.some((p) => isSystemWritePath(p))) return "medium";
  return "low";
}

/** rm 的专项判定：目标路径 + 是否递归共同决定级别 */
function rmRisk(seg: CommandSegment): RiskLevel {
  const flags = seg.args.filter(isFlag).join(" ");
  const recursive = /-[a-zA-Z]*[rR]/.test(flags);
  const targets = seg.args.filter((a) => !isFlag(a)).map(stripQuotes);
  if (recursive) {
    // 正好删掉 /、/etc、/usr 这类顶层系统目录 = 不可逆
    if (targets.some(isFatalRoot)) return "critical";
    // /etc/nginx、/var、/opt 这类：影响面大但不至于装不回来
    if (targets.some(isFatalPath) || targets.some(isBroadPath)) return "high";
    // 删临时目录 / 构建产物（/tmp、node_modules、dist…）是常规操作，按低危处理
    if (targets.length > 0 && targets.every((t) => THROWAWAY_TARGET.test(t))) return "low";
    return "medium";
  }
  if (targets.some(isSystemWritePath)) return "medium";
  return "low";
}

interface SegmentVerdict {
  risk: RiskLevel;
  description: string;
  confirm: string[];
  alternative?: string;
}

function reviewSegment(seg: CommandSegment): SegmentVerdict | null {
  let risk: RiskLevel = "none";
  let description = "";
  let confirm: string[] = [];
  let alternative: string | undefined;
  let matched = false;

  const take = (r: RiskLevel, desc: string, conf?: string[], alt?: string) => {
    if (rank(r) > rank(risk) || !matched) {
      if (rank(r) >= rank(risk)) {
        risk = r;
        if (desc) {
          description = desc;
          confirm = conf ? [...conf] : [];
          alternative = alt;
        }
      }
      matched = true;
    }
  };

  // 1) 危险规则（rm 系统目录 / mkfs / 关机 / curl|bash / 强推 ...）
  for (const rule of DANGEROUS_RULES) {
    if (rule.pattern.test(seg.raw)) {
      take(rule.risk, rule.description, rule.confirm, rule.alternative);
    }
  }

  // 2) rm 专项
  if (seg.bin === "rm") {
    const r = rmRisk(seg);
    if (rank(r) > rank(risk)) {
      risk = r;
      description =
        r === "critical"
          ? "删除系统目录，系统将完全不可恢复"
          : r === "medium"
            ? "递归删除目录，删除内容不可恢复"
            : "删除文件，删除后不可恢复";
      confirm =
        r === "critical"
          ? ["已备份全系统数据", "确认不是在生产主机", "理解此命令等价于重装系统"]
          : r === "medium"
            ? ["已确认删除目标路径正确", "已备份重要数据"]
            : [];
      alternative = r === "medium" ? "可先 `mv 目标 /tmp/xxx.bak` 观察一段时间再删" : undefined;
      matched = true;
    }
  }

  // 3) 只读
  const ro = classifySegment(seg);
  if (ro === "none" && !matched) {
    return { risk: "none", description: "只读查询命令，无副作用", confirm: [] };
  }
  if (ro === "none") {
    return { risk, description, confirm, alternative };
  }

  // 4) 写操作：按落点定级
  const writes = hasWriteRedirect(seg);
  let wr: RiskLevel = "low";
  if (writes) {
    wr = writeTargetRisk(seg);
    if (rank(wr) > rank(risk)) {
      risk = wr;
      description =
        wr === "medium"
          ? `写入系统路径（${extractWriteTargets(seg).filter(isSystemWritePath)[0] ?? "系统目录"}），会改变系统/服务配置`
          : "包含文件写入操作，请注意目标路径与内容是否正确";
      confirm = wr === "medium" ? ["已备份原文件", "已确认写入内容正确"] : [];
      matched = true;
    }
  } else if (WRITE_BINS.has(seg.bin)) {
    wr = writeBinRisk(seg);
    if (rank(wr) > rank(risk)) {
      risk = wr;
      description =
        wr === "medium"
          ? "操作涉及系统路径（/etc、/usr、/boot 等），会改变系统或服务配置"
          : INSTALL_BINS.has(seg.bin)
            ? "常规安装/构建/启停操作"
            : "常规写操作";
      confirm = wr === "medium" ? ["已备份原文件", "已确认目标路径正确"] : [];
      matched = true;
    }
  } else if (!matched) {
    // 5) 未知命令：默认低风险（旧实现把「含重定向」一律抬到 medium，
    //    导致 echo x > /data/a.conf、cat > /tmp/x <<EOF 这类常见写文件操作被误判中危）
    risk = "low";
    description = "非常见命令，请确认命令意图";
    confirm = [];
  }

  if (risk === "none" && !matched) return null;
  return { risk, description, confirm, alternative };
}

/** 会把文件内容整段倒进 stdout 的命令（`cat` 一个二进制 = 上百 MB 乱码刷屏） */
const DUMP_BIN_RE = /(?:^|[;|&(]\s*|\bsudo\s+)(?:cat|tac|strings|xxd|od|hexdump|base64|nl)\b/i;

/**
 * 目标路径在「二进制 / 库 / 设备 / 私钥」范围内。
 * 注意刻意**不**包含 /proc 与 /sys 整体 —— `cat /proc/cpuinfo`、`/proc/meminfo`
 * 是极常见的合法探测；只点名真正会炸的 /proc/kcore 与 /proc/<pid>/mem。
 * /dev/null 也放行（`cat /dev/null > f` 是常用清空手法）。
 */
const BINARY_PATH_RE =
  /(?:\/usr\/(?:local\/)?(?:bin|sbin|lib(?:64)?)\/|\/(?:bin|sbin|lib(?:64)?)\/|\/usr\/sbin\/|\/dev\/(?!null\b)|\/proc\/(?:kcore|self\/mem|\d+\/mem)|\.(?:so(?:\.\d+)*|bin|o|a|exe|dll|pyc|ko|pem|key|p12|pfx|jks)\b)/i;

/**
 * 判断这是不是「dump 二进制 / 系统文件」的命令。
 *
 * 真实故障：模型为了确认 Prometheus 装没装上，发了
 * `ls -la /usr/local/bin/prometheus && cat /usr/local/bin/prometheus` ——
 * `cat` 一个 100MB+ 的 ELF 把乱码灌满 PTY：该步耗掉 320 秒并卡在输出超时，
 * 整个终端窗口被刷成乱码，后续命令的输出全部淹没在噪音里，任务就此报废。
 *
 * 想确认可执行文件，正确姿势是 `file <path>` / `ls -la <path>` / `<path> --version`，
 * 而不是把它的内容倒出来。
 */
export function isBinaryDumpCommand(command: string): boolean {
  return DUMP_BIN_RE.test(command) && BINARY_PATH_RE.test(command);
}

/**
 * 命令安全审查（本地规则，不依赖 AI）
 */
export function reviewCommand(command: string, opts?: {
  isProduction?: boolean;
  privilege?: "root" | "sudoer" | "user";
}): CommandReviewResult {
  const cmd = command.trim();

  if (!cmd) {
    return {
      command,
      riskLevel: "none",
      isSafe: true,
      requireConfirmation: false,
      riskDescription: "空命令",
      confirmationItems: [],
    };
  }

  const cleaned = stripHeredocs(cmd);
  const segments = splitTopLevel(cleaned).map(parseSegment).filter((s) => s.bin);

  let risk: RiskLevel = "none";
  let description = "";
  let confirmItems: string[] = [];
  let alternative: string | undefined;
  let found = false;

  const consider = (v: SegmentVerdict) => {
    if (rank(v.risk) > rank(risk)) {
      risk = v.risk;
      description = v.description;
      confirmItems = v.confirm;
      alternative = v.alternative;
    } else if (!found && v.risk === "none") {
      description = v.description;
    }
    found = true;
  };

  // 整条命令先过一遍危险规则：$() / 反引号里的危险片段也要能被抓到
  for (const rule of DANGEROUS_RULES) {
    if (rule.pattern.test(cleaned)) {
      if (rank(rule.risk) > rank(risk)) {
        risk = rule.risk;
        description = rule.description;
        confirmItems = rule.confirm ? [...rule.confirm] : [];
        alternative = rule.alternative;
      }
      found = true;
    }
  }

  for (const seg of segments) {
    const v = reviewSegment(seg);
    if (v) consider(v);
  }

  if (!found) {
    risk = "low";
    description = "非常见命令，请确认命令意图";
  }

  // 生产环境：只要不是只读，一律二次确认（与改动前的行为保持一致 ——
  // 重写判定后「写 /data 下文件」从 medium 降为 low，若这里仍只看 medium，
  // 生产主机上的写操作就会从「需确认」悄悄变成「直接执行」）。
  const isProd = !!opts?.isProduction;
  const requireConfirmation = rank(risk) >= rank("high") || (isProd && rank(risk) >= rank("low"));

  if (isProd && rank(risk) >= rank("low")) {
    confirmItems = ["⚠️ 当前主机已标注【生产环境】", ...confirmItems];
    if (confirmItems.length === 1) confirmItems.push("已确认该命令不会影响线上业务");
  }

  return {
    command,
    riskLevel: risk,
    isSafe: rank(risk) <= rank("medium"),
    requireConfirmation,
    riskDescription: description || "常规操作",
    confirmationItems: confirmItems,
    ...(alternative ? { suggestedAlternative: alternative } : {}),
    ...(rank(risk) >= rank("high") && !/备份/.test(description)
      ? { backupSuggestion: "执行前建议先备份相关数据" }
      : {}),
  };
}

// ==================================================================
// Markdown 代码块解析
// ==================================================================

/** 这些语言的代码块是「文件内容 / 输出」，不是可直接执行的命令 */
const NON_RUNNABLE_LANGS = new Set([
  "text", "txt", "plain", "plaintext", "md", "markdown", "log", "output", "console", "diff",
  "json", "jsonc", "yaml", "yml", "toml", "ini", "conf", "cfg", "config", "env", "properties",
  "xml", "html", "htm", "css", "csv", "tsv", "http", "dockerfile", "sql", "nginx", "apache",
  "graphql", "proto", "vue", "jsx", "tsx", "java", "c", "cpp", "cc", "h", "hpp", "cs", "rs",
  "swift", "kt", "scala", "php", "ruby", "lua", "perl", "r", "matlab", "docker-compose",
]);

export function isRunnableLanguage(lang: string): boolean {
  const l = (lang || "").toLowerCase();
  if (!l) return true;
  if (RUNNABLE_BASH_LIKE.test(l)) return true;
  if (l === "powershell" || l === "ps1" || l === "cmd" || l === "batch" || l === "bat") return true;
  if (l === "python" || l === "py" || l === "python3") return true;
  if (l === "node" || l === "javascript" || l === "js") return true;
  return !NON_RUNNABLE_LANGS.has(l);
}

/** SQL 文本的风险判定 */
function inferSqlRisk(content: string): RiskLevel {
  if (/\bDROP\s+(?:DATABASE|SCHEMA|TABLE)\b/i.test(content)) return "critical";
  if (/\bTRUNCATE\b/i.test(content)) return "high";
  if (/\bDELETE\s+FROM\b/i.test(content) && !/\bWHERE\b/i.test(content)) return "high";
  if (/\bUPDATE\b/i.test(content) && !/\bWHERE\b/i.test(content)) return "high";
  if (/\b(?:ALTER|RENAME|MODIFY|DROP\s+COLUMN|DROP\s+INDEX)\b/i.test(content)) return "medium";
  if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|GRANT|REVOKE|CREATE)\b/i.test(content)) return "medium";
  if (/\bSELECT\b/i.test(content)) return "none";
  return "none";
}

/**
 * 按语言与内容推断风险。
 * 关键修正：非 shell 代码块（配置、日志、JSON、说明文本）此前一律返回 medium，
 * 这是「低危内容被标成中危」的主要来源；现在按语言给合理基线。
 */
export function inferRiskFromLanguage(lang: string, content: string): RiskLevel {
  const l = (lang || "").toLowerCase();

  if (RUNNABLE_BASH_LIKE.test(l) || l === "console" || l === "shell-session") {
    const order: RiskLevel[] = RISK_ORDER;
    let maxRisk: RiskLevel = "none";
    for (const line of splitTopLevel(stripHeredocs(content))) {
      const seg = parseSegment(line);
      if (!seg.bin) continue;
      const v = reviewSegment(seg);
      const r = v ? v.risk : "low";
      if (order.indexOf(r) > order.indexOf(maxRisk)) maxRisk = r;
    }
    // 整块再过一次危险规则（跨行的 rm -rf / 等）
    for (const rule of DANGEROUS_RULES) {
      if (rule.pattern.test(stripHeredocs(content)) && order.indexOf(rule.risk) > order.indexOf(maxRisk)) {
        maxRisk = rule.risk;
      }
    }
    return maxRisk;
  }

  if (l === "sql") return inferSqlRisk(content);

  if (l === "powershell" || l === "ps1" || l === "cmd" || l === "batch" || l === "bat") {
    // 无法可靠解析，但明显危险的直接抬级
    if (/\bRemove-Item\b[^\n]*-Recurse[^\n]*(?:C:\\|\\Windows|\/)/i.test(content)) return "high";
    if (/\b(?:Remove-Item|rm|del)\b/i.test(content)) return "medium";
    if (/\b(?:Restart-Computer|Stop-Computer|Stop-Service|Set-ExecutionPolicy)\b/i.test(content)) {
      return "medium";
    }
    return "low";
  }

  if (l === "dockerfile" || l === "docker-compose" || l === "yaml" || l === "yml") return "low";
  if (l === "python" || l === "py" || l === "python3" || l === "js" || l === "javascript" || l === "node") {
    // 脚本里出现破坏性调用才升风险
    if (/\b(?:shutil\.rmtree|os\.remove|os\.system|subprocess\.(?:run|call|Popen))\b/.test(content)) {
      return "medium";
    }
    return "low";
  }

  // 说明文本 / 配置 / 日志：不是命令，不应标成中危
  if (["text", "txt", "plain", "plaintext", "md", "markdown", "log", "output", "console", "diff"].includes(l)) {
    return "none";
  }

  return "low";
}

/**
 * 解析 Markdown 文本中的代码块，提取命令和风险。
 *
 * 风险取值策略（修正「模型乱标风险」导致低危命令显示成中高危）：
 * - shell / SQL：本地规则为唯一权威，忽略模型的 risk= 自评。
 *   理由：模型普遍偏保守，`echo x > /data/a.conf`、`mkdir -p /data` 常被标成 medium/high，
 *   而实际确认弹窗又走本地规则 —— 结果是「标签说中危、点执行却不确认」的自相矛盾。
 * - 其他语言：以本地推断为基线，模型的自评最多只能把它抬高一档。
 */
export function parseCommandsFromMarkdown(text: string): ParsedCommand[] {
  const result: ParsedCommand[] = [];
  const regex = /```([A-Za-z0-9_+-]+)(?::risk=([a-z]+))?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = regex.exec(text)) !== null) {
    const language = match[1] || "bash";
    const aiRisk = match[2] as RiskLevel | undefined;
    const command = match[3].trim();
    if (!command) continue;

    const local = inferRiskFromLanguage(language, command);
    let risk: RiskLevel;
    const l = language.toLowerCase();
    if (RUNNABLE_BASH_LIKE.test(l) || l === "sql" || l === "console" || l === "shell-session") {
      risk = local;
    } else if (aiRisk && rank(aiRisk) > rank(local)) {
      risk = capRisk(aiRisk, raiseRisk(local, 1));
    } else {
      risk = aiRisk ? higherRisk(aiRisk, local) : local;
    }

    result.push({
      id: `cmd_${Date.now()}_${i++}_${Math.random().toString(36).slice(2, 6)}`,
      language,
      command,
      riskLevel: risk,
    });
  }
  return result;
}
