/**
 * Jump Connect / Deep Link 参数解析器
 * -----------------------------------------------------------------------------
 * 让 TermAI 支持从外部被唤起时直接连到目标主机，覆盖堡垒机（jumpserver /
 * 齐治 / 安恒 / 碉堡 等）的「外部 SSH 客户端」对接场景。
 *
 * 当前支持以下入口形态（按优先级匹配，每条独立可命中）：
 *   1) 自定义协议 termai://connect?host=...&user=...&port=...&password=...&protocol=ssh
 *   2) Xshell 兼容:  -url ssh://[user[:pass]@]host[:port]
 *   3) Xshell 兼容:  -newtab -url ssh://...   （堡垒机常用）
 *   4) Xshell 兼容:  -ssh user@host  -pw password  -p port
 *   5) Xshell 兼容:  -t user@host -pw password -p port        （OpenSSH 风格，Xshell 也接受）
 *   6) Xshell 兼容:  -l user -h host -p port -w password      （长 flag 风格）
 *   7) Xshell 兼容:  user@host[:port] -pw password -p port    （裸 target 前缀）
 *   8) 自定义:        --jump host=X port=Y user=Z password=P protocol=ssh
 *   9) 自定义 KV:     --server=host --user=user --password=pw --port=22
 *  10) .xsh 文件:     TermAI.exe "C:\...\session.xsh"          （Xshell session 文件）
 *  11) 兜底:          ssh://user:pass@host:port  (单独一项就直接解析)
 *
 * Windows 协议唤起时，URL 会出现在 process.argv 里走 (1)/(2)/(3)/(4)/(11)。
 * macOS 协议唤起时，URL 走 app.on('open-url') 而不是 argv。
 * 二次启动（堡垒机再次点击）走 'second-instance'，argv 从事件回调里取。
 *
 * 类型定义统一在 electron/preload/index.ts 暴露，避免重复定义。
 */

import { existsSync, readFileSync } from "node:fs";
import type { JumpConnectParams, JumpSource } from "../preload/index";

export type { JumpConnectParams, JumpSource } from "../preload/index";

/**
 * 从 argv 中解析连接参数。
 * @param argv  - 通常是 process.argv 或 second-instance 提供的 argv
 * @param source - 入口标识，便于排查
 */
export function parseJumpArgs(
  argv: string[],
  source: JumpSource = "argv"
): JumpConnectParams | null {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  // 跳过 argv[0]（exe 路径）；其余 token 一一检视
  const tokens = argv.slice(1);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;

    // 1) termai://connect?... 协议 URL
    if (/^termai:\/\//i.test(t)) {
      const r = parseJumpUrl(t, source);
      if (r) return r;
      continue;
    }

    // 11) 单独一个 ssh:// 链接（argv 里就是它）
    if (/^ssh:\/\//i.test(t)) {
      const r = parseSshUrl(t, source);
      if (r) return r;
      continue;
    }

    // 10) .xsh 会话文件（Xshell session）
    if (/\.xsh$/i.test(t) && existsSync(t)) {
      const r = parseXshFile(t, source);
      if (r) return r;
      continue;
    }

    // 2) Xshell: -url <ssh URL> 或 --url
    if (t === "-url" || t === "--url") {
      const next = tokens[i + 1];
      if (next && /^ssh:\/\//i.test(next)) {
        const r = parseSshUrl(next, source);
        if (r) return r;
      }
      continue;
    }

    // 4) Xshell: -ssh user@host  后跟若干 -pw / -p
    // 5) OpenSSH/Xshell: -t user@host
    if (t === "-ssh" || t === "--ssh" || t === "-t" || t === "--target") {
      const r = parseSshFlagPair(tokens, i, source);
      if (r) return r;
      continue;
    }

    // 6) 长 flag 风格: -l user -h host -p port -w password
    if (t === "-l" || t === "--login" || t === "-h" || t === "--host") {
      const r = parseLongFlagPair(tokens, source);
      if (r) return r;
      continue;
    }

    // 8) 自定义: --jump host=X port=Y user=Z password=P protocol=ssh
    if (t === "--jump" || t === "-j") {
      const r = parseJumpKvPair(tokens.slice(i + 1));
      if (r) return { ...r, source };
      continue;
    }

    // 9) 自定义 KV 风格: --server=host --user=user --password=pw --port=22
    if (/^--(server|host|user|username|password|pw|port)\s*=/i.test(t)) {
      const r = parseLongKvPair(tokens);
      if (r) return r;
      continue;
    }

    // 7) 裸 user@host[:port] 前缀（不带任何 flag）
    if (/^[\w.-]+@[\w.-]+(:\d+)?$/.test(t)) {
      const r = parseBareTarget(tokens, i, source);
      if (r) return r;
      continue;
    }
  }
  return null;
}

/** termai://connect?host=...&user=...&port=...&password=...&protocol=ssh */
function parseJumpUrl(
  raw: string,
  source: JumpSource
): JumpConnectParams | null {
  try {
    const u = new URL(raw);
    // termai://connect?...  → URL 的 pathname='/connect'，search 在 u.search
    // 但有些堡垒机会写 termai://?host=... 这种，所以两者都尝试
    const sp = new URLSearchParams(u.search || "");
    let host = sp.get("host");
    let username = sp.get("user") || sp.get("username") || "";
    let password = sp.get("password") || sp.get("pw") || undefined;
    let protocol = (sp.get("protocol") || "ssh").toLowerCase();
    let portStr = sp.get("port");
    // path 上也可能带 query（极少见），兼容一下
    if (!host && u.pathname.includes("=")) {
      const sp2 = new URLSearchParams(u.pathname.replace(/^\//, ""));
      host = sp2.get("host") ?? host;
      username = sp2.get("user") ?? username;
      password = sp2.get("password") ?? password;
      protocol = (sp2.get("protocol") || protocol).toLowerCase();
      portStr = sp2.get("port") ?? portStr;
    }
    if (!host || protocol !== "ssh") return null;
    return {
      protocol: "ssh",
      host,
      port: parsePort(portStr),
      username,
      password,
      source,
    };
  } catch {
    return null;
  }
}

/** ssh://[user[:pass]@]host[:port] —— 必须正确处理 : / @ / %40 等转义 */
function parseSshUrl(
  raw: string,
  source: JumpSource
): JumpConnectParams | null {
  try {
    const u = new URL(raw);
    const host = u.hostname;
    const port = u.port ? parsePort(u.port) : 22;
    if (!host) return null;
    const username = u.username ? decodeURIComponent(u.username) : "";
    const password =
      u.password != null && u.password !== "" ? decodeURIComponent(u.password) : undefined;
    // 私密：unix socket / 路径片段先不支持；ssh2 也只接 host:port
    return {
      protocol: "ssh",
      host,
      port,
      username,
      password,
      source,
    };
  } catch {
    return null;
  }
}

/**
 * Xshell / OpenSSH 风格的成对 flag 解析：
 *   -ssh user@host  -pw password  -p port
 *   -t   user@host  -pw password  -p port
 *   --ssh user@host --pw password --port 22
 *
 * 注意：-p 在 OpenSSH 里也是 "preserve timestamps"（给 scp/rsync 用），
 * 但在 Xshell 的 SSH 客户端里就是端口。这里按 Xshell 语义处理。
 */
function parseSshFlagPair(
  tokens: string[],
  startIdx: number,
  source: JumpSource
): JumpConnectParams | null {
  const target = tokens[startIdx + 1];
  if (!target) return null;
  const atIdx = target.lastIndexOf("@");
  if (atIdx <= 0) return null;
  const username = target.slice(0, atIdx);
  const hostPort = target.slice(atIdx + 1);
  const colonIdx = hostPort.indexOf(":");
  let host = hostPort;
  let port = 22;
  if (colonIdx >= 0) {
    host = hostPort.slice(0, colonIdx);
    const p = parseInt(hostPort.slice(colonIdx + 1), 10);
    if (!isNaN(p) && p > 0) port = p;
  }
  if (!host) return null;

  let password: string | undefined;
  let explicitPort: number | undefined;
  for (let i = startIdx + 2; i < tokens.length; i++) {
    const tk = tokens[i];
    const next = tokens[i + 1];
    if (
      (tk === "-pw" || tk === "--pw" || tk === "--password" || tk === "-password" || tk === "-w") &&
      next !== undefined
    ) {
      password = next;
    } else if ((tk === "-p" || tk === "--port" || tk === "-port") && next !== undefined) {
      const p = parseInt(next, 10);
      if (!isNaN(p) && p > 0) explicitPort = p;
    } else if (tk && tk.startsWith("-")) {
      // 遇到下一个 flag，提前结束本组解析
      break;
    }
  }
  return {
    protocol: "ssh",
    host,
    port: explicitPort ?? port,
    username,
    password,
    source,
  };
}

/**
 * 长 flag 风格（堡垒机有些版本会用）：
 *   -l user -h host -p port -w password
 *   --login user --host host --port port --password password
 *
 * 这里采用 "扫描整个 argv，命中任一相关 flag 即尝试凑齐" 的策略，
 * 因为用户传这类参数时 flag 顺序不一定。
 */
function parseLongFlagPair(
  tokens: string[],
  source: JumpSource
): JumpConnectParams | null {
  let username: string | undefined;
  let host: string | undefined;
  let port: number | undefined;
  let password: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    const next = tokens[i + 1];
    if ((tk === "-l" || tk === "--login" || tk === "--user" || tk === "-user") && next) {
      username = next;
    } else if ((tk === "-h" || tk === "--host" || tk === "--server") && next) {
      host = next;
    } else if ((tk === "-p" || tk === "--port") && next) {
      const p = parseInt(next, 10);
      if (!isNaN(p) && p > 0) port = p;
    } else if (
      (tk === "-w" || tk === "-pw" || tk === "--password" || tk === "-password") &&
      next
    ) {
      password = next;
    }
  }
  if (!host || !username) return null;
  return {
    protocol: "ssh",
    host,
    port: port ?? 22,
    username,
    password,
    source,
  };
}

/** 自定义 --jump host=X port=Y user=Z password=P protocol=ssh */
function parseJumpKvPair(
  parts: string[]
): Omit<JumpConnectParams, "source"> | null {
  const map = new Map<string, string>();
  for (const p of parts) {
    if (!p) continue;
    if (p.startsWith("-")) break; // 下一个 flag 了，提前结束
    const eq = p.indexOf("=");
    if (eq <= 0) break;
    const k = p.slice(0, eq).toLowerCase();
    const v = p.slice(eq + 1);
    map.set(k, v);
  }
  const host = map.get("host");
  const protocol = (map.get("protocol") || "ssh").toLowerCase();
  if (!host || protocol !== "ssh") return null;
  return {
    protocol: "ssh",
    host,
    port: parsePort(map.get("port")),
    username: map.get("user") || map.get("username") || "",
    password: map.get("password") || map.get("pw") || undefined,
    privateKey: map.get("privatekey") || map.get("key") || undefined,
  };
}

/**
 * 长 flag + 等号风格：--server=host --user=user --password=pw --port=22
 * 这是 Linux 工具链（ssh / curl 等）最常见的写法，部分堡垒机会用。
 */
function parseLongKvPair(
  tokens: string[]
): JumpConnectParams | null {
  let username = "";
  let port: number | undefined;
  let password: string | undefined;
  let host: string | undefined;
  for (const t of tokens) {
    if (!t || !t.startsWith("--")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(2, eq).toLowerCase();
    const v = t.slice(eq + 1);
    if (k === "server" || k === "host") host = v;
    else if (k === "user" || k === "username") username = v;
    else if (k === "password" || k === "pw") password = v;
    else if (k === "port") port = parsePort(v);
  }
  if (!host) return null;
  return {
    protocol: "ssh",
    host,
    port: port ?? 22,
    username,
    password,
    source: "argv",
  };
}

/**
 * 裸 target 前缀：TermAI.exe user@host -pw password -p port
 * 没有任何前置 flag。常见于堡垒机用「直接传地址」的模式。
 */
function parseBareTarget(
  tokens: string[],
  startIdx: number,
  source: JumpSource
): JumpConnectParams | null {
  const target = tokens[startIdx];
  const atIdx = target.lastIndexOf("@");
  if (atIdx <= 0) return null;
  const username = target.slice(0, atIdx);
  const hostPort = target.slice(atIdx + 1);
  const colonIdx = hostPort.indexOf(":");
  let host = hostPort;
  let port = 22;
  if (colonIdx >= 0) {
    host = hostPort.slice(0, colonIdx);
    const p = parseInt(hostPort.slice(colonIdx + 1), 10);
    if (!isNaN(p) && p > 0) port = p;
  }
  if (!host) return null;

  let password: string | undefined;
  let explicitPort: number | undefined;
  for (let i = startIdx + 1; i < tokens.length; i++) {
    const tk = tokens[i];
    const next = tokens[i + 1];
    if (
      (tk === "-pw" || tk === "--pw" || tk === "--password" || tk === "-password" || tk === "-w") &&
      next !== undefined
    ) {
      password = next;
    } else if ((tk === "-p" || tk === "--port" || tk === "-port") && next !== undefined) {
      const p = parseInt(next, 10);
      if (!isNaN(p) && p > 0) explicitPort = p;
    } else if (tk && tk.startsWith("-")) {
      // 遇到下一个 flag，提前结束本组解析
      break;
    } else if (tk && password === undefined && !/^\d+$/.test(tk)) {
      // 「散装」位置参数兜底 —— Electron 的 second-instance 会重排 argv：
      // 把所有 -xxx 开关提到前面、它们的值以位置参数形式留在末尾，
      // 于是 "-ssh user@host -pw xxx -p 2222" 变成
      //   [..., "-ssh", "-pw", "-p", ..., "user@host", "xxx", "2222"]
      // flag 与值的相邻关系彻底失效，这里按「紧随 target 的非数字 token = 密码」补回。
      password = tk;
    } else if (tk && explicitPort === undefined && /^\d+$/.test(tk)) {
      // 同理，散装形态下端口变成末尾的纯数字位置参数
      const p = parseInt(tk, 10);
      if (p > 0 && p <= 65535) explicitPort = p;
    }
  }
  return {
    protocol: "ssh",
    host,
    port: explicitPort ?? port,
    username,
    password,
    source,
  };
}

/**
 * Xshell session 文件（XML 格式）。
 * 部分堡垒机为了让"外部客户端"少传命令行参数，会把 SSH 凭据写到 .xsh 文件，
 * 然后 spawn 时把文件路径作为唯一参数传过来。
 *
 * .xsh 文件结构（典型）：
 *   <session>
 *     <host>1.2.3.4</host>
 *     <port>22</port>
 *     <user>wsupport</user>
 *     <password>...</password>
 *     <protocol>SSH</protocol>
 *   </session>
 *
 * 这里做最宽松的 tag 匹配，兼容 Xshell 4/5/6/7 不同 schema。
 */
function parseXshFile(
  path: string,
  source: JumpSource
): JumpConnectParams | null {
  try {
    const xml = readFileSync(path, "utf8");
    const host = matchTag(xml, "Host") ?? matchTag(xml, "host");
    if (!host) return null;
    const protocolRaw = matchTag(xml, "Protocol") ?? matchTag(xml, "protocol") ?? "SSH";
    if (protocolRaw && !/ssh/i.test(protocolRaw)) return null;

    const username = matchTag(xml, "UserName") ?? matchTag(xml, "userName") ??
                     matchTag(xml, "Username") ?? matchTag(xml, "username") ?? "";
    const password = matchTag(xml, "Password") ?? matchTag(xml, "password");
    const portStr = matchTag(xml, "Port") ?? matchTag(xml, "port");
    // Xshell 会把密码用 base64 之类的加密串保存（<Password Encoding="...">...</Password>），
    // 我们的简化解析只读明文 —— 明文存在则用，不存在则仅记录 host/user 让用户手输。
    return {
      protocol: "ssh",
      host,
      port: parsePort(portStr),
      username,
      password: password || undefined,
      source,
    };
  } catch {
    return null;
  }
}

/** 取 <Tag>...</Tag> 里的文本，忽略大小写与属性，支持 CDATA */
function matchTag(xml: string, tag: string): string | null {
  // 转义正则特殊字符（Xshell tag 都是 ASCII，不会撞上）
  const re = new RegExp(
    `<\\s*${tag}\\b[^>]*>([\\s\\S]*?)<\\s*/\\s*${tag}\\s*>`,
    "i"
  );
  const m = xml.match(re);
  if (!m) return null;
  let v = m[1].trim();
  // CDATA
  const cd = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cd) v = cd[1];
  return v || null;
}

function parsePort(v: string | null | undefined): number {
  if (!v) return 22;
  const p = parseInt(v, 10);
  return isNaN(p) || p <= 0 ? 22 : p;
}