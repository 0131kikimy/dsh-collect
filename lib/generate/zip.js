/**
 * 极简 ZIP 归档写入器（OOXML 容器用）。
 *
 * 特点：
 * - 只依赖 node:zlib，没有第三方依赖；
 * - 条目默认按 store（method=0）写入，内容较大且压缩确实更小时自动改用 deflate（method=8）；
 * - 时间戳默认固定为 1980-01-01 00:00，同样输入得到同样字节，生成器保持纯函数；
 * - 输入是文本时按 UTF-8 编码，条目名也按 UTF-8 写入并置位通用标志位（bit 11），中文文件名可用。
 */

import { deflateRawSync } from 'node:zlib';

/** 单个条目允许的最大原始字节数（防御性上限，正常文档远小于此值）。 */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

/** 超过这个体积才考虑压缩，小条目压缩后反而更大。 */
const COMPRESS_MIN_BYTES = 256;

/** CRC32 查表（多项式 0xEDB88320）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * 计算字节串的 CRC32。
 * @param {Uint8Array} bytes
 * @returns {number} 无符号 32 位整数
 */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 把各种输入统一成 Uint8Array（文本按 UTF-8）。
 * @param {string | Uint8Array | ArrayBuffer} data
 * @returns {Uint8Array}
 */
function toBytes(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('zip 条目内容必须是字符串、Uint8Array 或 ArrayBuffer');
}

/**
 * 把 JS 日期换算成 DOS 时间戳（年从 1980 起算，时间精确到 2 秒）。
 * @param {Date | undefined} date
 * @returns {{ dosTime: number, dosDate: number }}
 */
function dosStamp(date) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date(Date.UTC(1980, 0, 1));
  const year = Math.min(2107, Math.max(1980, value.getUTCFullYear()));
  const dosTime = (value.getUTCHours() << 11) | (value.getUTCMinutes() << 5) | Math.floor(value.getUTCSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((value.getUTCMonth() + 1) << 5) | value.getUTCDate();
  return { dosTime, dosDate };
}

/**
 * 组装一个 ZIP 归档。
 *
 * @param {{ name: string, data: string | Uint8Array | ArrayBuffer, compress?: boolean }[]} parts
 *   条目列表，顺序即写入顺序；name 使用正斜杠分隔的包内路径。
 * @param {{ compress?: boolean, level?: number, date?: Date }} [options]
 *   compress=false 时全部走 store 模式；level 是 deflate 压缩级别（0-9，默认 6）。
 * @returns {Uint8Array} 完整 ZIP 字节
 */
export function buildZip(parts, options = {}) {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('zip 至少需要一个条目');
  }
  const compress = options.compress !== false;
  const level = Number.isInteger(options.level) ? Math.min(9, Math.max(0, options.level)) : 6;
  const { dosTime, dosDate } = dosStamp(options.date);
  const encoder = new TextEncoder();
  const seen = new Set();

  const entries = parts.map((part) => {
    if (!part || typeof part.name !== 'string' || part.name === '') {
      throw new TypeError('zip 条目缺少 name');
    }
    if (seen.has(part.name)) throw new Error(`zip 条目重名：${part.name}`);
    seen.add(part.name);
    if (part.name.startsWith('/') || part.name.includes('\\') || part.name.split('/').includes('..')) {
      throw new Error(`zip 条目路径不合法：${part.name}`);
    }
    const nameBytes = encoder.encode(part.name);
    const raw = toBytes(part.data);
    if (raw.length > MAX_ENTRY_BYTES) throw new Error(`zip 条目过大：${part.name}`);
    let method = 0;
    let payload = raw;
    if (compress && part.compress !== false && raw.length >= COMPRESS_MIN_BYTES) {
      const deflated = deflateRawSync(raw, { level });
      if (deflated.length > 0 && deflated.length < raw.length) {
        method = 8;
        payload = deflated;
      }
    }
    return { nameBytes, raw, payload, method, crc: crc32(raw) };
  });

  let localSize = 0;
  let centralSize = 0;
  for (const entry of entries) {
    entry.offset = localSize;
    localSize += 30 + entry.nameBytes.length + entry.payload.length;
    centralSize += 46 + entry.nameBytes.length;
  }
  const totalSize = localSize + centralSize + 22;
  if (totalSize > 0xffffffff) throw new Error('zip 归档超过 4GB，超出本写入器的能力范围');

  const output = new Uint8Array(totalSize);
  const view = new DataView(output.buffer);
  let cursor = 0;

  /** 写本地文件头 + 数据。 */
  for (const entry of entries) {
    const start = cursor;
    view.setUint32(cursor, 0x04034b50, true); // 本地文件头签名
    cursor += 4;
    view.setUint16(cursor, 20, true); // 解压所需版本
    cursor += 2;
    view.setUint16(cursor, 0x0800, true); // bit 11：条目名按 UTF-8 编码
    cursor += 2;
    view.setUint16(cursor, entry.method, true);
    cursor += 2;
    view.setUint16(cursor, dosTime, true);
    cursor += 2;
    view.setUint16(cursor, dosDate, true);
    cursor += 2;
    view.setUint32(cursor, entry.crc, true);
    cursor += 4;
    view.setUint32(cursor, entry.payload.length, true);
    cursor += 4;
    view.setUint32(cursor, entry.raw.length, true);
    cursor += 4;
    view.setUint16(cursor, entry.nameBytes.length, true);
    cursor += 2;
    view.setUint16(cursor, 0, true); // 扩展字段长度
    cursor += 2;
    output.set(entry.nameBytes, cursor);
    cursor += entry.nameBytes.length;
    output.set(entry.payload, cursor);
    cursor += entry.payload.length;
    if (cursor - start !== 30 + entry.nameBytes.length + entry.payload.length) {
      throw new Error('内部错误：zip 本地记录长度不一致');
    }
  }

  const centralOffset = cursor;
  /** 写中央目录。 */
  for (const entry of entries) {
    view.setUint32(cursor, 0x02014b50, true); // 中央目录签名
    cursor += 4;
    view.setUint16(cursor, 20, true); // 创建者版本
    cursor += 2;
    view.setUint16(cursor, 20, true); // 解压所需版本
    cursor += 2;
    view.setUint16(cursor, 0x0800, true);
    cursor += 2;
    view.setUint16(cursor, entry.method, true);
    cursor += 2;
    view.setUint16(cursor, dosTime, true);
    cursor += 2;
    view.setUint16(cursor, dosDate, true);
    cursor += 2;
    view.setUint32(cursor, entry.crc, true);
    cursor += 4;
    view.setUint32(cursor, entry.payload.length, true);
    cursor += 4;
    view.setUint32(cursor, entry.raw.length, true);
    cursor += 4;
    view.setUint16(cursor, entry.nameBytes.length, true);
    cursor += 2;
    view.setUint16(cursor, 0, true); // 扩展字段
    cursor += 2;
    view.setUint16(cursor, 0, true); // 注释
    cursor += 2;
    view.setUint16(cursor, 0, true); // 起始磁盘号
    cursor += 2;
    view.setUint16(cursor, 0, true); // 内部属性
    cursor += 2;
    view.setUint32(cursor, 0x20, true); // 外部属性：普通文件
    cursor += 4;
    view.setUint32(cursor, entry.offset, true); // 本地头偏移
    cursor += 4;
    output.set(entry.nameBytes, cursor);
    cursor += entry.nameBytes.length;
  }
  if (cursor - centralOffset !== centralSize) {
    throw new Error('内部错误：zip 中央目录长度不一致');
  }

  view.setUint32(cursor, 0x06054b50, true); // 中央目录结束记录
  cursor += 4;
  view.setUint16(cursor, 0, true); // 当前磁盘号
  cursor += 2;
  view.setUint16(cursor, 0, true); // 中央目录起始磁盘号
  cursor += 2;
  view.setUint16(cursor, entries.length, true);
  cursor += 2;
  view.setUint16(cursor, entries.length, true);
  cursor += 2;
  view.setUint32(cursor, centralSize, true);
  cursor += 4;
  view.setUint32(cursor, centralOffset, true);
  cursor += 4;
  view.setUint16(cursor, 0, true); // 注释长度
  cursor += 2;
  if (cursor !== totalSize) throw new Error('内部错误：zip 总长度不一致');

  return output;
}
