/**
 * 主机画像：把「一次探测、全程复用」的环境事实从对话历史里提取出来。
 *
 * 为什么值得单独做：Agent 每个新任务的第一轮几乎固定是
 * `cat /etc/os-release; uname -m; command -v apt-get yum dnf apk`
 * —— 因为系统提示词自己写着「请先确认发行版」。这一轮：
 * ① 白花一次 LLM 往返；② 探测结果散落在 transcript 里，压缩/截断后就丢了，
 * 于是模型隔几轮又探一次；③ 没探到就凭印象选包管理器（apt 装 CentOS），
 * 一步错后面全错 —— 这既是「步骤多」也是「准确率差」。
 *
 * 这里只做**纯函数**：从「命令 + 输出」里抽事实、合并、渲染成可注入的一行。
 * 采集时机、注入时机、拦截重复探测都在 store/agent.ts 里。
 */

export interface HostFacts {
  /** 发行版可读名，如 `CentOS Linux 7.9.2009 (Core)` */
  os?: string;
  /** 内核版本，如 `3.10.0-1160.el7.x86_64` */
  kernel?: string;
  /** 架构，如 `x86_64` / `aarch64` */
  arch?: string;
  /** 包管理器命令：`apt` / `yum` / `dnf` / `apk` / `zypper` */
  pkgManager?: string;
  /** 容器运行时：`docker` / `containerd` / `podman` */
  container?: string;
}

export interface FactSource {
  command: string;
  output: string;
  exitCode?: number | null;
}

const OS_RELEASE_DISTROS: Array<{ re: RegExp; pkg: string }> = [
  { re: /centos|rhel|red hat|rocky|almalinux|fedora|oracle linux/i, pkg: "yum" },
  { re: /ubuntu|debian|linux mint|kali/i, pkg: "apt" },
  { re: /alpine/i, pkg: "apk" },
  { re: /opensuse|suse/i, pkg: "zypper" },
];

/** 一批命令里出现过的包管理器命令（按优先级：dnf > yum > apt-get > apk） */
const PKG_PRIORITY = ["dnf", "yum", "apt-get", "apk", "zypper"];

const PKG_CMD_RE = /(?:^|[;&|]\s*)(?:sudo\s+)?(?:command\s+-v|which|type)\s+([^;&|]+)/;

function normCmd(c: string): string {
  return c.replace(/\s+/g, " ").trim();
}

/** 从 `/etc/os-release` 的输出里取发行版名；取不到返回空串 */
export function parseOsRelease(output: string): string {
  const pretty = output.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
  if (pretty) return pretty[1].trim();
  const name = output.match(/^NAME="?([^"\n]+)"?/m);
  const ver = output.match(/^VERSION_ID="?([^"\n]+)"?/m);
  if (name) return `${name[1].trim()}${ver ? ` ${ver[1].trim()}` : ""}`;
  // 老发行版只有 /etc/redhat-release：一行纯文本
  const redhat = output.match(/^(CentOS|Red Hat|Rocky|AlmaLinux|Fedora)[^\n]*$/m);
  return redhat ? redhat[0].trim() : "";
}

/**
 * 内核版本 / 架构的「形状」判据。
 *
 * 为什么不能只看第一行：主机探测常被拼成一条复合命令
 * `cat /etc/os-release; uname -r; uname -m; command -v apt-get yum dnf apk`，
 * 输出是四段拼在一起的，第一行是 os-release 的 `NAME="CentOS Linux"`。
 * 按位置取 `split("\n")[0]` 必然取错 —— 真实主机实测内核与架构**整天抽不到**，
 * 于是模型每轮都在自己 `uname -r` 重探一遍（正是这套画像想省掉的往返）。
 */
const KERNEL_SHAPE_RE = /^(\d+\.\d+\.\d+[^\s]*)$/m;
const ARCH_SHAPE_RE = /^(x86_64|aarch64|armv7l|armv6l|i[3-6]86|ppc64le|ppc64|s390x|riscv64)$/m;

/** `uname -a` / `uname -r` / `uname -m` 的输出 → 内核与架构 */
export function parseUname(command: string, output: string): { kernel?: string; arch?: string } {
  const c = normCmd(command);
  const first = output.split("\n")[0].trim();
  if (/^Linux\s/.test(first)) {
    // Linux host 3.10.0-1160.el7.x86_64 #1 SMP ... x86_64 GNU/Linux
    const parts = first.split(/\s+/);
    const arch = parts[parts.length - 2];
    return {
      kernel: parts[2] || undefined,
      arch: /^(x86_64|aarch64|armv|s390x|ppc64|i\d86)/.test(arch) ? arch : undefined,
    };
  }
  const out: { kernel?: string; arch?: string } = {};
  const wantR = /(^|\s)-r\b/.test(c);
  const wantM = /(^|\s)-m\b/.test(c);
  if (wantM) {
    const a = first.split(/\s+/)[0];
    if (ARCH_SHAPE_RE.test(a)) out.arch = a;
  }
  if (wantR && first && !out.arch && KERNEL_SHAPE_RE.test(first)) out.kernel = first;
  // 首行不是答案（多半是复合命令）→ 在整段输出里按形状找
  if (wantR && !out.kernel) {
    const k = output.match(KERNEL_SHAPE_RE);
    if (k) out.kernel = k[1];
  }
  if (wantM && !out.arch) {
    const a = output.match(ARCH_SHAPE_RE);
    if (a) out.arch = a[1];
  }
  return out;
}

/** `command -v apt-get yum dnf apk` 之类的输出 → 包管理器 */
export function parsePkgManager(output: string): string {
  const found = PKG_PRIORITY.filter((p) => new RegExp(`(^|/)${p}$`, "m").test(output));
  return found[0] ?? "";
}

/**
 * 从一轮「命令 + 输出」里抽取主机事实。
 *
 * 只认**结构明确**的探测命令（os-release / uname / command -v / --version），
 * 不做模糊猜测 —— 宁可少抽一条，也不能把错的事实钉进系统提示词。
 */
export function extractHostFacts(sources: FactSource[]): HostFacts {
  const facts: HostFacts = {};
  for (const s of sources) {
    if (s.exitCode !== undefined && s.exitCode !== null && s.exitCode !== 0) continue;
    const cmd = normCmd(s.command);
    const out = s.output ?? "";

    if (/(^|[;&|]\s*)(?:sudo\s+)?(?:cat|less|more|head|tail)\b[^;&|]*\/etc\/(os-release|redhat-release|system-release|issue)\b/.test(cmd) ||
      /(^|[;&|]\s*)(?:sudo\s+)?(?:lsb_release|hostnamectl)\b/.test(cmd)) {
      const os = parseOsRelease(out);
      if (os && !/^Linux$/i.test(os)) facts.os = os;
    }

    if (/(^|[;&|]\s*)(?:sudo\s+)?uname\b/.test(cmd)) {
      const { kernel, arch } = parseUname(cmd, out);
      if (kernel) facts.kernel = kernel;
      if (arch) facts.arch = arch;
    }

    const pkgMatch = cmd.match(PKG_CMD_RE);
    if (pkgMatch && /\b(apt-get|yum|dnf|apk|zypper)\b/.test(pkgMatch[1])) {
      const pkg = parsePkgManager(out);
      if (pkg) facts.pkgManager = pkg;
    }

    if (/(^|[;&|]\s*)(?:sudo\s+)?(?:docker|podman)\s+(--version|-v)\b/.test(cmd) ||
      /(^|[;&|]\s*)(?:sudo\s+)?(?:command\s+-v|which)\s+(docker|podman|nerdctl)\b/.test(cmd)) {
      if (/\bdocker\b|Docker version/i.test(out) && /docker/i.test(cmd)) facts.container = "docker";
      else if (/\bpodman\b/i.test(out) && /podman/i.test(cmd)) facts.container = "podman";
    }
    if (/(^|[;&|]\s*)(?:sudo\s+)?crictl\s+--version\b/.test(cmd) && /crictl|containerd/i.test(out)) {
      facts.container = "containerd";
    }
  }
  // 只探到发行版、没探包管理器时，用发行版兜底推断 —— 这比让模型「凭印象选」
  // 可靠得多（典型错误：在 CentOS 上发 apt-get）。推断值随后会被真实探测覆盖。
  if (facts.os && !facts.pkgManager) {
    const hit = OS_RELEASE_DISTROS.find((d) => d.re.test(facts.os!));
    if (hit) facts.pkgManager = hit.pkg;
  }
  return facts;
}

/** 合并：新事实覆盖旧事实（同键），undefined 不覆盖 */
export function mergeHostFacts(a: HostFacts | undefined, b: HostFacts | undefined): HostFacts {
  const out: HostFacts = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b ?? {}) as Array<[keyof HostFacts, string | undefined]>) {
    if (v) out[k] = v;
  }
  return out;
}

export function hasAnyFact(f: HostFacts | undefined): boolean {
  return !!f && Object.values(f).some(Boolean);
}

/** 渲染成注入用的一行（不含「已确认环境」前缀，调用方决定措辞） */
export function renderHostFacts(f: HostFacts | undefined): string {
  if (!f) return "";
  const parts: string[] = [];
  if (f.os) parts.push(f.os);
  if (f.kernel) parts.push(`内核 ${f.kernel}`);
  if (f.arch) parts.push(f.arch);
  if (f.pkgManager) parts.push(`包管理器 ${f.pkgManager}`);
  if (f.container) parts.push(`容器运行时 ${f.container}`);
  return parts.join(" · ");
}

export type EnvProbeKind = "os" | "kernel" | "arch" | "pkg" | "env";

const OS_PROBE_RE = /^(?:sudo\s+)?(?:cat|less|more|head|tail)\s+\/etc\/(?:os-release|redhat-release|system-release|issue)\b/;
const LSBPROBE_RE = /^(?:sudo\s+)?(?:lsb_release|hostnamectl)\b/;
const UNAME_RE = /^(?:sudo\s+)?uname\b/;
const PKG_PROBE_RE = new RegExp(
  `^(?:sudo\\s+)?(?:command\\s+-v|which|type)\\s+(?:[^;&|]*\\b(?:${PKG_PRIORITY.join("|")})\\b)`
);

/**
 * 这条命令是不是「环境探测」。返回 null 表示与主机画像无关。
 *
 * 复合命令（`cat /etc/os-release; uname -m; command -v yum`）只有在**每一段都是探测**时
 * 才算探测 —— 否则 `cat /etc/os-release; systemctl restart nginx` 会被误判成纯探测而拦掉。
 */
export function envProbeKind(command: string): EnvProbeKind | null {
  const cmd = normCmd(command);
  if (!cmd) return null;
  const parts = cmd
    .split(/;|&&|\|\|/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const kinds = parts.map((p) => {
    if (OS_PROBE_RE.test(p) || LSBPROBE_RE.test(p)) return "os" as const;
    if (UNAME_RE.test(p)) {
      if (/(^|\s)-m\b/.test(p)) return "arch" as const;
      if (/(^|\s)-r\b/.test(p)) return "kernel" as const;
      return "env" as const;
    }
    if (PKG_PROBE_RE.test(p)) return "pkg" as const;
    return null;
  });
  if (kinds.some((k) => k === null)) return null;
  if (kinds.includes("os") && kinds.includes("pkg")) return "env";
  // 只探测单一维度时按维度返回；多种混在一起（如 os + kernel）也归为 env
  return kinds.length === 1 ? (kinds[0] as EnvProbeKind) : "env";
}

/**
 * 已有画像是否足以回答这条探测命令。
 *
 * 判据刻意偏保守：只认「事实确实覆盖了这一维度」，避免把还没探测到的信息
 * 当成已知而拦掉真实需要执行的命令。
 */
export function envProbeCoveredBy(facts: HostFacts | undefined, command: string): boolean {
  const kind = envProbeKind(command);
  if (!kind || !facts) return false;
  switch (kind) {
    case "os":
      return !!facts.os;
    case "kernel":
      return !!facts.kernel;
    case "arch":
      return !!facts.arch;
    case "pkg":
      return !!facts.pkgManager;
    case "env":
      // 复合探测：至少要有发行版 + 包管理器，才算「环境已完全确认」
      return !!facts.os && !!facts.pkgManager;
    default:
      return false;
  }
}
