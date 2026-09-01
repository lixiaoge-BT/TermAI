// 极简 SOCKS5 解析（仅支持无认证 CONNECT），用于动态端口转发（SOCKS 代理）。
// 把解析逻辑抽成纯函数，便于单测，无需真正建立连接。

export interface Socks5Target {
  host: string;
  port: number;
}

/**
 * 解析 SOCKS5 CONNECT 请求的目标地址。
 * 返回 null 表示数据不完整或不是合法的 CONNECT 请求（调用方应继续等待或关闭）。
 *
 * 请求格式：
 *   VER(1) CMD(1) RSV(1) ATYP(1) DST.ADDR DST.PORT(2)
 *   ATYP: 0x01=IPv4(4B)  0x03=DOMAIN(1B长度+N)  0x04=IPv6(16B)
 */
export function parseSocks5ConnectRequest(buf: Buffer): Socks5Target | null {
  if (buf.length < 4) return null;
  if (buf[0] !== 0x05) return null; // 仅支持 SOCKS5
  if (buf[1] !== 0x01) return null; // 仅支持 CONNECT
  const atyp = buf[3];
  let offset = 4;
  let host = "";

  if (atyp === 0x01) {
    // IPv4
    if (buf.length < offset + 4 + 2) return null;
    host = `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
    offset += 4;
  } else if (atyp === 0x03) {
    // 域名：先读 1 字节长度
    if (buf.length < offset + 1) return null;
    const len = buf[offset];
    offset += 1;
    if (buf.length < offset + len + 2) return null;
    host = buf.slice(offset, offset + len).toString("utf-8");
    offset += len;
  } else if (atyp === 0x04) {
    // IPv6
    if (buf.length < offset + 16 + 2) return null;
    const segs: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      segs.push(buf.readUInt16BE(offset + i).toString(16));
    }
    host = compressIpv6(segs);
    offset += 16;
  } else {
    return null;
  }

  if (buf.length < offset + 2) return null;
  const port = buf.readUInt16BE(offset);
  return { host, port };
}

/** 把 8 段 IPv6 压缩成规范形式（如 ::1），便于后续解析与展示。 */
function compressIpv6(segs: string[]): string {
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  let runLen = 0;
  for (let i = 0; i < 8; i++) {
    if (segs[i] === "0") {
      if (runStart === -1) {
        runStart = i;
        runLen = 1;
      } else {
        runLen++;
      }
      if (runLen > bestLen) {
        bestStart = runStart;
        bestLen = runLen;
      }
    } else {
      runStart = -1;
      runLen = 0;
    }
  }
  if (bestLen < 2) return segs.join(":");
  const head = segs.slice(0, bestStart);
  const tail = segs.slice(bestStart + bestLen);
  let s = "";
  if (head.length) s += head.join(":");
  s += "::";
  if (tail.length) s += tail.join(":");
  return s;
}

/** 构造 SOCKS5 连接成功应答（绑定到 0.0.0.0:0，地址信息无所谓）。 */
export function buildSocks5SuccessReply(): Buffer {
  // VER REP RSV ATYP BND.ADDR(4) BND.PORT(2)
  return Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}
