// dsh-collect · 配置：默认值、校验、Host 用的 standard-schema 声明
//
// 设计要点：
//   · apply 第一句就校验配置，非法值**响亮失败**，不静默回落默认值。
//   · 面板保存的设置叠在 cordis 配置之上（见 store.js 的 mergeSettings）。
//   · 不静态 import 任何 @deepseek-ai/* 或本地生成器模块——入口加载时它们可能还不存在。

/** 支持的输出格式（与 lib/generate/index.js 的 FORMATS 保持一致）。 */
export const FORMATS = Object.freeze(['md', 'html', 'txt', 'csv', 'json', 'docx', 'xlsx', 'pptx', 'pdf']);

/** 默认配置。面板里能改的字段都在这里。 */
export const DEFAULTS = Object.freeze({
  /** 信息获取方式。前两个是插件自己执行的，后三个只影响「允许/提示」，见 README。 */
  acquisition: Object.freeze({
    nativeWeb: true, // 宿主已接入的网页抓取/搜索服务
    directHttp: true, // 插件自己访问网站（不经过浏览器、不动鼠标）
    browserTabs: false, // 允许 AI 使用浏览器标签页类工具（无鼠标）
    computerUse: false, // 允许 AI 使用桌面操控类工具（会移动鼠标/键盘）；默认关闭
    mcpTools: false, // 允许 AI 使用其他 MCP 数据源
  }),
  output: Object.freeze({
    dir: '采文输出', // 相对工作目录的输出文件夹
    saveImages: true,
    imageLimit: 20, // 每条网页最多下载多少张图
    maxBytes: 8 * 1024 * 1024, // 单页最多读取字节
    timeoutMs: 20000, // 单次请求超时
  }),
  pdf: Object.freeze({
    converter: '', // 留空 = 自动检测 LibreOffice；可填 cli.js 或 soffice 的绝对路径
  }),
  defaultFormat: 'docx',
});

/** 单个输出目录的字符上限。 */
const MAX_DIR_LEN = 64;

/** 取布尔值。 */
function boolOf(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** 取字符串（去首尾空白、截断）。 */
function strOf(value, fallback, maxLength = 400) {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, maxLength);
}

/**
 * 取范围内的整数。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 默认值。
 * @param {number} min - 下界（含）。
 * @param {number} max - 上界（含）。
 * @param {string} path - 字段路径，用于错误信息。
 * @param {string[]} issues - 错误收集器。
 * @returns {number} 合法整数。
 */
function intIn(value, fallback, min, max, path, issues) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) {
    issues.push(`${path} 必须是整数（当前：${String(value)}）`);
    return fallback;
  }
  if (number < min || number > max) {
    issues.push(`${path} 必须在 ${min}~${max} 之间（当前：${number}）`);
    return fallback;
  }
  return number;
}

/**
 * 校验输出目录：只接受工作目录内的相对路径。
 * @param {unknown} value - 原始值。
 * @param {string[]} issues - 错误收集器。
 * @returns {string} 合法目录名。
 */
function outputDirOf(value, issues) {
  const fallback = DEFAULTS.output.dir;
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') {
    issues.push('output.dir 必须是字符串');
    return fallback;
  }
  let dir = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  // 统一成单层目录名：允许 `a/b` 但禁止绝对路径与上跳。
  const segments = dir.split('/').filter((part) => part.length > 0);
  if (segments.length === 0) return fallback;
  if (/^[a-zA-Z]:/.test(dir) || dir.startsWith('/')) {
    issues.push('output.dir 必须是相对工作目录的目录名，不能是绝对路径');
    return fallback;
  }
  if (segments.some((part) => part === '..' || part === '.')) {
    issues.push('output.dir 不能包含 . 或 .. 路径段');
    return fallback;
  }
  const normalized = segments.join('/');
  if (normalized.length > MAX_DIR_LEN) {
    issues.push(`output.dir 太长（超过 ${MAX_DIR_LEN} 个字符）`);
    return fallback;
  }
  return normalized;
}

/**
 * 校验并规范化配置。
 * @param {unknown} input - cordis 行传入的 config（可能是 undefined）。
 * @returns {{value: object}|{issues: {message: string}[]}} 校验结果。
 */
export function validateConfig(input) {
  const issues = [];
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const rawAcquisition = raw.acquisition && typeof raw.acquisition === 'object' ? raw.acquisition : {};
  const rawOutput = raw.output && typeof raw.output === 'object' ? raw.output : {};
  const rawPdf = raw.pdf && typeof raw.pdf === 'object' ? raw.pdf : {};

  const acquisition = {
    nativeWeb: boolOf(rawAcquisition.nativeWeb, DEFAULTS.acquisition.nativeWeb),
    directHttp: boolOf(rawAcquisition.directHttp, DEFAULTS.acquisition.directHttp),
    browserTabs: boolOf(rawAcquisition.browserTabs, DEFAULTS.acquisition.browserTabs),
    computerUse: boolOf(rawAcquisition.computerUse, DEFAULTS.acquisition.computerUse),
    mcpTools: boolOf(rawAcquisition.mcpTools, DEFAULTS.acquisition.mcpTools),
  };
  if (!acquisition.nativeWeb && !acquisition.directHttp) {
    issues.push('acquisition.nativeWeb 与 acquisition.directHttp 不能同时关闭（至少要有一路能真正取到网页）');
  }

  const output = {
    dir: outputDirOf(rawOutput.dir, issues),
    saveImages: boolOf(rawOutput.saveImages, DEFAULTS.output.saveImages),
    imageLimit: intIn(rawOutput.imageLimit, DEFAULTS.output.imageLimit, 0, 100, 'output.imageLimit', issues),
    maxBytes: intIn(rawOutput.maxBytes, DEFAULTS.output.maxBytes, 64 * 1024, 64 * 1024 * 1024, 'output.maxBytes', issues),
    timeoutMs: intIn(rawOutput.timeoutMs, DEFAULTS.output.timeoutMs, 1000, 120000, 'output.timeoutMs', issues),
  };

  const converterRaw = strOf(rawPdf.converter, DEFAULTS.pdf.converter, 1024);
  const pdf = { converter: converterRaw };

  const defaultFormat = FORMATS.includes(raw.defaultFormat) ? raw.defaultFormat : DEFAULTS.defaultFormat;

  const value = { acquisition, output, pdf, defaultFormat };
  return issues.length ? { issues: issues.map((message) => ({ message })) } : { value };
}

/**
 * 同 validateConfig，非法直接抛错（apply / 工具入口兜底用）。
 * @param {unknown} input - 原始配置。
 * @returns {object} 规范化后的配置。
 */
export function resolveConfig(input) {
  const result = validateConfig(input);
  if (result.issues) {
    throw new TypeError('dsh-collect 配置非法：\n' + result.issues.map((item) => `  - ${item.message}`).join('\n'));
  }
  return result.value;
}

/** 宿主使用的 standard-schema v1 校验器声明。 */
export const Config = Object.freeze({
  '~standard': Object.freeze({ version: 1, vendor: 'dsh-collect', validate: validateConfig }),
});
