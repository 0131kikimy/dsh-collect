/**
 * 文件生成引擎总入口。
 *
 * 对外只暴露三样东西（见 CONTRACT.md §4）：
 *   FORMATS            支持的格式列表
 *   render()           按格式把 Doc 模型渲染成字节
 *   PdfUnavailableError PDF 不可用时抛出的错误类型
 *
 * 所有生成器都是纯函数：不读环境、不联网，图片字节由调用方通过 opts.readImage 注入。
 */

import { renderDocx } from './docx.js';
import { renderXlsx } from './xlsx.js';
import { renderPptx } from './pptx.js';
import { renderMarkdown, renderHtml, renderPlainText, renderCsv, renderJson } from './text.js';
import { renderPdf, detectConverter, PdfUnavailableError } from './pdf.js';

export { PdfUnavailableError, detectConverter };

/**
 * @typedef {Object} Doc
 * @property {string} [title]        文档标题
 * @property {string} [subtitle]     副标题（来源、日期等）
 * @property {string} [sourceUrl]    来源网址
 * @property {string} [collectedAt]  ISO 时间字符串
 * @property {Block[]} blocks        正文块，按顺序
 */

/**
 * @typedef {(
 *   { type: 'heading',  level: 1|2|3, text: string } |
 *   { type: 'paragraph', text: string } |
 *   { type: 'quote',    text: string } |
 *   { type: 'bullets',  items: string[] } |
 *   { type: 'numbered', items: string[] } |
 *   { type: 'code',     text: string, lang?: string } |
 *   { type: 'table',    headers: string[], rows: string[][] } |
 *   { type: 'image',    src: string, alt?: string, caption?: string } |
 *   { type: 'pagebreak' }
 * )} Block
 */

/**
 * @typedef {Object} RenderOptions
 * @property {(src: string) => Promise<{buffer: Uint8Array, mime: string, width: number, height: number} | null>} [readImage]
 *   读取图片；返回 null 表示跳过该图（不能抛错拖垮整体生成）。
 * @property {{ kind: 'node-cli', node: string, cli: string } |
 *            { kind: 'soffice', bin: string } | null} [converter]
 *   PDF 转换器；缺省时由 pdf.js 按环境自动检测。
 * @property {(message: string) => void} [log]
 */

/** 支持的格式（与 CONTRACT.md §4 完全一致）。 */
export const FORMATS = ['md', 'html', 'txt', 'csv', 'json', 'docx', 'xlsx', 'pptx', 'pdf'];

/** 每种格式的 MIME 与扩展名。 */
const FORMAT_META = {
  md: { mime: 'text/markdown; charset=utf-8', ext: 'md' },
  html: { mime: 'text/html; charset=utf-8', ext: 'html' },
  txt: { mime: 'text/plain; charset=utf-8', ext: 'txt' },
  csv: { mime: 'text/csv; charset=utf-8', ext: 'csv' },
  json: { mime: 'application/json; charset=utf-8', ext: 'json' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
  pdf: { mime: 'application/pdf', ext: 'pdf' },
};

/**
 * 把调用方给的 Doc 规范化，避免生成器里到处判空。
 * @param {unknown} value
 * @returns {Doc}
 */
function normalizeDoc(value) {
  const source = value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
  const text = (input) => (typeof input === 'string' ? input : '');
  return {
    title: text(source.title),
    subtitle: text(source.subtitle),
    sourceUrl: text(source.sourceUrl),
    collectedAt: text(source.collectedAt),
    blocks: Array.isArray(source.blocks) ? source.blocks.filter((block) => block && typeof block === 'object') : [],
  };
}

/**
 * 把字符串编码成 UTF-8 字节。
 * @param {string} text
 * @returns {Uint8Array}
 */
function toBytes(text) {
  return new TextEncoder().encode(text);
}

/**
 * 把 Doc 模型渲染成指定格式的文件字节。
 *
 * @param {string} format FORMATS 之一（大小写不敏感，统一按小写处理）
 * @param {Doc} doc 文档中间表示
 * @param {RenderOptions} [opts]
 * @returns {Promise<{ data: Uint8Array, mime: string, ext: string, note?: string }>}
 * @throws {Error} 未知格式
 * @throws {PdfUnavailableError} PDF 不可用或无转换器时
 */
export async function render(format, doc, opts = {}) {
  const key = typeof format === 'string' ? format.trim().toLowerCase() : '';
  const meta = FORMAT_META[key];
  if (!meta) throw new Error('unknown format: ' + String(format));

  const normalized = normalizeDoc(doc);
  const options = {
    readImage: typeof opts.readImage === 'function' ? opts.readImage : async () => null,
    converter: opts.converter ?? null,
    log: typeof opts.log === 'function' ? opts.log : () => {},
  };

  switch (key) {
    case 'md':
      return { data: toBytes(renderMarkdown(normalized)), mime: meta.mime, ext: meta.ext };
    case 'html':
      return { data: toBytes(renderHtml(normalized)), mime: meta.mime, ext: meta.ext };
    case 'txt':
      return { data: toBytes(renderPlainText(normalized)), mime: meta.mime, ext: meta.ext };
    case 'csv':
      return {
        data: toBytes(renderCsv(normalized)),
        mime: meta.mime,
        ext: meta.ext,
        note: '已添加 UTF-8 BOM，Excel 直接打开中文不乱码',
      };
    case 'json':
      return { data: toBytes(renderJson(normalized)), mime: meta.mime, ext: meta.ext };
    case 'docx':
      return { data: await renderDocx(normalized, options), mime: meta.mime, ext: meta.ext };
    case 'xlsx':
      return { data: await renderXlsx(normalized, options), mime: meta.mime, ext: meta.ext };
    case 'pptx':
      return { data: await renderPptx(normalized, options), mime: meta.mime, ext: meta.ext };
    case 'pdf':
      return await renderPdf(normalized, options);
    default:
      // FORMATS 与 FORMAT_META 一一对应，理论上不可达；保留兜底避免静默返回空数据。
      throw new Error('unknown format: ' + String(format));
  }
}
