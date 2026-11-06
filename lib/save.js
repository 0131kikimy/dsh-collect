// dsh-collect · 采集结果落盘
//
// 契约见 CONTRACT.md §5.4：saveArticle / slugify / uniqueDir。
// 落盘结构：rootDir/<slug>/index.md（带 YAML front matter）+ meta.json + 图片/NNN.ext。
// 文件命名对 Windows 友好（非法字符、保留名、长度、末尾点号都处理过）。

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sniffImage, guessImageExt, mimeByExt } from './img.js';

const MAX_SLUG_LENGTH = 48;
const IMAGE_DIR_NAME = '图片';
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

/**
 * 生成安全目录名：去非法字符、折空白、限长 48 字符、避开 Windows 保留名。
 * @param {string} title
 * @param {string} [url] 标题为空时用 URL 末段/域名兜底
 * @returns {string}
 */
export function slugify(title, url) {
  let base = String(title === undefined || title === null ? '' : title).trim();
  if (!base && url) {
    try {
      const parsed = new URL(String(url));
      const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
      base = last || parsed.hostname || '';
    } catch { base = ''; }
  }
  let slug = base
    .normalize('NFC')
    .replace(ILLEGAL_CHARS, ' ')
    .replace(/[\s\u00a0]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._\s]+/, '')
    .replace(/[-._\s]+$/, '');
  if (!slug) slug = 'article';
  const chars = Array.from(slug);
  if (chars.length > MAX_SLUG_LENGTH) {
    slug = chars.slice(0, MAX_SLUG_LENGTH).join('').replace(/[-._\s]+$/, '');
    if (!slug) slug = 'article';
  }
  if (RESERVED_NAME.test(slug)) slug = `_${slug}`;
  return slug;
}

/**
 * 返回 rootDir 下不与现有目录冲突的目录名（冲突时追加 -2 / -3 …）。
 * 只返回目录名，不含 rootDir，调用方用 path.join(rootDir, 返回值) 拼完整路径。
 * @param {string} rootDir
 * @param {string} slug
 * @returns {string}
 */
export function uniqueDir(rootDir, slug) {
  const root = String(rootDir || '');
  const base = slugify(String(slug || 'article'));
  for (let index = 1; index <= 999; index += 1) {
    const name = index === 1 ? base : `${base}-${index}`;
    if (!existsSync(path.join(root, name))) return name;
  }
  throw new Error('目标目录冲突过多（已尝试 999 个名字），请检查输出目录');
}

/** YAML 标量：用 JSON 双引号形式，转义规则与 YAML 双引号兼容。 */
function yamlString(value) {
  return JSON.stringify(String(value === undefined || value === null ? '' : value));
}

/** 图片地址归一：用于 Markdown 里的 URL 与原图 URL 对齐（忽略编码差异与 #hash）。 */
function urlKey(raw) {
  let value = String(raw || '').trim();
  try { value = decodeURIComponent(value); } catch { /* 保留原样 */ }
  return value.replace(/#.*$/, '');
}

/**
 * 把 Markdown 里的远程图片地址替换成本地相对引用。
 * @param {string} markdown
 * @param {Map<string,string>} replaceMap 原图 URL → ./图片/NNN.ext
 * @returns {string}
 */
function replaceImageUrls(markdown, replaceMap) {
  if (!replaceMap.size) return String(markdown || '');
  const byKey = new Map();
  for (const [url, local] of replaceMap) {
    byKey.set(url, local);
    byKey.set(urlKey(url), local);
  }
  const lookup = (raw) => byKey.get(raw) || byKey.get(urlKey(raw)) || '';
  let out = String(markdown || '').replace(
    /!\[([^\]]*)\]\(\s*<?([^)>\s]+)>?(?:\s+["'][^"']*["'])?\s*\)/g,
    (whole, alt, src) => {
      const local = lookup(src);
      return local ? `![${alt}](${local})` : whole;
    },
  );
  out = out.replace(/(<img\b[^>]*\bsrc\s*=\s*)(["'])([^"']+)\2/gi, (whole, prefix, quote, src) => {
    const local = lookup(src);
    return local ? `${prefix}${quote}${local}${quote}` : whole;
  });
  return out;
}

/**
 * 判断 Markdown 是否已经被调用方替换成本地图片引用。
 * @param {string} markdown
 * @returns {boolean}
 */
function hasLocalImageRefs(markdown) {
  return markdown.includes(`./${IMAGE_DIR_NAME}/`) || markdown.includes(`${IMAGE_DIR_NAME}/`);
}

/**
 * 把一条采集结果落盘到 rootDir/<slug>/。
 * @param {SaveItem} item
 * @param {{rootDir: string, fetchImage?: (url: string) => Promise<{buffer: Buffer, mime?: string}|null>,
 *          log?: (message: string) => void}} options
 * @returns {Promise<{dir:string, markdownPath:string, metaPath:string,
 *   imagesSaved:number, imageFiles:string[], bytes:number}>}
 */
export async function saveArticle(item, options = {}) {
  const rootDir = String(options.rootDir || '').trim();
  if (!rootDir) throw new Error('saveArticle 需要 options.rootDir');
  const log = typeof options.log === 'function' ? options.log : () => {};
  const source = item && typeof item === 'object' ? item : {};
  const url = String(source.url || '').trim();
  const title = String(source.title || '').trim() || '未命名文章';
  const siteName = String(source.siteName || '').trim();
  const collectedAt = String(source.collectedAt || new Date().toISOString());
  const method = String(source.method || '');
  const body = String(source.markdown || source.text || '').trim();
  const images = Array.isArray(source.images) ? source.images : [];

  await mkdir(rootDir, { recursive: true });
  const dirName = uniqueDir(rootDir, slugify(title, url));
  const dir = path.join(rootDir, dirName);
  await mkdir(dir, { recursive: true });

  const imageDir = path.join(dir, IMAGE_DIR_NAME);
  const imageFiles = [];
  const imageMeta = [];
  const replaceMap = new Map();
  let imageBytes = 0;

  if (typeof options.fetchImage === 'function') {
    for (let index = 0; index < images.length; index += 1) {
      const entry = images[index];
      const imageUrl = String((entry && entry.url) || '').trim();
      if (!imageUrl || replaceMap.has(imageUrl)) continue;
      let fetched;
      try {
        fetched = await options.fetchImage(imageUrl);
      } catch (err) {
        log(`下载图片失败：${imageUrl}（${(err && err.message) || err}）`);
        continue;
      }
      if (!fetched || !fetched.buffer) continue;
      const buffer = Buffer.isBuffer(fetched.buffer) ? fetched.buffer : Buffer.from(fetched.buffer);
      if (buffer.length === 0) continue;
      const sniffed = sniffImage(buffer);
      const declaredMime = String(fetched.mime || '').toLowerCase();
      const isSvg = declaredMime.includes('svg');
      if (!sniffed && !declaredMime.startsWith('image/') && !isSvg) {
        log(`跳过非图片响应：${imageUrl}（${declaredMime || '未知类型'}）`);
        continue;
      }
      const ext = sniffed ? sniffed.ext : isSvg ? 'svg' : guessImageExt(imageUrl, declaredMime);
      const fileName = `${String(index + 1).padStart(3, '0')}.${ext}`;
      await mkdir(imageDir, { recursive: true });
      const filePath = path.join(imageDir, fileName);
      await writeFile(filePath, buffer);
      imageBytes += buffer.length;
      imageFiles.push(filePath);
      replaceMap.set(imageUrl, `./${IMAGE_DIR_NAME}/${fileName}`);
      imageMeta.push({
        url: imageUrl,
        alt: String((entry && entry.alt) || ''),
        file: `./${IMAGE_DIR_NAME}/${fileName}`,
        mime: sniffed ? sniffed.mime : isSvg ? 'image/svg+xml' : mimeByExt(ext),
        bytes: buffer.length,
        width: sniffed ? sniffed.width : 0,
        height: sniffed ? sniffed.height : 0,
      });
    }
  }

  let markdown = body;
  if (markdown && !hasLocalImageRefs(markdown)) markdown = replaceImageUrls(markdown, replaceMap);
  const frontMatter = [
    '---',
    `title: ${yamlString(title)}`,
    `url: ${yamlString(url)}`,
    `source: ${yamlString(siteName)}`,
    `collected_at: ${yamlString(collectedAt)}`,
    '---',
    '',
  ].join('\n');
  const markdownText = `${frontMatter}${markdown ? `${markdown}\n` : ''}`;
  const markdownPath = path.join(dir, 'index.md');
  await writeFile(markdownPath, markdownText, 'utf8');

  const meta = {
    url,
    title,
    siteName,
    method,
    collectedAt,
    chars: Array.from(body).length,
    imagesSaved: imageFiles.length,
    images: imageMeta,
    text: String(source.text || ''),
    markdownPath: 'index.md',
    files: imageFiles.map((file) => path.relative(dir, file)),
  };
  const metaPath = path.join(dir, 'meta.json');
  const metaJson = `${JSON.stringify(meta, null, 2)}\n`;
  await writeFile(metaPath, metaJson, 'utf8');

  return {
    dir,
    markdownPath,
    metaPath,
    imagesSaved: imageFiles.length,
    imageFiles,
    bytes: Buffer.byteLength(markdownText, 'utf8') + Buffer.byteLength(metaJson, 'utf8') + imageBytes,
  };
}

/**
 * @typedef {Object} SaveItem
 * @property {string} url
 * @property {string} title
 * @property {string} siteName
 * @property {string} markdown
 * @property {string} text
 * @property {{url:string, alt:string}[]} images
 * @property {string} collectedAt ISO 时间字符串
 * @property {string} method 'native-web' | 'direct-http'
 */
