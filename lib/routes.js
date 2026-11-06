// dsh-collect · 面板 HTTP API
//
// 挂在宿主 webServer 上，与 DSH Web GUI 同源同端口，前缀 /dsh-collect/api。
// 安全边界：
//   · 只接受来自本机回环地址的请求（面板就在本机页面里）；
//   · 所有请求必须带自定义头 `x-collect-client: 1`（跨站请求带不上，天然挡 CSRF）；
//   · 所有文件读写都限制在输出目录内（safeJoin）。
//
// 这些路由只服务插件面板。AI 调用的是 lib/tools.js 里的工具，两条路径共用 pipeline/export。

import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import { FORMATS } from './config.js';
import { markdownToDoc, renderToFile } from './export.js';
import { safeJoin } from './pipeline.js';

/** 路由前缀。 */
const PREFIX = '/dsh-collect/api';
/** 请求体上限。 */
const MAX_BODY_BYTES = 512 * 1024;

/** 格式 → 扩展名。 */
const FORMAT_EXT = Object.freeze({
  md: 'md',
  html: 'html',
  txt: 'txt',
  csv: 'csv',
  json: 'json',
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
  pdf: 'pdf',
});

/** MIME 表。 */
const MIME = Object.freeze({
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
});

/**
 * 发送 JSON。
 * @param {import('node:http').ServerResponse} res - 响应对象。
 * @param {number} status - 状态码。
 * @param {unknown} body - JSON 可序列化对象。
 * @returns {void}
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

/**
 * 读请求体（限 512KB）。
 * @param {import('node:http').IncomingMessage} req - 请求对象。
 * @returns {Promise<string>} UTF-8 文本。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 是否来自本机回环地址。
 * @param {import('node:http').IncomingMessage} req - 请求对象。
 * @returns {boolean} 是否本机。
 */
function isLoopback(req) {
  const remote = req.socket?.remoteAddress || '';
  return /^(127\.|::1$|::ffff:127\.)/.test(remote);
}

/**
 * 判断请求是否来自插件面板（自定义头 + 同源）。
 * @param {import('node:http').IncomingMessage} req - 请求对象。
 * @returns {boolean} 是否可信。
 */
function isCollectClient(req) {
  if (req.headers['x-collect-client'] !== '1') return false;
  const origin = req.headers.origin;
  if (!origin) return true; // 同源的同站请求可能不带 Origin
  try {
    const host = req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * 取文件名里安全的部分（去掉扩展名与非法字符）。
 * @param {string} title - 标题。
 * @param {string} fallback - 兜底名。
 * @returns {string} 安全文件名（不含扩展名）。
 */
function safeBaseName(title, fallback) {
  const cleaned = String(title || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned || fallback;
}

/**
 * 注册全部面板 API 路由。
 * @param {object} options - 依赖。
 * @param {object} options.webServer - 宿主 webServer 服务。
 * @param {object} options.deps - 依赖集合。
 * @param {() => object} options.deps.getConfig - 取当前生效配置。
 * @param {(patch: object) => object} options.deps.applySettings - 保存设置并返回新配置。
 * @param {(input: {urls: string[]}) => Promise<object[]>} options.deps.collect - 批量采集。
 * @param {() => Promise<object[]>} options.deps.listItems - 历史列表。
 * @param {(rel: string) => Promise<object>} options.deps.readItem - 读一条正文。
 * @param {(message: string) => void} [options.deps.log] - 日志。
 * @returns {{dispose: () => void}} 注销函数。
 */
export function registerRoutes({ webServer, deps }) {
  const disposers = [];
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  /**
   * 统一包一层：本机校验 + 自定义头校验 + 异常兜底。
   * @param {(req: any, res: any, url: URL) => Promise<void>|void} handler - 业务处理。
   * @returns {(req: any, res: any) => Promise<void>} 路由处理函数。
   */
  const wrap = (handler) => async (req, res) => {
    try {
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '只接受本机请求' });
      if (!isCollectClient(req)) return sendJson(res, 403, { ok: false, error: '缺少面板请求头' });
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      await handler(req, res, url);
    } catch (error) {
      log(`dsh-collect: 面板请求失败 ${error?.stack ?? error}`);
      try {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      } catch {
        /* 响应可能已发出 */
      }
    }
  };

  /**
   * 注册一个 exact 路由。
   * @param {string} subPath - 前缀之后的路径（如 '/state'）。
   * @param {(req: any, res: any, url: URL) => Promise<void>|void} handler - 处理函数。
   * @returns {void}
   */
  const route = (subPath, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path: `${PREFIX}${subPath}`, handler: wrap(handler) }));
  };

  // ── GET /state ────────────────────────────────────────────────────────────
  route('/state', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    const config = deps.getConfig();
    const workspace = await deps.workspace();
    let capabilities;
    try {
      capabilities = await deps.capabilities();
    } catch (error) {
      capabilities = { error: String(error?.message ?? error) };
    }
    let items = [];
    try {
      items = await deps.listItems();
    } catch {
      items = [];
    }
    sendJson(res, 200, {
      ok: true,
      version: deps.version,
      config,
      capabilities,
      workspace,
      formats: FORMATS,
      items,
    });
  });

  // ── POST /settings ────────────────────────────────────────────────────────
  route('/settings', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    let posted;
    try {
      posted = JSON.parse(await readBody(req));
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${error?.message ?? error}` });
    }
    if (!posted || typeof posted !== 'object' || Array.isArray(posted)) {
      return sendJson(res, 400, { ok: false, error: '请求体必须是对象' });
    }
    // 兼容两种请求体：契约里的 { patch: {...} }，以及直接平铺的字段对象。
    const patch = posted.patch && typeof posted.patch === 'object' && !Array.isArray(posted.patch) ? posted.patch : posted;
    const result = deps.applySettings(patch);
    if (result?.issues) return sendJson(res, 400, { ok: false, issues: result.issues });
    sendJson(res, 200, { ok: true, config: result.config });
  });

  // ── POST /collect ─────────────────────────────────────────────────────────
  route('/collect', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    let posted;
    try {
      posted = JSON.parse(await readBody(req));
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${error?.message ?? error}` });
    }
    const urls = deps.parseUrls(posted?.urls);
    if (urls.length === 0) return sendJson(res, 400, { ok: false, error: '没有识别到合法网址（需要 http:// 或 https://）' });
    const items = await deps.collect({ urls });
    sendJson(res, 200, { ok: true, items });
  });

  // ── POST /export ──────────────────────────────────────────────────────────
  route('/export', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    let posted;
    try {
      posted = JSON.parse(await readBody(req));
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${error?.message ?? error}` });
    }
    const format = String(posted?.format || '').toLowerCase();
    if (!FORMATS.includes(format)) return sendJson(res, 400, { ok: false, error: `不支持的格式：${format || '（空）'}` });
    // 优先用 rel（相对工作目录的完整路径）；只有 slug 时按「输出目录/slug」还原。
    let relative = String(posted?.rel || '').trim();
    if (!relative) {
      const slug = String(posted?.slug || '').trim();
      if (slug) relative = path.join(deps.getConfig().output.dir, slug);
    }
    if (!relative) return sendJson(res, 400, { ok: false, error: '缺少 rel（采集结果目录）' });

    const item = await deps.readItem(relative);
    const itemDir = deps.itemDir(relative);
    if (!itemDir) return sendJson(res, 400, { ok: false, error: '路径不合法' });

    const config = deps.getConfig();
    const doc = markdownToDoc({
      markdown: item.markdown,
      title: posted?.title || item.meta?.title || '采文文档',
      subtitle: item.meta?.url ? `来源：${item.meta.url}` : '',
      sourceUrl: item.meta?.url || '',
      collectedAt: item.meta?.collectedAt || item.meta?.collected_at || '',
      baseDir: itemDir,
    });
    const baseName = safeBaseName(doc.title, '采集文档');
    const ext = FORMAT_EXT[format];
    const outputPath = path.join(itemDir, `${baseName}.${ext}`);
    const result = await renderToFile({
      doc,
      format,
      outputPath,
      converterPath: config.pdf.converter,
      log,
    });
    const relativeFile = path.relative(deps.workspaceRoot(), result.path).replace(/\\/g, '/');
    sendJson(res, 200, {
      ok: true,
      file: { rel: relativeFile, path: result.path, bytes: result.bytes, mime: result.mime, name: path.basename(result.path) },
      ...(result.note ? { note: result.note } : {}),
      ...(result.degraded ? { degraded: true } : {}),
    });
  });

  // ── GET /items ────────────────────────────────────────────────────────────
  route('/items', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    sendJson(res, 200, { ok: true, items: await deps.listItems() });
  });

  // ── GET /item?rel= ────────────────────────────────────────────────────────
  route('/item', async (req, res, url) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    const relative = url.searchParams.get('rel') || '';
    if (!relative) return sendJson(res, 400, { ok: false, error: '缺少 rel' });
    const item = await deps.readItem(relative);
    sendJson(res, 200, { ok: true, markdown: item.markdown, meta: item.meta });
  });

  // ── GET /file?rel= ────────────────────────────────────────────────────────
  route('/file', async (req, res, url) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    const relative = url.searchParams.get('rel') || '';
    const root = deps.workspaceRoot();
    const absolute = safeJoin(root, relative);
    if (!absolute) return sendJson(res, 400, { ok: false, error: '路径不合法' });
    let info;
    try {
      info = await stat(absolute);
    } catch {
      return sendJson(res, 404, { ok: false, error: '文件不存在' });
    }
    if (!info.isFile()) return sendJson(res, 404, { ok: false, error: '不是文件' });
    const ext = path.extname(absolute).slice(1).toLowerCase();
    const buffer = await readFile(absolute);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buffer.length,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(absolute))}`,
      'Cache-Control': 'no-store',
    });
    res.end(buffer);
  });

  return {
    dispose() {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* 已随宿主撤销 */
        }
      }
      disposers.length = 0;
    },
  };
}

/** 供 index.js 用的路径常量。 */
export { PREFIX as API_PREFIX };

// deps 契约（由 lib/index.js 提供）：
//   getConfig() -> config
//   applySettings(patch) -> {config} | {issues}
//   collect({urls}) -> Promise<ItemResult[]>
//   listItems() -> Promise<object[]>
//   readItem(rel) -> Promise<{markdown, meta}>
//   itemDir(rel) -> string|null
//   workspaceRoot() -> string
//   workspace() -> Promise<{root, outputRoot, exists}>
//   parseUrls(input) -> string[]
//   capabilities() -> Promise<object>
//   version -> string
