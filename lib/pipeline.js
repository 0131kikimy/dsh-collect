// dsh-collect · 采集编排
//
// 一条 URL 的处理顺序（可被配置关掉，但至少保留一路）：
//   1) 宿主已接入的联网服务（nativeWeb）：ctx.web.fetch —— 不启浏览器、不动鼠标，优先。
//   2) 插件直连（directHttp）：自己发 HTTP 请求 + 本地解析 HTML。
//   3) 都没有 → 结合面板开关给出可执行的下一步提示（浏览器标签页 / 桌面操控 / MCP）。
//
// 落盘交给采集引擎的 save.js；本文件只负责「拿到 HTML → 变成文章 → 存进去」。

import { readdir, readFile, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';

import { fetchUrl, fetchBinary } from './http.js';
import { extractArticle, isWeChatUrl, looksBlocked } from './extract.js';
import { saveArticle } from './save.js';
import { detectPdfConverter } from './export.js';

/** 单张图片的字节上限（防止一条页面把磁盘写满）。 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
/** 图片请求超时。 */
const IMAGE_TIMEOUT_MS = 15000;
/** 列表页最多返回多少条历史。 */
const MAX_LISTED_ITEMS = 40;

/**
 * 取本次会话的工作目录。
 *
 * 解析顺序（面板没有 Session 绑定，所以只能从这些来源里挑）：
 *   1. 宿主的工作区登记表里最近的、路径存在的工作区（用户真正在用的目录）；
 *   2. `workingDirectory.defaultDirectory`；
 *   3. 进程当前目录。
 *
 * @param {object} ctx - Cordis 上下文。
 * @returns {string} 工作目录绝对路径。
 */
export function workspaceRoot(ctx) {
  // 1) 工作区登记表：优先用户正在用的工作区，而不是 profile 目录
  try {
    const registry = ctx?.get?.('workspaceRegistry');
    const list = typeof registry?.list === 'function' ? registry.list() : undefined;
    if (Array.isArray(list)) {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const candidate = list[index];
        const dir = typeof candidate?.path === 'string' ? candidate.path : '';
        if (!dir) continue;
        try {
          if (statSync(dir).isDirectory()) return dir;
        } catch {
          continue;
        }
      }
    }
  } catch {
    /* 工作区登记表不可用就退化到下一层 */
  }

  // 2) 宿主的工作目录服务
  const service = ctx?.get?.('workingDirectory') ?? ctx?.workingDirectory;
  const fromService = service?.defaultDirectory;
  if (typeof fromService === 'string' && fromService) return fromService;

  // 3) 当前进程目录
  return process.cwd();
}

/**
 * 取输出根目录：工作目录 / output.dir。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} config - 已规范化配置。
 * @returns {string} 输出根目录绝对路径。
 */
export function outputRoot(ctx, config) {
  return path.resolve(workspaceRoot(ctx), config.output.dir);
}

/**
 * 安全拼接：把相对路径限制在 root 之内。
 * @param {string} root - 根目录绝对路径。
 * @param {string} relative - 用户/面板给的相对路径。
 * @returns {string|null} 合法绝对路径；越界返回 null。
 */
export function safeJoin(root, relative) {
  if (typeof relative !== 'string' || relative.trim() === '') return null;
  const cleaned = relative.replace(/\\/g, '/').replace(/^\.\//, '');
  if (cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) return null;
  if (cleaned.split('/').some((part) => part === '..')) return null;
  const resolved = path.resolve(root, cleaned);
  const normalizedRoot = path.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) return null;
  return resolved;
}

/**
 * 规范化用户输入的网址（补协议、去掉首尾空白）。
 * @param {string} raw - 原始输入。
 * @returns {string|null} 合法 http(s) 网址；非法返回 null。
 */
export function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * 把多行文本拆成网址数组（支持换行、逗号、中文逗号、空格分隔）。
 * @param {string|string[]} input - 原始输入。
 * @returns {string[]} 去重后的网址（已规范化，最多 20 个）。
 */
export function parseUrls(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[\s,，、;；]+/);
  const seen = new Set();
  const urls = [];
  for (const candidate of raw) {
    const url = normalizeUrl(candidate);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= 20) break;
  }
  return urls;
}

/**
 * 探测当前宿主真实可用的能力（面板用来显示「可用 / 未安装」）。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} config - 已规范化配置。
 * @returns {Promise<object>} capabilities。
 */
export async function probeCapabilities(ctx, config) {
  const tools = ctx?.get?.('tools') ?? ctx?.tools;
  let names = [];
  try {
    const definitions = tools?.definitions?.();
    if (Array.isArray(definitions)) names = definitions.map((item) => String(item?.name || ''));
  } catch {
    names = [];
  }
  const browserTools = names.filter((name) => /browser|tab/i.test(name) && /wincu|computer|browser/i.test(name));
  const computerTools = names.filter((name) => /computer[_ ]?use|windows_computer/i.test(name));
  const mcpTools = names.filter((name) => name.startsWith('mcp__'));

  const web = ctx?.get?.('web') ?? ctx?.web;
  let nativeWeb = Boolean(web && typeof web.fetch === 'function');
  if (nativeWeb && typeof web.fetchReady === 'function') {
    try {
      nativeWeb = await web.fetchReady();
    } catch {
      nativeWeb = false;
    }
  }

  const converter = detectPdfConverter(config.pdf.converter);
  return {
    nativeWeb,
    directHttp: true,
    browserTabs: {
      available: browserTools.length > 0,
      hint: browserTools.length > 0
        ? '已检测到浏览器标签页类工具；面板本身不驱动浏览器，采集由 AI 调用这些工具完成。'
        : '当前宿主没有浏览器标签页类工具；可在插件页安装后再打开本开关。',
    },
    computerUse: {
      available: computerTools.length > 0,
      hint: computerTools.length > 0
        ? '已检测到桌面操控类工具。开启后 AI 可以移动鼠标、敲键盘，请只在必要时使用。'
        : '当前宿主没有桌面操控类工具；开关保留，装好后自动生效。',
    },
    mcpTools: {
      available: mcpTools.length > 0,
      count: mcpTools.length,
      hint: mcpTools.length > 0 ? `已连接 ${mcpTools.length} 个 MCP 工具，可作为额外信息源。` : '当前没有连接 MCP 数据源。',
    },
    pdf: {
      available: Boolean(converter),
      reason: converter
        ? '已找到 PDF 转换引擎（LibreOffice）。'
        : '没有找到 LibreOffice 转换引擎：导出 PDF 时会自动降级为 Word 文档，用 Word / WPS 另存为 PDF 即可。',
    },
  };
}

/**
 * 采集一条网页并落盘。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} config - 已规范化配置。
 * @param {string} url - 已规范化的网址。
 * @param {object} options - 附加选项。
 * @param {(message: string) => void} [options.log] - 日志。
 * @returns {Promise<object>} ItemResult。
 */
async function collectOne(ctx, config, url, options) {
  const log = typeof options?.log === 'function' ? options.log : () => {};
  const rootDir = outputRoot(ctx, config);
  let html = '';
  let finalUrl = url;
  let method = '';
  const errors = [];

  const wechat = isWeChatUrl(url);

  /** 走宿主联网服务（不启浏览器、不动鼠标）。 */
  const tryNative = async () => {
    const web = ctx?.get?.('web') ?? ctx?.web;
    if (!web || typeof web.fetch !== 'function') {
      errors.push('宿主没有可用的联网服务');
      return;
    }
    try {
      const result = await web.fetch({ url });
      if (result && result.statusCode >= 200 && result.statusCode < 400 && result.body?.content) {
        html = String(result.body.content);
        finalUrl = result.url || url;
        method = 'native-web';
      } else {
        errors.push(`宿主联网服务返回 HTTP ${result?.statusCode ?? '未知'}`);
      }
    } catch (error) {
      errors.push(`宿主联网服务失败：${error?.message ?? error}`);
    }
  };

  /** 插件自己直连；微信带 Referer，被拦时换微信内置浏览器 UA 再试一次。 */
  const tryDirect = async () => {
    const headers = wechat ? { Referer: 'https://mp.weixin.qq.com/', 'Accept-Language': 'zh-CN,zh;q=0.9' } : undefined;
    const wechatUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.47(0x18002f2e) NetType/WIFI Language/zh_CN';
    const attempts = wechat ? [undefined, wechatUA] : [undefined];
    for (let attempt = 0; attempt < attempts.length; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1200));
      const response = await fetchUrl(url, {
        timeoutMs: config.output.timeoutMs,
        maxBytes: config.output.maxBytes,
        ...(headers ? { headers } : {}),
        ...(attempts[attempt] ? { userAgent: attempts[attempt] } : {}),
      });
      if (!response.ok || !response.body || response.body.length === 0) {
        errors.push(response.error ? `直连抓取失败：${response.error}` : `直连抓取失败：HTTP ${response.status}`);
        return;
      }
      const candidate = typeof response.text === 'string' && response.text ? response.text : response.body.toString('utf8');
      // 微信被拦时 HTTP 同样是 200，只能看内容是不是验证页
      if (wechat && looksBlocked(candidate, '')) {
        errors.push(attempt === 0 ? '微信返回了「环境异常」验证页' : '换微信 UA 重试仍被拦');
        continue;
      }
      html = candidate;
      finalUrl = response.finalUrl || url;
      method = 'direct-http';
      return;
    }
  };

  // 微信优先直连（宿主联网通道更容易被微信拦），其余站点优先宿主联网。
  if (wechat) {
    if (config.acquisition.directHttp) await tryDirect();
    if (!html && config.acquisition.nativeWeb) await tryNative();
  } else {
    if (config.acquisition.nativeWeb) await tryNative();
    if (!html && config.acquisition.directHttp) await tryDirect();
  }

  // 宿主联网拿到验证页时丢弃，绝不把它当成文章存下来
  if (html && looksBlocked(html, '')) {
    errors.push('拿到的页面是反爬验证页，已丢弃');
    html = '';
    method = '';
  }

  if (!html) {
    const hints = [];
    if (wechat) hints.push('微信对同一 IP 有频率限制：等 1~2 分钟再试，或一次少采几篇。');
    if (config.acquisition.browserTabs) hints.push('「浏览器标签页」已开启：可以让 AI 用浏览器工具打开该页再采集。');
    if (config.acquisition.computerUse) hints.push('「桌面操控」已开启：可以让 AI 直接操作浏览器窗口。');
    if (config.acquisition.mcpTools) hints.push('「MCP 工具」已开启：可以让 AI 用其他数据源插件取内容。');
    if (hints.length === 0) hints.push('请在左侧栏「采文」面板打开「原生联网」或「直连抓取」。');
    return {
      ok: false,
      url,
      error: [...new Set(errors)].join('；') + '。' + hints.join(' '),
    };
  }

  const article = extractArticle(html, finalUrl);
  if (article.blocked) {
    return {
      ok: false,
      url,
      error: wechat
        ? '微信反爬拦截：页面是「环境异常」验证页，没有正文。等 1~2 分钟再试；长期被拦时可在面板打开「浏览器标签页」或「桌面操控」，让 AI 用真实浏览器打开再采集。'
        : `目标站点返回了反爬验证页：${article.blockedReason || '没有拿到正文'}。可稍后重试，或在面板打开「浏览器标签页 / 桌面操控」。`,
    };
  }
  const title = article.title || new URL(finalUrl).hostname;
  const collectedAt = new Date().toISOString();

  /** 图片下载器：交给 save.js 逐张调用，失败返回 null（跳过该图）。 */
  const fetchImage = async (imageUrl) => {
    const headers = {};
    try {
      const host = new URL(imageUrl).hostname.toLowerCase();
      // 微信图片有防盗链：不带 mp.weixin.qq.com 的 Referer 会 403
      if (/(^|\.)mmbiz\.qpic\.cn$|(^|\.)mmbiz\.qlogo\.cn$|(^|\.)mp\.weixin\.qq\.com$/.test(host)) {
        headers.Referer = 'https://mp.weixin.qq.com/';
      }
    } catch {
      /* 非法图片地址交给下面的 fetch 环节报错 */
    }
    try {
      const response = await fetchBinary(imageUrl, {
        timeoutMs: Math.min(config.output.timeoutMs, IMAGE_TIMEOUT_MS),
        maxBytes: MAX_IMAGE_BYTES,
        ...(Object.keys(headers).length ? { headers } : {}),
      });
      if (!response.ok || !response.body || response.body.length === 0) return null;
      return { buffer: response.body, mime: response.contentType || 'application/octet-stream' };
    } catch {
      return null;
    }
  };

  const images = config.output.saveImages ? article.images.slice(0, config.output.imageLimit) : [];
  const saved = await saveArticle(
    {
      url: finalUrl,
      title,
      siteName: article.siteName || '',
      markdown: article.markdown || article.text || '',
      text: article.text || '',
      images,
      collectedAt,
      method,
    },
    { rootDir, fetchImage, log },
  );

  const relativeDir = path.relative(workspaceRoot(ctx), saved.dir).replace(/\\/g, '/');
  return {
    ok: true,
    url: finalUrl,
    title,
    slug: path.basename(saved.dir),
    chars: (article.text || '').length,
    images: saved.imagesSaved,
    dir: saved.dir,
    rel: relativeDir,
    method,
  };
}

/**
 * 批量采集。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} config - 已规范化配置。
 * @param {string[]} urls - 网址列表（应先经 parseUrls 规范化）。
 * @param {object} [options] - 选项。
 * @param {(message: string) => void} [options.log] - 日志。
 * @param {(done: number, total: number, url: string) => void} [options.onProgress] - 进度回调。
 * @returns {Promise<object[]>} ItemResult 列表。
 */
export async function collectUrls(ctx, config, urls, options = {}) {
  const results = [];
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    try {
      options.onProgress?.(index, urls.length, url);
      const item = await collectOne(ctx, config, url, options);
      results.push(item);
    } catch (error) {
      results.push({ ok: false, url, error: `采集异常：${error?.message ?? error}` });
    }
  }
  return results;
}

/**
 * 列出历史采集结果（按修改时间倒序）。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} config - 已规范化配置。
 * @returns {Promise<object[]>} 历史条目。
 */
export async function listItems(ctx, config) {
  const rootDir = outputRoot(ctx, config);
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(rootDir, entry.name);
    try {
      const metaRaw = await readFile(path.join(dir, 'meta.json'), 'utf8');
      const meta = JSON.parse(metaRaw);
      const info = await stat(dir);
      items.push({
        slug: entry.name,
        rel: path.relative(workspaceRoot(ctx), dir).replace(/\\/g, '/'),
        title: typeof meta.title === 'string' ? meta.title : entry.name,
        url: typeof meta.url === 'string' ? meta.url : '',
        method: typeof meta.method === 'string' ? meta.method : '',
        chars: Number(meta.chars) || 0,
        images: Number(meta.imagesSaved ?? meta.images) || 0,
        collectedAt: typeof meta.collectedAt === 'string' ? meta.collectedAt : (typeof meta.collected_at === 'string' ? meta.collected_at : ''),
        mtimeMs: info.mtimeMs,
      });
    } catch {
      // 不是本插件写的目录：忽略
    }
  }
  items.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return items.slice(0, MAX_LISTED_ITEMS);
}

/**
 * 读取一条采集结果的正文与元信息。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} config - 已规范化配置。
 * @param {string} relative - 相对工作目录的目录路径。
 * @returns {Promise<{rel:string, markdown:string, meta:object}>} 正文与元信息。
 */
export async function readItem(ctx, config, relative) {
  const rootDir = outputRoot(ctx, config);
  const dir = safeJoin(path.dirname(rootDir), relative);
  if (!dir) throw new Error('路径不合法');
  const absolute = path.resolve(dir);
  const rootAbsolute = path.resolve(rootDir);
  if (absolute !== rootAbsolute && !absolute.startsWith(rootAbsolute + path.sep)) throw new Error('路径不在输出目录内');
  const markdown = await readFile(path.join(absolute, 'index.md'), 'utf8');
  let meta = {};
  try {
    meta = JSON.parse(await readFile(path.join(absolute, 'meta.json'), 'utf8'));
  } catch {
    meta = {};
  }
  return {
    rel: path.relative(workspaceRoot(ctx), absolute).replace(/\\/g, '/'),
    markdown,
    meta,
  };
}
