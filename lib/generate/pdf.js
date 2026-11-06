/**
 * PDF 生成器：检测 LibreOffice 转换器，先用 docx.js 生成临时 Word 文档，
 * 再调用转换器把它转成 PDF，最后校验输出以 "%PDF-" 开头。
 *
 * 转换器检测顺序（与面板「PDF 转换器」设置一致）：
 *   1. options.converter（调用方显式传入）
 *   2. 环境变量 DSH_LIBREOFFICE_CLI
 *   3. PATH 中的 dsoffice
 *   4. 常见安装位置探测（宿主资源目录 / DSH_HOME / LOCALAPPDATA / Program Files 等）
 *   5. PATH 中的 soffice
 *
 * 本文件不包含任何本机绝对路径：所有候选位置都由环境变量或进程信息拼接而来。
 */

import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { renderDocx } from './docx.js';

/** 单次转换的超时时间（毫秒）。 */
const CONVERT_TIMEOUT_MS = 180000;

/**
 * PDF 不可用时抛出。message 面向普通用户，是可直接展示的中文说明。
 */
export class PdfUnavailableError extends Error {
  /**
   * @param {string} message 中文说明
   * @param {unknown} [cause] 底层原因
   */
  constructor(message, cause) {
    super(message);
    this.name = 'PdfUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * 判断路径是否存在且是文件。
 * @param {string} candidate
 * @returns {boolean}
 */
function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * 返回第一个存在的文件路径。
 * @param {string[]} candidates
 * @returns {string | null}
 */
function firstExistingFile(candidates) {
  for (const candidate of candidates) {
    if (candidate && isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * 在当前进程的 PATH 里按文件名查找可执行文件。
 * @param {string[]} names
 * @returns {string | null}
 */
function findOnPath(names) {
  const entries = String(process.env.PATH ?? '')
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry !== '');
  for (const directory of entries) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Windows 上的可执行文件名后缀差异。 */
function executableNames(base) {
  return process.platform === 'win32' ? [`${base}.exe`, base] : [base];
}

/**
 * 找宿主自带的 node 可执行文件（用于运行 LibreOffice Kit 的 cli.js）。
 * @returns {string} 找不到时回退到当前进程的可执行文件
 */
function findNodeBinary() {
  const explicit = String(process.env.DSH_LIBREOFFICE_NODE ?? process.env.DSH_NODE_BIN ?? '').trim();
  if (explicit && isFile(explicit)) return explicit;

  const names = executableNames('node');
  const roots = [];
  if (process.resourcesPath) roots.push(process.resourcesPath);
  if (process.env.DSH_HOME) roots.push(join(process.env.DSH_HOME, 'dsh-runtimes'));
  if (process.env.LOCALAPPDATA) {
    roots.push(join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources'));
  }

  /** 每个根目录下几种可能的运行时布局，逐个可执行文件名尝试。 */
  const layouts = [
    ['runtime', 'primary-runtime', 'dependencies', 'node', 'bin'],
    ['dependencies', 'node', 'bin'],
    ['node', 'bin'],
  ];
  const candidates = [];
  for (const root of roots) {
    for (const layout of layouts) {
      for (const name of names) candidates.push(join(root, ...layout, name));
    }
  }
  if (process.env.DSH_HOME) {
    for (const name of names) {
      candidates.push(join(process.env.DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', name));
    }
  }

  const found = firstExistingFile(candidates);
  if (found) return found;
  const fromPath = findOnPath(names);
  if (fromPath) return fromPath;
  // Electron 主进程里 process.execPath 是宿主可执行文件，配合 ELECTRON_RUN_AS_NODE 可当 node 用。
  return process.execPath;
}

/**
 * 由某个路径推断转换器类型：.js/.cjs/.mjs 视为 LibreOffice Kit 的 Node CLI，其余视为 soffice。
 * @param {string} candidate
 * @returns {{ kind: 'node-cli', node: string, cli: string } | { kind: 'soffice', bin: string } | null}
 */
function converterFromPath(candidate) {
  const value = String(candidate ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (value === '') return null;
  if (/\.(?:c|m)?js$/i.test(value)) {
    // 只接受真实存在的脚本，避免一个失效的配置项挡住后面的候选位置。
    if (!isFile(value)) return null;
    return { kind: 'node-cli', node: findNodeBinary(), cli: value };
  }
  if (isFile(value)) return { kind: 'soffice', bin: value };
  // 用户可能直接写了命令名（例如 soffice 或 dsoffice），交给 PATH 解析。
  const onPath = findOnPath(executableNames(value));
  if (onPath) return { kind: 'soffice', bin: onPath };
  return null;
}

/**
 * 校验并规范化调用方传入的 converter 对象。
 * @param {unknown} value
 * @returns {{ kind: 'node-cli', node: string, cli: string } | { kind: 'soffice', bin: string } | null}
 */
function normalizeConverter(value) {
  if (!value || typeof value !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (record.kind === 'node-cli') {
    if (typeof record.node !== 'string' || typeof record.cli !== 'string') return null;
    if (record.node === '' || record.cli === '') return null;
    return { kind: 'node-cli', node: record.node, cli: record.cli };
  }
  if (record.kind === 'soffice') {
    if (typeof record.bin !== 'string' || record.bin === '') return null;
    return { kind: 'soffice', bin: record.bin };
  }
  return null;
}

/**
 * 常见安装位置候选（全部由环境变量 / 进程信息拼接，不含本机固定路径）。
 * @returns {string[]}
 */
function commonInstallCandidates() {
  const candidates = [];
  const push = (value) => {
    if (value) candidates.push(value);
  };
  /** 在某个目录下按可执行文件名逐个登记 soffice。 */
  const pushSoffice = (...baseParts) => {
    for (const name of executableNames('soffice')) push(join(...baseParts, name));
  };
  const pushCli = (...baseParts) => {
    push(join(...baseParts, '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js'));
  };

  const resources = process.resourcesPath;
  const localAppData = process.env.LOCALAPPDATA;
  const dshHome = process.env.DSH_HOME;
  const programFiles = process.env.ProgramFiles ?? process.env.ProgramW6432 ?? process.env['ProgramFiles(x86)'];

  if (resources) {
    pushCli(resources, 'app.asar.unpacked', 'dsh', 'node_modules');
    pushCli(resources, 'dsh', 'node_modules');
    pushSoffice(resources, 'runtime', 'primary-runtime', 'dependencies', 'libreoffice', 'program');
  }
  if (dshHome) {
    pushSoffice(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'libreoffice', 'program');
    pushCli(dshHome, 'node_modules');
  }
  if (localAppData) {
    pushCli(
      localAppData,
      'Programs',
      'DeepSeek Harness',
      'resources',
      'app.asar.unpacked',
      'dsh',
      'node_modules',
    );
    pushSoffice(
      localAppData,
      'Programs',
      'DeepSeek Harness',
      'resources',
      'runtime',
      'primary-runtime',
      'dependencies',
      'libreoffice',
      'program',
    );
    pushSoffice(localAppData, 'Programs', 'LibreOffice', 'program');
  }
  if (programFiles) {
    pushSoffice(programFiles, 'LibreOffice', 'program');
  }
  // 其他平台的常见安装位置（探测不到时 isFile 会直接跳过）。
  push('/Applications/LibreOffice.app/Contents/MacOS/soffice');
  push('/usr/bin/soffice');
  push('/usr/local/bin/soffice');
  push('/opt/libreoffice/program/soffice');
  return candidates;
}

/**
 * 检测可用的 PDF 转换器。
 * @param {{ converter?: unknown }} [options]
 * @returns {{ kind: 'node-cli', node: string, cli: string } | { kind: 'soffice', bin: string } | null}
 */
export function detectConverter(options = {}) {
  const provided = normalizeConverter(options?.converter);
  if (provided) return provided;

  const fromEnv = converterFromPath(process.env.DSH_LIBREOFFICE_CLI ?? '');
  if (fromEnv) return fromEnv;

  const dsoffice = findOnPath(executableNames('dsoffice'));
  if (dsoffice) return { kind: 'soffice', bin: dsoffice };

  for (const candidate of commonInstallCandidates()) {
    if (!isFile(candidate)) continue;
    const resolved = converterFromPath(candidate);
    if (resolved) return resolved;
  }

  const soffice = findOnPath(executableNames('soffice'));
  if (soffice) return { kind: 'soffice', bin: soffice };

  return null;
}

/**
 * 读取转换日志文件的末尾一段（转换失败时用来拼错误信息）。
 * @param {string} logPath
 * @returns {string}
 */
function readLogTail(logPath) {
  try {
    const text = readFileSync(logPath, 'utf8');
    return text.length > 4000 ? text.slice(-4000) : text;
  } catch {
    return '';
  }
}

/**
 * 运行一个外部命令，超时会杀掉子进程。
 *
 * 注意：这里刻意不用 stdio:'pipe' 捕获输出。在受限执行环境（Windows 沙箱、
 * 部分桌面宿主）里，子进程的管道 stdio 可能直接以 EPERM 失败；
 * 改成把 stdout/stderr 重定向到临时日志文件描述符，兼容性最好。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {number} timeoutMs
 * @param {string} logPath 子进程输出落盘位置
 * @returns {Promise<{ code: number, output: string }>}
 */
function runCommand(command, args, timeoutMs, logPath) {
  return new Promise((resolve, reject) => {
    /** @type {number | null} */
    let logFd = null;
    try {
      logFd = openSync(logPath, 'w');
    } catch (error) {
      reject(error);
      return;
    }
    let fdClosed = false;
    const closeLog = () => {
      if (fdClosed) return;
      fdClosed = true;
      try {
        closeSync(logFd);
      } catch {
        // 关闭失败不影响结果
      }
    };

    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      const env = { ...process.env };
      // 在 Electron 里用 process.execPath 当 node 跑 CLI 时必须打开该开关。
      if (process.versions.electron && command === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
      child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', logFd, logFd] });
    } catch (error) {
      closeLog();
      reject(error);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      closeLog();
      reject(new PdfUnavailableError('PDF 转换超时：LibreOffice 长时间没有返回结果，请稍后重试。'));
    }, timeoutMs);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeLog();
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeLog();
      resolve({ code: code ?? -1, output: readLogTail(logPath) });
    });
  });
}

/**
 * 用检测到的转换器把 docx 转成 pdf。
 * @param {{ kind: 'node-cli', node: string, cli: string } | { kind: 'soffice', bin: string }} converter
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {string} workdir
 * @returns {Promise<void>}
 */
async function convertWith(converter, inputPath, outputPath, workdir) {
  let command;
  let args;
  let label;
  if (converter.kind === 'node-cli') {
    command = converter.node;
    args = [converter.cli, 'convert', '--input', inputPath, '--output', outputPath];
    label = 'LibreOffice Kit';
  } else {
    command = converter.bin;
    args = ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', workdir, inputPath];
    label = 'LibreOffice';
  }
  const logPath = join(workdir, 'converter.log');
  let result;
  try {
    result = await runCommand(command, args, CONVERT_TIMEOUT_MS, logPath);
  } catch (error) {
    if (error instanceof PdfUnavailableError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new PdfUnavailableError(`PDF 转换失败：无法启动 ${label}（${detail}）。请检查转换器路径是否正确。`, error);
  }
  if (result.code !== 0) {
    const detail = result.output.trim().split('\n').slice(-3).join(' ').slice(0, 400);
    throw new PdfUnavailableError(
      `PDF 转换失败：${label} 退出码 ${result.code}${detail === '' ? '' : `（${detail}）`}。可以改用导出 Word 文档。`,
    );
  }
}

/**
 * 生成 PDF 字节。
 *
 * @param {import('./index.js').Doc} doc
 * @param {{ readImage?: (src: string) => Promise<unknown>, converter?: unknown, log?: (message: string) => void }} [options]
 * @returns {Promise<{ data: Uint8Array, mime: string, ext: string, note: string }>}
 */
export async function renderPdf(doc, options = {}) {
  const converter = detectConverter(options);
  if (!converter) {
    throw new PdfUnavailableError(
      '当前环境没有找到可用的 PDF 转换器。PDF 需要由 LibreOffice 生成：请先安装 LibreOffice，' +
        '或在「采文」设置里填写 LibreOffice 的 soffice 路径；也可以先导出 Word 文档（.docx）再自行转换。',
    );
  }

  const workdir = await mkdtemp(join(tmpdir(), 'dsh-collect-pdf-'));
  const inputPath = join(workdir, 'document.docx');
  const outputPath = join(workdir, 'document.pdf');
  try {
    const docxBytes = await renderDocx(doc, options);
    await writeFile(inputPath, docxBytes);
    await convertWith(converter, inputPath, outputPath, workdir);

    let bytes;
    try {
      bytes = await readFile(outputPath);
    } catch (error) {
      throw new PdfUnavailableError('PDF 转换失败：转换器没有生成输出文件，请检查 LibreOffice 安装是否完整。', error);
    }
    if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new PdfUnavailableError('PDF 转换失败：输出文件不是有效的 PDF（文件头不是 %PDF-），请重试或改用导出 Word。');
    }
    return {
      data: new Uint8Array(bytes),
      mime: 'application/pdf',
      ext: 'pdf',
      note: `已通过 ${converter.kind === 'node-cli' ? 'LibreOffice Kit' : 'LibreOffice'} 转换为 PDF`,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
