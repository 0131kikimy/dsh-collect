// dsh-collect · 导出：Markdown → Doc 模型 → 目标格式文件
//
// 三件事：
//   1. markdownToDoc：把采集到的 Markdown 变成生成器认的 Doc 模型（CONTRACT §3）。
//   2. renderToFile：调用 lib/generate 生成字节并落盘；PDF 没有转换引擎时降级成 docx。
//   3. detectPdfConverter：找本机的 LibreOffice（环境变量 / resources 目录 / PATH）。
//
// 这里**不静态 import** lib/generate/*：模块缺失时只影响导出，不影响插件加载。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 生成器目录。 */
const GENERATE_ENTRY = new URL('./generate/index.js', import.meta.url);

/**
 * 读取图片：交给生成器判断尺寸与格式。
 * @param {string} filePath - 图片绝对路径。
 * @returns {Promise<{buffer: Buffer, mime: string, width: number, height: number}|null>}
 */
async function readImageFile(filePath) {
  try {
    const buffer = await readFile(filePath);
    const sniff = await loadImageSniffer();
    const info = sniff ? sniff(buffer) : null;
    if (!info) return null;
    return { buffer, mime: info.mime, width: info.width, height: info.height };
  } catch {
    return null;
  }
}

/** 图片识别器（优先用采集引擎的 img.js，缺失时用本地最小实现）。 */
let snifferPromise;
function loadImageSniffer() {
  if (snifferPromise === undefined) {
    snifferPromise = import('./img.js')
      .then((mod) => (typeof mod.sniffImage === 'function' ? mod.sniffImage : sniffImageFallback))
      .catch(() => sniffImageFallback);
  }
  return snifferPromise;
}

/**
 * 最小图片尺寸识别（PNG / JPEG / GIF / WebP）。
 * @param {Buffer} buffer - 图片字节。
 * @returns {{mime:string, ext:string, width:number, height:number}|null}
 */
function sniffImageFallback(buffer) {
  if (!buffer || buffer.length < 12) return null;
  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { mime: 'image/png', ext: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // GIF
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { mime: 'image/gif', ext: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', ext: 'jpg', height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
    return { mime: 'image/jpeg', ext: 'jpg', width: 0, height: 0 };
  }
  // WebP
  if (buffer.length > 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp', width: 0, height: 0 };
  }
  return null;
}

/**
 * 判断一行是不是图片独占行：`![alt](src)`。
 * @param {string} line - Markdown 行。
 * @returns {{alt: string, src: string}|null}
 */
function matchImageLine(line) {
  const hit = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/.exec(line);
  if (!hit) return null;
  return { alt: hit[1] || '', src: hit[2] };
}

/**
 * 把图片相对路径解析成本机绝对路径。
 * @param {string} src - Markdown 里的图片地址。
 * @param {string} baseDir - 采集结果目录。
 * @returns {string} 绝对路径（http/https 原样返回，生成器会跳过）。
 */
function resolveImagePath(src, baseDir) {
  if (/^(https?:|data:)/i.test(src)) return src;
  if (/^file:\/\//i.test(src)) {
    try { return new URL(src).pathname.replace(/^\/([a-zA-Z]:)/, '$1'); } catch { return src; }
  }
  return path.resolve(baseDir, decodeURIComponent(src.replace(/^\.\//, '')));
}

/**
 * 表格分隔行：`| --- | :--: |`。
 * @param {string} line - Markdown 行。
 * @returns {boolean} 是否分隔行。
 */
function isTableSeparator(line) {
  return /^\|?[\s:|-]+\|?$/.test(line) && line.includes('-') && line.includes('|');
}

/**
 * 拆分表格行。
 * @param {string} line - Markdown 行。
 * @returns {string[]} 单元格文本。
 */
function splitTableRow(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  return text.split('|').map((cell) => cell.trim());
}

/**
 * Markdown → Doc 模型。
 * @param {object} input - 输入。
 * @param {string} input.markdown - 采集到的 Markdown。
 * @param {string} [input.title] - 标题（缺省时用首个 `# ` 标题）。
 * @param {string} [input.subtitle] - 副标题。
 * @param {string} [input.sourceUrl] - 来源网址。
 * @param {string} [input.collectedAt] - ISO 时间。
 * @param {string} [input.baseDir] - 图片相对路径的基准目录（采集结果目录）。
 * @returns {object} Doc 模型。
 */
export function markdownToDoc(input) {
  const markdown = String(input?.markdown || '');
  const baseDir = input?.baseDir || process.cwd();
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');

  /** @type {any[]} */
  const blocks = [];
  /** @type {string|undefined} */
  let title = input?.title || '';
  let index = 0;

  /** 追加一个文本段落（合并软换行）。 */
  const pushParagraph = (buffer) => {
    const text = buffer.join('\n').trim();
    if (!text) return;
    blocks.push({ type: 'paragraph', text });
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    // 空行：结束当前段落
    if (trimmed === '') { index += 1; continue; }

    // 分页标记
    if (/^<!--\s*pagebreak\s*-->$/i.test(trimmed)) {
      blocks.push({ type: 'pagebreak' });
      index += 1;
      continue;
    }

    // 代码块
    if (/^```/.test(trimmed)) {
      const lang = trimmed.slice(3).trim();
      const body = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // 跳过结束围栏
      blocks.push({ type: 'code', text: body.join('\n'), ...(lang ? { lang } : {}) });
      continue;
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(3, heading[1].length);
      const text = heading[2].trim();
      if (!title && heading[1].length === 1) {
        title = text;
      } else {
        blocks.push({ type: 'heading', level, text });
      }
      index += 1;
      continue;
    }

    // 图片独占行
    const image = matchImageLine(trimmed);
    if (image) {
      blocks.push({ type: 'image', src: resolveImagePath(image.src, baseDir), alt: image.alt });
      index += 1;
      continue;
    }

    // 表格
    if (trimmed.startsWith('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const headers = splitTableRow(trimmed);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(splitTableRow(lines[index].trim()));
        index += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // 引用
    if (/^>\s?/.test(trimmed)) {
      const body = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        body.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', text: body.join('\n').trim() });
      continue;
    }

    // 无序列表
    if (/^[-*+]\s+/.test(trimmed)) {
      const items = [];
      while (index < lines.length && /^[-*+]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*+]\s+/, ''));
        index += 1;
      }
      blocks.push({ type: 'bullets', items });
      continue;
    }

    // 有序列表
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items = [];
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+[.)]\s+/, ''));
        index += 1;
      }
      blocks.push({ type: 'numbered', items });
      continue;
    }

    // 普通段落：连续非空行合并
    const paragraph = [];
    while (index < lines.length) {
      const current = lines[index].trim();
      if (current === '') break;
      if (/^(#{1,6})\s+/.test(current)) break;
      if (/^```/.test(current)) break;
      if (/^[-*+]\s+/.test(current)) break;
      if (/^\d+[.)]\s+/.test(current)) break;
      if (/^>\s?/.test(current)) break;
      if (current.startsWith('|')) break;
      if (matchImageLine(current)) break;
      if (/^<!--\s*pagebreak\s*-->$/i.test(current)) break;
      paragraph.push(current);
      index += 1;
    }
    pushParagraph(paragraph);
  }

  return {
    title: title || '未命名文档',
    ...(input?.subtitle ? { subtitle: input.subtitle } : {}),
    ...(input?.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    ...(input?.collectedAt ? { collectedAt: input.collectedAt } : {}),
    blocks,
  };
}

/** 生成器的动态导入缓存。 */
let generatePromise;
/**
 * 加载生成器模块。
 * @returns {Promise<object>} lib/generate/index.js 的导出。
 */
function loadGenerate() {
  if (generatePromise === undefined) {
    generatePromise = import(GENERATE_ENTRY.href).catch((error) => {
      generatePromise = undefined;
      throw new Error(`文件生成模块加载失败：${error?.message ?? error}`);
    });
  }
  return generatePromise;
}

/**
 * 在 PATH 里找一个可执行文件。
 * @param {string} name - 不带扩展名的命令名。
 * @returns {string} 绝对路径；找不到返回空字符串。
 */
function findOnPath(name) {
  const pathValue = process.env.PATH || '';
  const separator = process.platform === 'win32' ? ';' : ':';
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of pathValue.split(separator)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${name}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

/** PDF 转换器检测缓存。 */
const converterCache = { key: null, value: null };

/**
 * 检测本机的 PDF 转换器。
 * @param {string} [configured] - 配置里显式写的路径（cli.js 或 soffice 可执行文件）。
 * @returns {{kind:'node-cli', node:string, cli:string}|{kind:'soffice', bin:string}|null} 转换器描述。
 */
export function detectPdfConverter(configured) {
  const key = String(configured || '');
  if (converterCache.key === key) return converterCache.value;

  const KIT_RELATIVE = ['app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js'];
  const candidates = [];
  const push = (value) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  // 1) 配置显式指定
  if (key) push(key);
  // 2) 环境变量
  push(process.env.DSH_LIBREOFFICE_CLI);
  push(process.env.DSH_OFFICE_CLI);

  /** 从某个 resources 目录推出 kit CLI 与 soffice 的候选路径。 */
  let nodeFromResources = '';
  const pushFromResources = (resources) => {
    if (!resources) return;
    push(path.join(resources, ...KIT_RELATIVE));
    push(path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js'));
    push(path.join(resources, 'runtime', 'soffice', process.platform === 'win32' ? 'soffice.exe' : 'soffice'));
    if (!nodeFromResources) {
      const runtimeNode = process.platform === 'win32' ? 'node.exe' : 'node';
      for (const candidate of [
        path.join(resources, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', runtimeNode),
        path.join(resources, 'runtime', 'bin', runtimeNode),
      ]) {
        if (existsSync(candidate)) {
          nodeFromResources = candidate;
          break;
        }
      }
    }
  };

  /**
   * 给 CLI 找配套的 Node：优先同一个 resources 下的运行时 Node，其次 PATH，最后当前进程。
   * @param {string} cliPath - kit cli.js 路径。
   * @returns {string} Node 可执行文件路径。
   */
  const nodeForCli = (cliPath) => {
    const segments = String(cliPath).split(/[\\/]/);
    const index = segments.lastIndexOf('resources');
    if (index > 0) {
      const runtimeNode = process.platform === 'win32' ? 'node.exe' : 'node';
      const resources = segments.slice(0, index + 1).join(path.sep);
      for (const candidate of [
        path.join(resources, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', runtimeNode),
        path.join(resources, 'runtime', 'bin', runtimeNode),
      ]) {
        if (existsSync(candidate)) return candidate;
      }
    }
    return nodeFromResources || findOnPath('node') || process.execPath;
  };

  // 3) Electron 的 resources 目录（DSH 桌面版，最可靠）
  pushFromResources(process.resourcesPath);

  // 4) 常见安装位置（不写死用户名：全部由环境变量拼出）
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.PROGRAMFILES;
  const programFilesX86 = process.env['PROGRAMFILES(X86)'];
  const appData = process.env.APPDATA;
  for (const base of [localAppData && path.join(localAppData, 'Programs'), programFiles, programFilesX86, appData && path.join(appData, 'Programs')]) {
    if (base) pushFromResources(path.join(base, 'DeepSeek Harness', 'resources'));
  }
  if (process.platform === 'darwin') pushFromResources('/Applications/DeepSeek Harness.app/Contents/Resources');

  // 5) 从宿主可执行文件往上找 resources/（便携版、自定义安装目录）
  try {
    let dir = path.dirname(process.execPath || '');
    for (let level = 0; level < 6 && dir; level += 1) {
      const resources = path.join(dir, 'resources');
      if (existsSync(path.join(resources, ...KIT_RELATIVE))) {
        pushFromResources(resources);
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* 进程路径不可用时跳过 */
  }

  // 6) DSH_HOME/dsh-runtimes 下的运行时（SDK / Web 版）
  const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  if (dshHome) {
    push(path.join(dshHome, 'dsh-runtimes', 'primary-runtime', 'dependencies', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js'));
    try {
      const runtimesDir = path.join(dshHome, 'dsh-runtimes');
      for (const name of readdirSync(runtimesDir)) {
        push(path.join(runtimesDir, name, 'dependencies', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js'));
      }
    } catch {
      /* 目录不存在就跳过 */
    }
  }

  // 7) PATH 上的 dsoffice / soffice
  push(findOnPath('dsoffice'));
  push(findOnPath('soffice'));

  let result = null;
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    if (/cli\.js$/i.test(candidate)) {
      result = { kind: 'node-cli', node: nodeForCli(candidate), cli: candidate };
      break;
    }
    if (/soffice(\.exe)?$/i.test(candidate)) {
      result = { kind: 'soffice', bin: candidate };
      break;
    }
    if (/dsoffice(\.cmd|\.exe)?$/i.test(candidate)) {
      result = { kind: 'node-cli', node: process.execPath, cli: candidate };
      break;
    }
  }
  converterCache.key = key;
  converterCache.value = result;
  return result;
}

/**
 * 生成目标格式文件并落盘。
 *
 * PDF 没有可用转换引擎时**不报错中断**：降级生成 docx，并在 note 里告诉用户怎么拿到 PDF。
 *
 * @param {object} input - 入参。
 * @param {object} input.doc - Doc 模型。
 * @param {string} input.format - 目标格式（小写）。
 * @param {string} input.outputPath - 输出文件绝对路径（扩展名由调用方保证）。
 * @param {string} [input.converterPath] - 配置里的 PDF 转换器路径。
 * @param {(message: string) => void} [input.log] - 日志回调。
 * @returns {Promise<{path:string, bytes:number, mime:string, ext:string, note?:string, degraded?:boolean}>}
 */
export async function renderToFile(input) {
  const { doc, format, outputPath } = input;
  const log = typeof input.log === 'function' ? input.log : () => {};
  const generate = await loadGenerate();
  const readImage = (src) => readImageFile(src);

  await mkdir(path.dirname(outputPath), { recursive: true });

  const converter = detectPdfConverter(input.converterPath);
  if (format === 'pdf' && !converter) {
    log('dsh-collect: 没有找到 PDF 转换引擎，降级生成 docx');
    const docxPath = outputPath.replace(/\.pdf$/i, '') + '.docx';
    const fallback = await generate.render('docx', doc, { readImage, log });
    const buffer = Buffer.from(fallback.data);
    await writeFile(docxPath, buffer);
    return {
      path: docxPath,
      bytes: buffer.length,
      mime: fallback.mime,
      ext: fallback.ext,
      degraded: true,
      note: '本机没有找到可用的 PDF 转换引擎（LibreOffice）。已先导出 Word 文档：用 Word / WPS 打开后「另存为 PDF」即可得到 PDF。',
    };
  }

  const result = await generate.render(format, doc, { readImage, converter, log });
  const buffer = Buffer.from(result.data);
  await writeFile(outputPath, buffer);
  return {
    path: outputPath,
    bytes: buffer.length,
    mime: result.mime,
    ext: result.ext,
    ...(result.note ? { note: result.note } : {}),
  };
}

/** 生成器的文件入口 URL（诊断用）。 */
export function generateEntryPath() {
  return pathToFileURL(GENERATE_ENTRY.pathname).pathname;
}
