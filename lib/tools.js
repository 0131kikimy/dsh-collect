// dsh-collect · 给 Agent 的三个工具
//
// 面板和 AI 走同一套底层（pipeline.js / export.js），这里只做参数整理与结果裁剪。
// 工具返回值必须是「无损 JSON」：undefined / 函数 / NaN 会让整次调用失败，所以统一 prune。

import path from 'node:path';
import { stat } from 'node:fs/promises';

import { FORMATS } from './config.js';
import { markdownToDoc, renderToFile } from './export.js';
import { outputRoot, parseUrls, safeJoin, workspaceRoot } from './pipeline.js';

/**
 * 去掉 undefined / 函数 / 非有限数字，保证返回值为无损 JSON。
 * @param {unknown} value - 任意返回值。
 * @returns {unknown} 可安全序列化的同构值。
 */
function prune(value) {
  if (Array.isArray(value)) return value.map(prune);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === 'function') continue;
      if (typeof item === 'number' && !Number.isFinite(item)) continue;
      out[key] = prune(item);
    }
    return out;
  }
  return value;
}

/** 文本块 helper。 */
function textBlock(text) {
  return [{ type: 'text', text }];
}

/**
 * 把采集结果裁剪成工具返回值（不塞整篇正文，正文在文件里）。
 * @param {object[]} items - ItemResult 列表。
 * @returns {object[]} 裁剪后的列表。
 */
function trimItems(items) {
  return items.map((item) => ({
    ok: item.ok === true,
    title: item.title,
    url: item.url,
    slug: item.slug,
    chars: item.chars,
    images: item.images,
    rel: item.rel,
    method: item.method,
    error: item.error,
  }));
}

/**
 * 安装三个工具。
 * @param {object} options - 依赖。
 * @param {object} options.ctx - Cordis 上下文。
 * @param {() => object} options.getConfig - 取当前生效配置。
 * @param {(patch: object) => object} options.applySettings - 保存设置（返回 {config} 或 {issues}）。
 * @param {(input: {urls: string[]}) => Promise<object[]>} options.collect - 批量采集。
 * @param {(rel: string) => Promise<object>} options.readItem - 读一条采集结果。
 * @param {(rel: string) => string|null} options.itemDir - 采集结果目录的绝对路径。
 * @param {(rel: string) => Promise<object[]>} [options.listItems] - 历史列表。
 * @param {string} options.version - 插件版本。
 * @param {(message: string) => void} [options.log] - 日志。
 * @returns {string[]} 已注册的工具名。
 */
export function installTools(options) {
  const { ctx, getConfig, applySettings, collect, readItem, itemDir } = options;
  const tools = ctx?.get?.('tools') ?? ctx?.tools;
  if (!tools?.register) {
    ctx?.logger?.warn?.('dsh-collect: 当前宿主没有 tools 服务，工具未注册（面板不受影响）');
    return [];
  }

  const names = [];

  /**
   * 注册一个工具（先 prune 再交给宿主）。
   * @param {object} definition - 工具定义。
   * @returns {void}
   */
  const register = (definition) => {
    const wrapped = {
      ...definition,
      execute: async (args, exec) => prune(await definition.execute(args, exec)),
    };
    tools.register(wrapped);
    names.push(definition.name);
  };

  // ── 1. 采集 ───────────────────────────────────────────────────────────────
  register({
    name: 'collect_fetch',
    description:
      '采集网页：把网址的正文、标题和图片抓下来，存到当前工作目录的「采文输出」文件夹里，返回每条结果的标题、字数、图片数和保存位置。'
      + '默认走宿主内置联网，不启动浏览器、不移动鼠标。用户要「取网页内容 / 存资料」时先用它。'
      + '需要给用户看成品文件时，拿 rel 再调 collect_export。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        urls: {
          type: 'string',
          description: '一个或多个网址：多行、逗号、空格分隔都可以；不带协议时自动补 https://。',
        },
        saveImages: { type: 'boolean', description: '是否下载图片，默认跟随面板设置。' },
      },
      required: ['urls'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'number' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                ok: { type: 'boolean' },
                title: { type: 'string' },
                url: { type: 'string' },
                slug: { type: 'string' },
                chars: { type: 'number' },
                images: { type: 'number' },
                rel: { type: 'string' },
                method: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value || value.ok !== true) return textBlock(`采集失败：${value?.error || '未知原因'}`);
        const lines = [`采集完成：成功 ${value.items.filter((item) => item.ok).length} / ${value.count} 条`];
        for (const item of value.items) {
          if (item.ok) {
            lines.push(`· ${item.title}（${item.chars} 字，${item.images} 图，${item.method}）→ ${item.rel}`);
          } else {
            lines.push(`· 失败：${item.url} —— ${item.error}`);
          }
        }
        return textBlock(lines.join('\n'));
      },
    },
    async execute(args) {
      const config = getConfig();
      const urls = parseUrls(args?.urls);
      if (urls.length === 0) return { ok: false, error: '没有识别到合法网址（需要 http:// 或 https://）', count: 0, items: [] };
      if (typeof args?.saveImages === 'boolean') {
        config.output = { ...config.output, saveImages: args.saveImages };
      }
      const items = await collect({ urls, config });
      return { ok: true, count: items.length, items: trimItems(items) };
    },
  });

  // ── 2. 生成文件 ───────────────────────────────────────────────────────────
  register({
    name: 'collect_export',
    description:
      '把采集到的内容或一段 Markdown 生成为指定格式的文件：docx / xlsx / pptx / pdf / md / html / txt / csv / json。'
      + 'source 可以填 collect_fetch 返回的 rel（推荐），也可以直接填 Markdown 正文。'
      + 'PDF 需要本机有 LibreOffice 转换引擎；没有时会自动改成 docx 并在 note 里说明。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', description: '采集结果目录（collect_fetch 返回的 rel）或一段 Markdown 正文。' },
        format: { type: 'string', enum: FORMATS, description: '目标格式。' },
        title: { type: 'string', description: '可选：文档标题，默认用采集结果的标题。' },
        path: { type: 'string', description: '可选：输出路径（相对工作目录）。默认写在采集结果目录里。' },
      },
      required: ['source', 'format'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          file: {
            type: 'object',
            additionalProperties: true,
            properties: {
              path: { type: 'string' },
              name: { type: 'string' },
              bytes: { type: 'number' },
              mime: { type: 'string' },
            },
          },
          note: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value || value.ok !== true) return textBlock(`生成失败：${value?.error || '未知原因'}`);
        const size = value.file?.bytes ? `${Math.round(value.file.bytes / 1024)} KB` : '未知大小';
        const lines = [`已生成：${value.file?.path}（${size}）`];
        if (value.note) lines.push(value.note);
        return textBlock(lines.join('\n'));
      },
    },
    async execute(args) {
      const config = getConfig();
      const format = String(args?.format || '').toLowerCase();
      if (!FORMATS.includes(format)) return { ok: false, error: `不支持的格式：${format || '（空）'}` };
      const source = String(args?.source || '').trim();
      if (!source) return { ok: false, error: '缺少 source' };

      const root = workspaceRoot(ctx);
      const outRoot = outputRoot(ctx, config);

      /** 采集结果目录：source 是相对路径且目录存在。 */
      let baseDir = outRoot;
      let markdown = source;
      let fallbackTitle = '采文文档';
      let meta = {};
      const maybeDir = itemDir(source);
      if (maybeDir && /[\\/]/.test(source)) {
        let isDir = false;
        try {
          isDir = (await stat(maybeDir)).isDirectory();
        } catch {
          isDir = false;
        }
        if (isDir) {
          const item = await readItem(source);
          markdown = item.markdown;
          meta = item.meta || {};
          baseDir = maybeDir;
          fallbackTitle = meta.title || fallbackTitle;
        }
      }

      const doc = markdownToDoc({
        markdown,
        title: args?.title || fallbackTitle,
        subtitle: meta.url ? `来源：${meta.url}` : '',
        sourceUrl: meta.url || '',
        collectedAt: meta.collectedAt || meta.collected_at || '',
        baseDir,
      });

      const targetRelative = String(args?.path || '').trim();
      let outputPath;
      if (targetRelative) {
        const absolute = safeJoin(root, targetRelative);
        if (!absolute) return { ok: false, error: 'path 不合法（必须是工作目录内的相对路径）' };
        outputPath = absolute;
      } else {
        const safeName = String(doc.title || '采文文档')
          .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60) || '采文文档';
        outputPath = path.join(baseDir, `${safeName}.${format}`);
      }

      const result = await renderToFile({
        doc,
        format,
        outputPath,
        converterPath: config.pdf.converter,
        log: options.log,
      });
      return {
        ok: true,
        file: {
          path: result.path,
          name: path.basename(result.path),
          bytes: result.bytes,
          mime: result.mime,
        },
        ...(result.note ? { note: result.note } : {}),
      };
    },
  });

  // ── 3. 设置 ───────────────────────────────────────────────────────────────
  register({
    name: 'collect_settings',
    description:
      '读取或修改采文插件的设置（信息获取方式开关、输出目录、图片上限、PDF 转换器等）。'
      + '用户说「不要用桌面操控 / 允许用浏览器 / 换个输出目录」时用它。'
      + 'action=get 只读；action=set 需要 patch（对象，只写要改的字段）；action=list 列出历史采集结果。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'list'], description: 'get 读设置，set 改设置，list 列历史。' },
        patch: {
          type: 'object',
          description: 'action=set 时要改的字段，如 { "acquisition": { "computerUse": true } }。',
          additionalProperties: true,
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          config: { type: 'object', additionalProperties: true },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
          issues: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value || value.ok !== true) {
          const reasons = Array.isArray(value?.issues) ? value.issues.map((item) => item.message).join('；') : value?.error;
          return textBlock(`设置未生效：${reasons || '未知原因'}`);
        }
        if (value.items) {
          const lines = [`历史采集 ${value.items.length} 条：`];
          for (const item of value.items.slice(0, 20)) lines.push(`· ${item.title}（${item.rel}）`);
          return textBlock(lines.join('\n'));
        }
        const config = value.config || {};
        return textBlock(
          [
            '当前设置：',
            `· 原生联网：${config.acquisition?.nativeWeb ? '开' : '关'}`,
            `· 直连抓取：${config.acquisition?.directHttp ? '开' : '关'}`,
            `· 浏览器标签页：${config.acquisition?.browserTabs ? '开' : '关'}`,
            `· 桌面操控：${config.acquisition?.computerUse ? '开' : '关'}`,
            `· MCP 工具：${config.acquisition?.mcpTools ? '开' : '关'}`,
            `· 输出目录：${config.output?.dir}`,
            `· 图片上限：${config.output?.imageLimit} 张 / 页`,
            `· 默认格式：${config.defaultFormat}`,
          ].join('\n'),
        );
      },
    },
    async execute(args) {
      const action = String(args?.action || 'get');
      if (action === 'list') {
        const items = typeof options.listItems === 'function' ? await options.listItems() : [];
        return { ok: true, items };
      }
      if (action === 'set') {
        if (!args?.patch || typeof args.patch !== 'object') return { ok: false, error: 'action=set 需要 patch 对象' };
        const result = applySettings(args.patch);
        if (result?.issues) return { ok: false, issues: result.issues };
        return { ok: true, config: result.config };
      }
      return { ok: true, config: getConfig() };
    },
  });

  return names;
}
