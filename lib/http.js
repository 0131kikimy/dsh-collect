// dsh-collect · 直连 HTTP 抓取
//
// 契约见 CONTRACT.md §5.1：fetchUrl / fetchBinary。
// 本模块只负责「URL → 字节/文本」：协议白名单、重定向、gzip/deflate/br 解压、超时、
// 字节上限、SSRF 防护都在这里。失败一律回 {ok:false, error:中文}，不抛未捕获异常，
// 上层可以直接把 error 展示给用户。

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// 默认 UA 用桌面浏览器标识：不少站点（微信公众号、部分新闻站）对机器人 UA 直接返回
// 「环境异常」验证页而不是正文。插件只读公开页面，不发 POST、不登录、不伪造 Cookie。
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_REDIRECT_LIMIT = 6;
const MAX_REDIRECT_LIMIT = 20;
const MAX_TIMEOUT_MS = 300000;
const MAX_BYTES_LIMIT = 512 * 1024 * 1024;
const DEFAULT_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** 统一选项：非法数值回落到默认值，并在安全范围内夹紧。 */
function normalizeOptions(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const pickInt = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.max(Math.floor(n), min), max);
  };
  const headers = {};
  if (o.headers && typeof o.headers === 'object') {
    for (const [name, value] of Object.entries(o.headers)) {
      if (value === undefined || value === null) continue;
      headers[String(name)] = String(value);
    }
  }
  let body;
  if (o.body !== undefined && o.body !== null) {
    body = Buffer.isBuffer(o.body) ? o.body : Buffer.from(String(o.body), 'utf8');
  }
  return {
    timeoutMs: pickInt(o.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS),
    maxBytes: pickInt(o.maxBytes, DEFAULT_MAX_BYTES, 1, MAX_BYTES_LIMIT),
    redirectLimit: pickInt(o.redirectLimit, DEFAULT_REDIRECT_LIMIT, 0, MAX_REDIRECT_LIMIT),
    headers,
    method: String(o.method || 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET',
    body,
    userAgent: String(o.userAgent || DEFAULT_UA),
    allowPrivate: o.allowPrivate === true,
  };
}

/** 失败结果骨架（FetchResult 形状，ok=false）。 */
function failure(error, status = 0, finalUrl = '') {
  return {
    ok: false,
    status,
    finalUrl,
    contentType: '',
    headers: {},
    body: Buffer.alloc(0),
    bytes: 0,
    truncated: false,
    error: String(error || '请求失败'),
  };
}

/**
 * 判断一个 IP / 主机名是否属于本机或私有网段。
 * @param {string} address
 * @returns {boolean}
 */
export function isPrivateAddress(address) {
  const addr = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!addr) return true;
  if (addr === 'localhost' || addr.endsWith('.localhost')) return true;
  const zone = addr.split('%')[0];
  const family = isIP(zone);
  if (family === 4) {
    const parts = zone.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    if (parts[0] === 0 || parts[0] === 10 || parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // CGNAT
    if (parts[0] >= 224) return true; // 组播 / 保留
    return false;
  }
  if (family === 6) {
    if (zone === '::' || zone === '::1') return true;
    const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(zone);
    if (mappedDotted) return isPrivateAddress(mappedDotted[1]);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(zone);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (/^f[cd][0-9a-f]{2}:/.test(zone)) return true; // fc00::/7 唯一本地
    if (/^fe[89ab][0-9a-f]:/.test(zone)) return true; // fe80::/10 链路本地
    if (/^ff[0-9a-f]{2}:/.test(zone)) return true; // 组播
    return false;
  }
  return true; // 既不是合法 IP 也不该走到这里
}

/** SSRF 防护：协议已在调用处检查，这里只看主机名/解析结果。 */
async function ensurePublicHost(urlObj, allowPrivate) {
  const host = String(urlObj.hostname || '').toLowerCase();
  if (!host) throw new Error('网址缺少主机名');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    if (allowPrivate) return;
    throw new Error('已拒绝访问本机地址（SSRF 防护）；确需访问本机服务请显式打开 allowPrivate');
  }
  if (isIP(host)) {
    if (!allowPrivate && isPrivateAddress(host)) {
      throw new Error('已拒绝访问私有/本机地址（SSRF 防护）；确需访问请显式打开 allowPrivate');
    }
    return;
  }
  if (allowPrivate) return;
  let records;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`无法解析域名 ${host}（${err && err.code ? err.code : 'DNS 解析失败'}）`);
  }
  if (!Array.isArray(records) || records.length === 0) throw new Error(`无法解析域名 ${host}`);
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new Error(`域名 ${host} 解析到私有/本机地址，已拒绝（SSRF 防护）`);
    }
  }
}

/** 发一次请求，只等响应头；错误交给调用方归类。 */
function sendRequest(urlObj, { method, headers, body, userAgent, signal }) {
  return new Promise((resolve, reject) => {
    const transport = urlObj.protocol === 'https:' ? https : http;
    const merged = {
      'user-agent': userAgent,
      accept: DEFAULT_ACCEPT,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'accept-encoding': 'gzip, deflate, br',
      ...headers,
    };
    const req = transport.request(urlObj, { method, headers: merged, signal });
    req.on('response', resolve);
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 读原始响应字节，超过 maxBytes 就断开并标记截断。 */
function readRaw(res, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let truncated = false;
    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve({ buffer: Buffer.concat(chunks), truncated });
    };
    res.on('data', (chunk) => {
      if (truncated) return;
      const remain = maxBytes - size;
      if (chunk.length >= remain) {
        chunks.push(chunk.subarray(0, remain));
        size = maxBytes;
        truncated = true;
        try { res.destroy(); } catch { /* 已断开，忽略 */ }
        settle();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    res.on('end', () => settle());
    res.on('error', (err) => (truncated ? settle() : settle(err)));
    res.on('close', () => settle(new Error('响应在读取完成前中断')));
  });
}

/** 把源流经过 transform 抽出字节，同样受 maxBytes 约束。 */
function pump(source, transform, maxBytes, partialOnError) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let truncated = false;
    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      try { source.destroy(); } catch { /* 已结束，忽略 */ }
      if (transform) { try { transform.destroy(); } catch { /* 已结束，忽略 */ } }
      if (err && !truncated && !(partialOnError && chunks.length > 0)) reject(err);
      else resolve({ buffer: Buffer.concat(chunks), truncated });
    };
    const sink = transform || source;
    sink.on('data', (chunk) => {
      if (truncated) return;
      const remain = maxBytes - size;
      if (chunk.length >= remain) {
        chunks.push(chunk.subarray(0, remain));
        size = maxBytes;
        truncated = true;
        settle();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    sink.on('end', () => settle());
    sink.on('error', (err) => settle(err));
    if (transform) {
      source.on('error', (err) => settle(err));
      source.pipe(transform);
    }
  });
}

/** 按 Content-Encoding 解压；deflate 兼容少数服务器发的裸 deflate。 */
async function inflate(raw, encodingHeader, maxBytes) {
  const encoding = String(encodingHeader || '').toLowerCase().split(',')[0].trim();
  if (!encoding || encoding === 'identity') return { buffer: raw.buffer, truncated: raw.truncated };
  const kind = encoding === 'gzip' || encoding === 'x-gzip' ? 'gzip'
    : encoding === 'deflate' ? 'deflate'
      : encoding === 'br' ? 'br' : '';
  if (!kind) return { buffer: raw.buffer, truncated: raw.truncated }; // 不认识的编码按原件处理
  const run = (stream) => pump(
    Readable.from(raw.buffer.length > 0 ? [raw.buffer] : []),
    stream,
    maxBytes,
    raw.truncated,
  );
  try {
    return await run(kind === 'gzip'
      ? zlib.createGunzip()
      : kind === 'br' ? zlib.createBrotliDecompress() : zlib.createInflate());
  } catch (err) {
    if (kind === 'deflate') {
      try { return await run(zlib.createInflateRaw()); } catch { return null; }
    }
    return null;
  }
}

/** 把底层网络错误翻译成给用户看的中文。 */
function describeNetworkError(err, urlObj) {
  const code = (err && (err.code || (err.cause && err.cause.code))) || '';
  const map = {
    ENOTFOUND: `域名解析失败（${urlObj.hostname}）`,
    EAI_AGAIN: 'DNS 暂时不可用',
    ECONNREFUSED: '目标拒绝连接',
    ECONNRESET: '连接被对方重置',
    ETIMEDOUT: '连接超时',
    EHOSTUNREACH: '主机不可达',
    ENETUNREACH: '网络不可达',
    EPROTO: 'TLS 协议错误',
    CERT_HAS_EXPIRED: 'HTTPS 证书已过期',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'HTTPS 证书校验失败',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'HTTPS 证书是自签名的，校验失败',
    ERR_TLS_CERT_ALTNAME_INVALID: 'HTTPS 证书域名不匹配',
    ERR_INVALID_URL: '网址格式不正确',
    ERR_FR_TOO_MANY_REDIRECTS: '重定向次数过多',
  };
  if (err && (err.name === 'AbortError' || code === 'ABORT_ERR')) return '请求被中断';
  const detail = map[code] || (err && err.message) || '网络请求失败';
  return code && !map[code] ? `请求失败：${detail}（${code}）` : `请求失败：${detail}`;
}

/** 抓取核心：协议 → SSRF → 请求 →（重定向）→ 读字节 → 解压。 */
async function fetchCore(inputUrl, rawOpts) {
  const opts = normalizeOptions(rawOpts);
  let current;
  try {
    current = new URL(String(inputUrl === undefined || inputUrl === null ? '' : inputUrl).trim());
  } catch {
    return failure('无效的网址，无法解析');
  }
  const deadline = Date.now() + opts.timeoutMs;
  let redirects = 0;
  let method = opts.method;
  let body = opts.body;
  for (;;) {
    if (!/^https?:$/i.test(current.protocol)) {
      return failure(`不支持的协议 ${current.protocol || '(无)'}，只允许 http/https`, 0, current.href);
    }
    try {
      await ensurePublicHost(current, opts.allowPrivate);
    } catch (err) {
      return failure((err && err.message) || '目标地址不被允许', 0, current.href);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return failure(`请求超时（超过 ${opts.timeoutMs} 毫秒）`, 0, current.href);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, remaining);
    let res;
    try {
      res = await sendRequest(current, {
        method, headers: opts.headers, body, userAgent: opts.userAgent, signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      return failure(timedOut ? `请求超时（超过 ${opts.timeoutMs} 毫秒）` : describeNetworkError(err, current), 0, current.href);
    }
    const status = Number(res.statusCode) || 0;
    const headers = {};
    for (const [name, value] of Object.entries(res.headers)) {
      if (value === undefined) continue;
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    if (REDIRECT_STATUS.has(status) && headers.location) {
      clearTimeout(timer);
      try { res.destroy(); } catch { /* 丢弃重定向响应体 */ }
      if (redirects >= opts.redirectLimit) {
        return failure(`重定向次数超过上限（${opts.redirectLimit} 次），已停止`, status, current.href);
      }
      let next;
      try { next = new URL(headers.location, current); } catch { return failure('重定向地址无法解析', status, current.href); }
      redirects += 1;
      if (status === 303 || ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        body = undefined;
      }
      current = next;
      continue;
    }
    try {
      const raw = await readRaw(res, opts.maxBytes);
      clearTimeout(timer);
      const inflated = await inflate(raw, headers['content-encoding'], opts.maxBytes);
      if (!inflated) return failure('响应解压失败（gzip/deflate/br 数据损坏）', status, current.href);
      const ok = status >= 200 && status < 300;
      const result = {
        ok,
        status,
        finalUrl: current.href,
        contentType: headers['content-type'] || '',
        headers,
        body: inflated.buffer,
        bytes: inflated.buffer.length,
        truncated: Boolean(raw.truncated || inflated.truncated),
      };
      if (!ok) result.error = `服务器返回 HTTP ${status}`;
      return result;
    } catch (err) {
      clearTimeout(timer);
      try { res.destroy(); } catch { /* 已失败，忽略 */ }
      return failure(
        timedOut ? `请求超时（超过 ${opts.timeoutMs} 毫秒）` : `读取响应失败：${(err && err.message) || err}`,
        status,
        current.href,
      );
    }
  }
}

/** 归一化 charset 名称（中文站点常见 gb2312/gbk/gb18030）。 */
function normalizeCharset(label) {
  const name = String(label || '').trim().toLowerCase().replace(/^["']|["']$/g, '');
  const map = {
    utf8: 'utf-8', 'utf-8': 'utf-8', gb2312: 'gbk', gbk: 'gbk', gb18030: 'gb18030',
    big5: 'big5', 'big5-hkscs': 'big5', latin1: 'iso-8859-1', 'iso-8859-1': 'iso-8859-1',
    'windows-1252': 'windows-1252', 'utf-16': 'utf-16le', 'utf-16le': 'utf-16le', 'utf-16be': 'utf-16be',
  };
  return map[name] || name;
}

/** 猜字符集：响应头 → BOM → meta charset → utf-8。 */
function detectCharset(buffer, contentType) {
  if (!buffer || buffer.length === 0) return 'utf-8';
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(String(contentType || ''));
  if (fromHeader) return normalizeCharset(fromHeader[1]);
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf-8';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf-16le';
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf-16be';
  const head = buffer.subarray(0, 4096).toString('latin1');
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
  if (meta) return normalizeCharset(meta[1]);
  return 'utf-8';
}

/** 按字符集解码，失败退回 utf-8；BOM 由 TextDecoder 吞掉。 */
function decodeText(buffer, charset) {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    return buffer.toString('utf8').replace(/^\uFEFF/, '');
  }
}

/**
 * 抓一个网页（文本）：body 始终是解压后的 Buffer，另附解码后的 text 与 charset。
 * @param {string} url
 * @param {import('./http.js').FetchOptions} [opts]
 * @returns {Promise<import('./http.js').FetchResult & {charset:string, text:string}>}
 */
export async function fetchUrl(url, opts) {
  let result;
  try {
    result = await fetchCore(url, opts);
  } catch (err) {
    return { ...failure(`请求失败：${(err && err.message) || err}`), charset: 'utf-8', text: '' };
  }
  const charset = detectCharset(result.body, result.contentType);
  const text = result.body.length > 0 ? decodeText(result.body, charset) : '';
  return { ...result, charset, text };
}

/**
 * 抓二进制（图片、附件）：不做文本解码。
 * @param {string} url
 * @param {import('./http.js').FetchOptions} [opts]
 * @returns {Promise<import('./http.js').FetchResult>}
 */
export async function fetchBinary(url, opts) {
  try {
    return await fetchCore(url, opts);
  } catch (err) {
    return failure(`请求失败：${(err && err.message) || err}`);
  }
}

/**
 * @typedef {Object} FetchOptions
 * @property {number} [timeoutMs=20000]
 * @property {number} [maxBytes=8388608]
 * @property {Record<string,string>} [headers]
 * @property {string} [method='GET']
 * @property {string|Buffer} [body]
 * @property {number} [redirectLimit=6]
 * @property {string} [userAgent]
 * @property {boolean} [allowPrivate=false]  false 时拒绝本机/私有网段（SSRF 防护）
 */

/**
 * @typedef {Object} FetchResult
 * @property {boolean} ok
 * @property {number} status
 * @property {string} finalUrl
 * @property {string} contentType
 * @property {Record<string,string>} headers
 * @property {Buffer} body
 * @property {number} bytes
 * @property {boolean} truncated      触到 maxBytes 上限被截断
 * @property {string} [error]         失败时的中文原因
 */
