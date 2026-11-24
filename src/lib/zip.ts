// =====================================================
// 极简 ZIP 写入器（仅 STORE，不压缩）
// -----------------------------------------------------
// 为什么自己写：导出要产出 .docx，而 docx 就是一个 ZIP 包；项目里没有 zip 依赖，
// 也不想为一个「打三个 XML 文件」的功能引入几百 KB 的库。
//
// 只用 STORE（method 0）而不是 deflate：
//  · 不需要 zlib，浏览器与 Node 行为完全一致；
//  · 我们打包的是 XML 文本，体积本来就不大；
//  · deflate 需要额外实现压缩流，出错点远多于收益。
//
// 只在导出时调用一次，性能不敏感，所以结构优先于极致紧凑。
// =====================================================

export interface ZipEntry {
  /** 包内路径，必须用 `/` 分隔，不能以 `/` 开头 */
  name: string;
  data: Uint8Array;
}

let CRC_TABLE: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

/** 标准 CRC-32（IEEE 802.3），ZIP 每个条目都要带 */
export function crc32(bytes: Uint8Array): number {
  const table = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 时间戳（ZIP 头里只支持这个格式） */
function dosStamp(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

class Writer {
  private view: DataView;
  private pos = 0;
  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  u16(v: number) {
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }
  u32(v: number) {
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }
  bytes(b: Uint8Array) {
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }
  get offset() {
    return this.pos;
  }
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/**
 * 生成 ZIP 字节流。
 *
 * 文件名按 UTF-8 写入并置通用标志位 bit 11，这样 Word / 资源管理器都能正确显示；
 * 我们的文件名其实全是 ASCII，但置位没有副作用，省得以后加中文目录名时踩坑。
 */
export function zipStore(entries: ZipEntry[], when: Date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const { time, date } = dosStamp(when);

  const prepared = entries.map((e) => {
    const name = enc.encode(String(e.name).replace(/\\/g, "/").replace(/^\/+/, ""));
    return { name, data: e.data, crc: crc32(e.data), offset: 0 };
  });

  // 先算出每条的本地头偏移，再一次性分配：避免动态拼数组产生的多次拷贝
  let cursor = 0;
  for (const p of prepared) {
    p.offset = cursor;
    cursor += 30 + p.name.length + p.data.length;
  }
  const centralStart = cursor;
  let centralSize = 0;
  for (const p of prepared) centralSize += 46 + p.name.length;

  const out = new Uint8Array(centralStart + centralSize + 22);
  const w = new Writer(out);

  for (const p of prepared) {
    w.u32(SIG_LOCAL);
    w.u16(20); // version needed
    w.u16(0x0800); // UTF-8 文件名
    w.u16(0); // method: store
    w.u16(time);
    w.u16(date);
    w.u32(p.crc);
    w.u32(p.data.length);
    w.u32(p.data.length);
    w.u16(p.name.length);
    w.u16(0); // extra
    w.bytes(p.name);
    w.bytes(p.data);
  }

  for (const p of prepared) {
    w.u32(SIG_CENTRAL);
    w.u16(20); // version made by
    w.u16(20); // version needed
    w.u16(0x0800);
    w.u16(0); // method
    w.u16(time);
    w.u16(date);
    w.u32(p.crc);
    w.u32(p.data.length);
    w.u32(p.data.length);
    w.u16(p.name.length);
    w.u16(0); // extra
    w.u16(0); // comment
    w.u16(0); // disk start
    w.u16(0); // internal attrs
    w.u32(0); // external attrs
    w.u32(p.offset);
    w.bytes(p.name);
  }

  w.u32(SIG_EOCD);
  w.u16(0); // disk
  w.u16(0); // cd disk
  w.u16(prepared.length);
  w.u16(prepared.length);
  w.u32(centralSize);
  w.u32(centralStart);
  w.u16(0); // comment len

  return out;
}
