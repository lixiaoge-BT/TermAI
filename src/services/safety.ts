import type { ParsedCommand } from "@/types";

export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

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

// 危险模式字典（正则匹配）
const DANGEROUS_PATTERNS: Array<{
  pattern: RegExp;
  risk: RiskLevel;
  description: string;
  confirm: string[];
}> = [
  // 致命：根目录删除
  {
    pattern: /\brm\s+(-[rfRvfi]+\s+)*--no-preserve-root\b/,
    risk: "critical",
    description: "使用 --no-preserve-root 参数删除根目录，系统将完全不可恢复",
    confirm: ["已备份全系统数据", "确认是在测试机/虚拟机操作", "理解命令将破坏操作系统"],
  },
  {
    pattern: /\brm\s+(-[rfRvfi]+\s+)*(\/\s*|\/\*+|\/\.?\*+)/,
    risk: "critical",
    description: "删除根目录下所有文件，系统将完全不可恢复",
    confirm: ["已备份全系统数据", "确认不是在生产主机", "理解此命令等价于重装系统"],
  },
  {
    pattern: /\brm\s+-[rRf]+\s+\.\s*$/,
    risk: "high",
    description: "删除当前目录所有内容",
    confirm: ["已确认当前目录正确（非系统目录）", "已备份目录数据"],
  },
  // 格式化磁盘
  {
    pattern: /\bmkfs\b|mk\.(ext[234]|xfs|btrfs|ntfs|fat|vfat)\b/,
    risk: "critical",
    description: "格式化磁盘/分区，该分区全部数据将丢失",
    confirm: ["已选择正确的磁盘设备（非系统盘）", "已备份分区内数据", "确认无挂载中的进程在使用"],
  },
  {
    pattern: /\bdd\s+if=.*\s+of=\/dev\/(sd[a-z]+|nvme\d+n\d+|hd[a-z]+|vd[a-z]+)/,
    risk: "critical",
    description: "直接写入块设备，可能覆盖分区表或整个磁盘",
    confirm: ["of= 设备正确", "输入镜像文件正确", "已备份目标设备上所有数据"],
  },
  // 数据库危险操作
  {
    pattern: /DROP\s+(DATABASE|SCHEMA)\b/i,
    risk: "critical",
    description: "删除整个数据库/模式，所有表和数据丢失",
    confirm: ["已使用 mysqldump/pg_dump 完成备份", "确认库名正确", "已通知相关业务方"],
  },
  {
    pattern: /DELETE\s+FROM\s+[\w.]+(\s*;|\s*$)/i,
    risk: "high",
    description: "DELETE 不带 WHERE 条件，将删除表中全部数据",
    confirm: ["确认不需要 WHERE 条件", "已备份该表数据", "已在测试环境验证"],
  },
  {
    pattern: /TRUNCATE\s+(TABLE\s+)?[\w.]+/i,
    risk: "high",
    description: "清空表，不可回滚",
    confirm: ["已备份该表", "确认无正在执行的事务依赖此表"],
  },
  // 系统关闭/重启
  {
    pattern: /\b(shutdown|reboot|halt|poweroff|init\s+[06]|telinit\s+[06])\b/,
    risk: "high",
    description: "系统将关机或重启，正在运行的服务中断",
    confirm: ["确认非生产高峰期", "已通知相关用户/业务方", "已保存好所有未保存数据"],
  },
  // 防火墙
  {
    pattern: /iptables\s+-F\b|iptables\s+--flush\b|firewall-cmd\s+--complete-reload/,
    risk: "high",
    description: "清空防火墙规则，可能暴露端口到公网或导致网络中断",
    confirm: ["已备份当前规则（iptables-save）", "确认有带外/控制台访问方式", "理解 SSH 可能被断开"],
  },
  // 权限
  {
    pattern: /\bchmod\s+[-R]+\s+777\s+(\/|\/etc|\/usr|\/var|\/root|\/boot)/,
    risk: "high",
    description: "给系统目录 777 权限造成严重安全漏洞",
    confirm: ["确认目录正确", "了解安全后果并接受风险"],
  },
  {
    pattern: /\bchown\s+-R\s+\S+\s+(\/|\/etc|\/usr|\/var|\/root|\/boot)/,
    risk: "critical",
    description: "递归修改系统目录所有者，极可能导致系统无法启动",
    confirm: ["已备份系统", "理解可能需要重装系统"],
  },
  // 包管理器强制卸载
  {
    pattern: /\b(yum|dnf|apt-get|apt|rpm|dpkg)\s+(remove|erase|purge)\s+(glibc|systemd|bash|kernel|coreutils|apt|rpm)\b/,
    risk: "critical",
    description: "卸载系统核心包，会导致系统损坏",
    confirm: ["理解后果并确认需要这么做"],
  },
];

// 只读命令（安全）
const READONLY_COMMANDS = new Set([
  "ls", "dir", "pwd", "echo", "cat", "head", "tail", "less", "more", "tac",
  "grep", "egrep", "fgrep", "wc", "sort", "uniq", "cut", "tr", "sed", "awk",
  "find", "file", "stat", "du", "df", "free", "top", "htop", "ps",
  "netstat", "ss", "ip", "ifconfig", "hostname", "uname", "date", "uptime",
  "whoami", "id", "who", "w", "last", "history", "printenv", "env", "set",
  "which", "whereis", "locate", "man", "info", "help",
  "curl -I", "curl --head", "wget --spider", "ping", "traceroute", "nslookup", "dig",
]);

function isLikelyReadonly(cmd: string): boolean {
  const trimmed = cmd.trim();
  // 去掉 sudo/doas 前缀
  const withoutSudo = trimmed.replace(/^(sudo|doas|pkexec|su\s+\S+\s+-c\s+["']?)/, "").trim();
  const firstSpace = withoutSudo.search(/\s/);
  const firstToken = firstSpace === -1 ? withoutSudo : withoutSudo.slice(0, firstSpace);
  // 重定向写视为不安全（优先于只读命令判断，避免 `cat a > b.txt` 被误判为只读）
  if (/>/.test(withoutSudo)) return false;
  // 不带参数
  if (READONLY_COMMANDS.has(firstToken)) return true;
  // 组合命令（管道）：每一段都安全才算安全
  if (withoutSudo.includes("|")) {
    return withoutSudo.split("|").every((seg) => isLikelyReadonly(seg));
  }
  return false;
}

/**
 * 命令安全审查（本地规则，不依赖 AI）
 */
export function reviewCommand(command: string, opts?: {
  isProduction?: boolean;
  privilege?: "root" | "sudoer" | "user";
}): CommandReviewResult {
  const cmd = command.trim();

  // 空命令
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

  // 1. 匹配高危模式
  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.pattern.test(cmd)) {
      const result: CommandReviewResult = {
        command,
        riskLevel: rule.risk,
        isSafe: false,
        requireConfirmation: true,
        riskDescription: rule.description,
        confirmationItems: [...rule.confirm],
      };
      if (opts?.isProduction) {
        result.confirmationItems.unshift("⚠️ 当前为主机已标注【生产环境】");
      }
      return result;
    }
  }

  // 2. 只读命令
  if (isLikelyReadonly(cmd)) {
    return {
      command,
      riskLevel: "none",
      isSafe: true,
      requireConfirmation: false,
      riskDescription: "只读查询命令，无副作用",
      confirmationItems: [],
    };
  }

  // 3. 带重定向/写入
  if (cmd.includes(">") || cmd.includes(">>") || /\b(wget|curl)\s+.+(-O|-o|--output)/.test(cmd)) {
    return {
      command,
      riskLevel: "medium",
      isSafe: true,
      requireConfirmation: opts?.isProduction ?? false,
      riskDescription: "命令包含文件写入操作，请注意目标路径是否正确",
      confirmationItems: opts?.isProduction ? ["生产环境：已确认写入路径和内容正确"] : [],
    };
  }

  // 4. 默认：低风险（普通写操作如 mkdir/cp/mv/chmod 正常路径）
  return {
    command,
    riskLevel: "low",
    isSafe: true,
    requireConfirmation: opts?.isProduction ?? false,
    riskDescription: opts?.isProduction ? "生产环境下请确认命令意图" : "常规操作",
    confirmationItems: opts?.isProduction ? ["生产环境：已确认命令不会影响业务"] : [],
  };
}

/**
 * 解析 Markdown 文本中的代码块，提取命令和风险
 */
export function parseCommandsFromMarkdown(text: string): ParsedCommand[] {
  const result: ParsedCommand[] = [];
  // 匹配 ```lang:risk=xxx  ...  ```
  const regex = /```([A-Za-z0-9_+-]+)(?::risk=([a-z]+))?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = regex.exec(text)) !== null) {
    const language = match[1] || "bash";
    const risk = (match[2] as RiskLevel) || inferRiskFromLanguage(language, match[3]);
    const command = match[3].trim();
    if (command) {
      result.push({
        id: `cmd_${Date.now()}_${i++}_${Math.random().toString(36).slice(2, 6)}`,
        language,
        command,
        riskLevel: risk,
      });
    }
  }
  return result;
}

function inferRiskFromLanguage(lang: string, content: string): RiskLevel {
  // 先跑一遍本地审查
  if (/^(bash|sh|shell|zsh|fish|powershell|ps1|cmd|batch)$/i.test(lang)) {
    // 对每一行命令审查取最高风险；基线为 none（shell 块里都是只读命令时不应凭空抬成 low）
    const lines = content.split(/\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    let maxRisk: RiskLevel = "none";
    const order: RiskLevel[] = ["none", "low", "medium", "high", "critical"];
    for (const line of lines) {
      const r = reviewCommand(line).riskLevel;
      if (order.indexOf(r) > order.indexOf(maxRisk)) maxRisk = r;
    }
    return maxRisk;
  }
  return "medium";
}
