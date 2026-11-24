/**
 * 「逐个硬编码枚举」检测。
 *
 * 现场故障（`agent-runs/1793958126279-g7gao0`）：目标是「在 /data/signature 下按天
 * 建 2025-08-01 ~ 2025-09-01 的 32 个目录」，模型没有写循环，而是把路径一条条写进
 * `mkdir -p` —— 一条塞 5 个，要跑 6~7 轮才建完，每轮还要重发整段上下文：
 * 4 步 146s、47.8k token，最后根本没建完就宣布「已成功创建」。
 *
 * 提示词里原本还留着「不要写多行 while/for 循环」这条老规则（那是循环会被拼平成
 * 一行、注释吞掉 done 导致终端卡死的年代留下的），于是模型只会逐个抄路径。
 * 现在多行循环会落盘成脚本执行（`needsScriptFile`），提示词已改成鼓励循环；
 * 这里再加一层**与提示词无关**的兜底：不管模型怎么想，只要命令里出现
 * 「同骨架目标 ≥4 个」，就判定为枚举式写法，打回要求改写成一次循环。
 *
 * 纯函数，不改任何状态，便于单测。
 */

/** 同骨架目标达到这个数量，用循环才是正确写法（3 个以内手写不算问题） */
export const ENUM_MIN_TARGETS = 4;

export interface EnumerationHit {
  /** 命中的同类目标个数 */
  count: number;
  /** 数字被抹成 `#` 的骨架，用于告诉模型它在枚举什么 */
  skeleton: string;
  /** 骨架里第一个 `#` 之前的部分（路径/文件名前缀），拼提示用 */
  prefix: string;
  /** 其中几条原样目标，作为「你枚举了这些」的样例 */
  samples: string[];
}

const digits = /\d+/g;

/** 把数字统一抹成 `#`：`a/20250801` 与 `a/20250802` 得到同一个骨架 */
export function skeletonOf(text: string): string {
  return text.replace(digits, "#");
}

/**
 * 这个 token 是否「像一串编号目标」。
 *
 * 只认两类，避免把 `chmod 755 a b c` 这种误判成枚举：
 * - 含路径分隔符的（`/data/x/20250801`、`app1/app2` 不算，得有 `/`）
 * - 纯多位数字（`20250801`）或 4 位以上数字结尾的（`log-20250801`）
 */
function isSequenceToken(token: string): boolean {
  if (!/[0-9]/.test(token)) return false;
  if (token.includes("/")) return true;
  return /\d{4,}/.test(token);
}

/** 去掉 token 首尾的引号/逗号/分号，符号本身不属于目标名 */
function trimToken(raw: string): string {
  return raw.replace(/^["'`([{]+/, "").replace(/["'`)\]}.,;]+$/, "");
}

interface Bucket {
  skeleton: string;
  tokens: string[];
  commands: string[];
}

/** 把同类目标收进桶里（骨架相同即同类），返回命中数最大的那个 */
function pickBiggest(buckets: Map<string, Bucket>): EnumerationHit | null {
  let best: Bucket | null = null;
  for (const b of buckets.values()) {
    if (b.tokens.length < ENUM_MIN_TARGETS) continue;
    if (!best || b.tokens.length > best.tokens.length) best = b;
  }
  if (!best) return null;
  const cut = best.skeleton.indexOf("#");
  return {
    count: best.tokens.length,
    skeleton: best.skeleton,
    prefix: cut > 0 ? best.skeleton.slice(0, cut) : "",
    samples: best.tokens.slice(0, 3),
  };
}

/**
 * 判断这批命令是否在「逐个硬编码枚举同类目标」。
 *
 * 两种形态都覆盖：
 * ① 一条命令里塞一排：`mkdir -p a/20250801 a/20250802 a/20250803 a/20250804`
 * ② 多条命令各来一个：`mkdir -p a/20250801` × N 行（多行块会被拆成多条命令）
 */
export function findEnumeration(commands: string[]): EnumerationHit | null {
  const buckets = new Map<string, Bucket>();
  const bump = (sk: string, tokens: string[], command: string) => {
    const cur = buckets.get(sk);
    if (cur) {
      cur.tokens.push(...tokens);
      cur.commands.push(command);
    } else {
      buckets.set(sk, { skeleton: sk, tokens: [...tokens], commands: [command] });
    }
  };

  for (const command of commands) {
    // ① 一条命令内部的重复目标
    const groups = new Map<string, string[]>();
    for (const raw of command.split(/[\s"'`]+/)) {
      const token = trimToken(raw);
      if (!isSequenceToken(token)) continue;
      const sk = skeletonOf(token);
      const list = groups.get(sk);
      if (list) list.push(token);
      else groups.set(sk, [token]);
    }
    for (const [sk, tokens] of groups) {
      if (tokens.length >= ENUM_MIN_TARGETS) bump(sk, tokens, command);
    }
  }

  // ② 多条命令整体同构（每行一条，各只含一个目标）
  const whole = new Map<string, string[]>();
  for (const command of commands) {
    const flat = command.replace(/\s+/g, " ").trim();
    const sk = skeletonOf(flat);
    if (sk === flat) continue; // 没有数字，谈不上序列
    const list = whole.get(sk);
    if (list) list.push(flat);
    else whole.set(sk, [flat]);
  }
  for (const [sk, cmds] of whole) {
    if (cmds.length < ENUM_MIN_TARGETS) continue;
    const tokens = cmds.map((c) => c.split(" ").find((t) => t.includes("#")) ?? sk);
    bump(sk, tokens, cmds[0]);
  }

  return pickBiggest(buckets);
}

/**
 * 生成可直接照抄的改写建议。
 *
 * 给两条路而不是一条：等宽连续数字用花括号展开最短，跨月/跨年这类不连续的
 * 只能靠 `date` 推 —— 现场那个 2025-08-01 ~ 2025-09-01 正好落在后一种。
 */
export function suggestLoopRewrite(hit: EnumerationHit): string {
  const p = hit.prefix || "路径前缀";
  return [
    `本次把 ${hit.count} 个同类目标逐个写死了（骨架 \`${hit.skeleton}\`，例如 ${hit.samples
      .map((s) => `\`${s}\``)
      .join("、")}）。**这类「数量驱动」的批量动作要用一次循环做完，不是一条条抄路径。**`,
    `- 等宽连续编号：\`<命令> ${p}{起始..结束}\`，如 \`mkdir -p ${p}{01..31}\`（bash 花括号展开，自动补零）`,
    `- 跨月/跨年等不连续日期：`,
    "```bash",
    `for i in $(seq 0 N); do`,
    `  d=$(date -d "起始日 +$i day" +%Y%m%d)`,
    `  <命令> ${p}$d`,
    `done`,
    "```",
    `把**全部目标**都放进同一个循环（不是先写 5 个、下一轮再补 5 个），一条命令、一轮跑完。`,
  ].join("\n");
}
