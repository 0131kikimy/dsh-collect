// dsh-collect · 图片格式识别
//
// 只做两件事：从字节头认出 png/jpeg/gif/webp 并读出宽高；从 URL/Content-Type 推扩展名。
// 不引第三方库、不解码像素——生成器排版只需要格式与尺寸。

/**
 * @typedef {Object} ImageInfo
 * @property {string} mime
 * @property {string} ext
 * @property {number} width   0 表示文件头里读不到
 * @property {number} height
 */

const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** 把入参统一成 Buffer，非 Buffer 视为不可识别。 */
function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  return null;
}

/** 读 PNG：8 字节魔数 + IHDR 里的宽高（大端）。 */
function sniffPng(b) {
  if (b.length < 24) return null;
  if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  return { mime: 'image/png', ext: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** 读 JPEG：逐段扫到 SOF 段取宽高。 */
function sniffJpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    const segLen = b.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > b.length) break;
      return { mime: 'image/jpeg', ext: 'jpg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    }
    if (segLen < 2) break;
    i += 2 + segLen;
  }
  return { mime: 'image/jpeg', ext: 'jpg', width: 0, height: 0 };
}

/** 读 GIF：版本标识后紧跟小端宽高。 */
function sniffGif(b) {
  if (b.length < 10) return null;
  const sig = b.toString('latin1', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  return { mime: 'image/gif', ext: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

/** 读 WebP：RIFF 容器内分 VP8（有损）/ VP8L（无损）/ VP8X（扩展）三种头。 */
function sniffWebp(b) {
  if (b.length < 30) return null;
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ' && b.length >= 30) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return { mime: 'image/webp', ext: 'webp', width: 0, height: 0 };
    return { mime: 'image/webp', ext: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return { mime: 'image/webp', ext: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { mime: 'image/webp', ext: 'webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return { mime: 'image/webp', ext: 'webp', width: 0, height: 0 };
}

/**
 * 从字节头识别图片格式与尺寸。
 * @param {Buffer|Uint8Array} buffer
 * @returns {ImageInfo|null} 认不出来返回 null
 */
export function sniffImage(buffer) {
  const b = toBuffer(buffer);
  if (!b || b.length < 4) return null;
  return sniffPng(b) || sniffJpeg(b) || sniffGif(b) || sniffWebp(b) || null;
}

/**
 * 从 URL / Content-Type 推断图片扩展名（不读字节，仅用于兜底命名）。
 * @param {string} url
 * @param {string} [contentType]
 * @returns {'png'|'jpg'|'gif'|'webp'|'bin'}
 */
export function guessImageExt(url, contentType) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  const byMime = {
    'image/png': 'png', 'image/x-png': 'png',
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg',
    'image/gif': 'gif', 'image/webp': 'webp',
  };
  if (byMime[mime]) return byMime[mime];
  let pathname = '';
  try {
    pathname = new URL(String(url || '')).pathname;
  } catch {
    pathname = String(url || '').split(/[?#]/)[0];
  }
  const hit = /\.(png|jpe?g|gif|webp)$/i.exec(pathname);
  if (!hit) return 'bin';
  const ext = hit[1].toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
}

/**
 * 扩展名 → MIME（落盘时给 meta.json 用）。
 * @param {string} ext
 * @returns {string}
 */
export function mimeByExt(ext) {
  return MIME_BY_EXT[String(ext || '').toLowerCase()] || 'application/octet-stream';
}
