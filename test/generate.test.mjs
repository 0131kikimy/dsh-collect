/**
 * 文件生成引擎自测脚本（零依赖，直接运行）：
 *
 *   node test/generate.test.mjs
 *
 * 可选环境变量（不设置则跳过对应检查，并打印提示）：
 *   DSH_TEST_PYTHON   宿主自带 python 可执行文件路径，用于打开 docx/xlsx/pptx 验证内容
 *   DSH_TEST_PDF_NODE 运行 LibreOffice Kit CLI 的 node 路径
 *   DSH_TEST_PDF_CLI  LibreOffice Kit 的 cli.js 路径；设置后做一次真实 PDF 转换验证
 *
 * 所有产物写到 os.tmpdir() 下的唯一临时目录，结束后清理。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { FORMATS, render, PdfUnavailableError } from '../lib/generate/index.js';

/** 1×1 透明 PNG，作为内嵌图片测试数据。 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const PYTHON = String(process.env.DSH_TEST_PYTHON ?? '').trim();
const PDF_NODE = String(process.env.DSH_TEST_PDF_NODE ?? '').trim();
const PDF_CLI = String(process.env.DSH_TEST_PDF_CLI ?? '').trim();

let passed = 0;
const failures = [];

/**
 * 执行一个同步检查。
 * @param {string} name
 * @param {() => void} fn
 */
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 执行一个异步检查。
 * @param {string} name
 * @param {() => Promise<void>} fn
 */
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 测试用文档：包含中文、特殊字符、表格、图片、分页。 */
function sampleDoc() {
  return {
    title: '采文测试报告',
    subtitle: '来源：示例站点',
    sourceUrl: 'https://example.com/article',
    collectedAt: '2026-01-02T03:04:05Z',
    blocks: [
      { type: 'heading', level: 1, text: '第一章 概述' },
      { type: 'paragraph', text: '这是正文段落，包含特殊字符 & < > 与中文标点。' },
      { type: 'quote', text: '引用的原文内容。' },
      { type: 'bullets', items: ['要点甲', '要点乙'] },
      { type: 'numbered', items: ['步骤一', '步骤二'] },
      { type: 'code', text: 'export function hi() {\n  return "<b>你好</b>";\n}', lang: 'js' },
      {
        type: 'table',
        headers: ['项目', '数量', '备注'],
        rows: [
          ['苹果', '3', '新鲜'],
          ['香蕉', '5', '进口'],
        ],
      },
      { type: 'image', src: 'image-demo.png', alt: '示意图', caption: '图 1 示意图' },
      { type: 'pagebreak' },
      { type: 'heading', level: 2, text: '第二章 明细' },
      { type: 'paragraph', text: '第二页的正文。' },
    ],
  };
}

/**
 * 读取图片：只有约定的演示图片返回数据，其余返回 null。
 * @param {string} src
 */
async function readImage(src) {
  if (src === 'image-demo.png') {
    return { buffer: PNG_BYTES, mime: 'image/png', width: 640, height: 360 };
  }
  return null;
}

/**
 * 解码 UTF-8 字节。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function decode(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * 校验 ZIP 魔数。
 * @param {Uint8Array} bytes
 */
function assertZipMagic(bytes) {
  assert.ok(bytes instanceof Uint8Array, '返回值应是 Uint8Array');
  assert.ok(bytes.length > 200, `文件太小（${bytes.length} 字节）`);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], '文件头应为 PK\\x03\\x04');
}

/**
 * 扫描本地文件头，列出包内条目名。
 * @param {Uint8Array} bytes
 * @returns {string[]}
 */
function zipEntryNames(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names = [];
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const start = offset + 30 + nameLength + extraLength;
    names.push(decode(bytes.subarray(offset + 30, offset + 30 + nameLength)));
    offset = start + compressedSize;
  }
  return names;
}

/**
 * 从 ZIP 里读出某个条目的内容（支持 store 与 deflate）。
 * @param {Uint8Array} bytes
 * @param {string} wanted
 * @returns {Uint8Array | null}
 */
function zipReadEntry(bytes, wanted) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const start = offset + 30 + nameLength + extraLength;
    const name = decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    if (name === wanted) {
      const raw = bytes.subarray(start, start + compressedSize);
      return method === 0 ? raw : new Uint8Array(inflateRawSync(raw));
    }
    offset = start + compressedSize;
  }
  return null;
}

/**
 * 运行 python 脚本并返回标准输出。
 *
 * 说明：这里不用 stdio:'pipe' 捕获输出——受限执行环境（Windows 沙箱）下子进程管道
 * 可能直接 EPERM。改为把 stdout/stderr 重定向到临时文件再读回。
 *
 * @param {string} script
 * @param {string[]} args
 * @param {string} workdir 临时目录
 * @param {string} tag 输出文件名前缀
 * @returns {Promise<string>}
 */
async function runPython(script, args, workdir, tag) {
  const outPath = join(workdir, `python-${tag}.out`);
  const errPath = join(workdir, `python-${tag}.err`);
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  const closeAll = () => {
    for (const fd of [outFd, errFd]) {
      try {
        closeSync(fd);
      } catch {
        // 忽略重复关闭
      }
    }
  };
  try {
    await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(PYTHON, ['-c', script, ...args], {
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
          windowsHide: true,
          stdio: ['ignore', outFd, errFd],
        });
      } catch (error) {
        reject(error);
        return;
      }
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`python 退出码 ${code}`));
      });
    });
  } finally {
    closeAll();
  }
  const stdout = readFileSync(outPath, 'utf8');
  const stderr = existsSync(errPath) ? readFileSync(errPath, 'utf8') : '';
  if (stdout.trim() === '' && stderr.trim() !== '') {
    throw new Error(`python 无输出：${stderr.trim().slice(0, 600)}`);
  }
  return stdout;
}

const DOCX_SCRIPT = `
import sys
from docx import Document
document = Document(sys.argv[1])
print("PARAGRAPHS")
for paragraph in document.paragraphs:
    print(paragraph.text)
print("TABLES")
for table in document.tables:
    for row in table.rows:
        for cell in row.cells:
            print(cell.text)
print("INLINE_SHAPES=%d" % len(document.inline_shapes))
`;

const XLSX_SCRIPT = `
import sys
from openpyxl import load_workbook
workbook = load_workbook(sys.argv[1])
sheet = workbook.active
print("SHEET=%s" % sheet.title)
for row in sheet.iter_rows():
    values = [str(cell.value) for cell in row if cell.value is not None]
    if values:
        print(" | ".join(values))
bold = [str(cell.value) for row in sheet.iter_rows() for cell in row if cell.font is not None and cell.font.bold and cell.value is not None]
print("BOLD=" + "|".join(bold))
`;

const PPTX_SCRIPT = `
import sys
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
presentation = Presentation(sys.argv[1])
print("SLIDES=%d" % len(presentation.slides))
pictures = 0
for slide in presentation.slides:
    for shape in slide.shapes:
        if shape.has_text_frame and shape.text_frame.text.strip():
            print(shape.text_frame.text)
        if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
            pictures += 1
print("PICTURES=%d" % pictures)
`;

/**
 * 主流程。
 */
async function main() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-collect-generate-test-'));
  try {
    console.log(`临时目录：${root}\n`);

    console.log('[1] 格式清单与错误语义');
    check('FORMATS 与契约一致', () => {
      assert.deepEqual(FORMATS, ['md', 'html', 'txt', 'csv', 'json', 'docx', 'xlsx', 'pptx', 'pdf']);
    });
    await checkAsync('未知格式抛 unknown format', async () => {
      await assert.rejects(() => render('exe', sampleDoc(), {}), /unknown format: exe/);
    });
    await checkAsync('无转换器时 PDF 抛 PdfUnavailableError', async () => {
      const brokenConverter = { kind: 'node-cli', node: join(root, 'missing-node'), cli: join(root, 'missing-cli.js') };
      await assert.rejects(
        () => render('pdf', sampleDoc(), { readImage, converter: brokenConverter }),
        (error) => {
          assert.ok(error instanceof PdfUnavailableError, '错误类型应为 PdfUnavailableError');
          assert.match(error.message, /PDF/);
          return true;
        },
      );
    });

    console.log('\n[2] 文本格式（md / html / txt / csv / json）');
    const doc = sampleDoc();
    const md = decode((await render('md', doc, { readImage })).data);
    const html = decode((await render('html', doc, { readImage })).data);
    const txt = decode((await render('txt', doc, { readImage })).data);
    const csvResult = await render('csv', doc, { readImage });
    const csv = decode(csvResult.data);
    const json = decode((await render('json', doc, { readImage })).data);

    check('md 含标题/列表/表格/代码/图片', () => {
      assert.match(md, /^# 采文测试报告/m);
      assert.ok(md.includes('> 来源：示例站点'));
      assert.ok(md.includes('# 第一章 概述'));
      assert.ok(md.includes('## 第二章 明细'));
      assert.ok(md.includes('- 要点甲'));
      assert.ok(md.includes('1. 步骤一'));
      assert.ok(md.includes('```js'));
      assert.ok(md.includes('| 项目 | 数量 | 备注 |'));
      assert.ok(md.includes('![示意图](image-demo.png)'));
      assert.ok(md.includes('*图 1 示意图*'));
    });
    check('html 含完整文档结构与转义', () => {
      assert.ok(html.startsWith('<!doctype html>'));
      assert.ok(html.includes('<title>采文测试报告</title>'));
      assert.ok(html.includes('&amp;'));
      assert.ok(html.includes('&lt;b&gt;你好&lt;/b&gt;'));
      assert.ok(html.includes('<table>'));
      assert.ok(html.includes('<figure><img src="image-demo.png"'));
    });
    check('txt 含标题与表格文本', () => {
      assert.ok(txt.includes('采文测试报告'));
      assert.ok(txt.includes('第一章 概述'));
      assert.ok(txt.includes('苹果 | 3 | 新鲜'));
      assert.ok(txt.includes('--- 分页 ---'));
    });
    check('csv 带 UTF-8 BOM 且逐行展开', () => {
      assert.deepEqual([...csvResult.data.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'CSV 应带 UTF-8 BOM');
      assert.ok(csv.includes('标题,采文测试报告'));
      assert.ok(csv.includes('表头,项目 | 数量 | 备注'));
      assert.ok(csv.includes('表格行,苹果 | 3 | 新鲜'));
      assert.ok(csvResult.note && csvResult.note.includes('BOM'));
    });
    check('json 可解析且保留正文块', () => {
      const parsed = JSON.parse(json);
      assert.equal(parsed.title, '采文测试报告');
      assert.equal(parsed.sourceUrl, 'https://example.com/article');
      assert.equal(parsed.blocks.length, doc.blocks.length);
    });

    console.log('\n[3] docx');
    const docxResult = await render('docx', doc, { readImage });
    assertZipMagic(docxResult.data);
    assert.equal(docxResult.ext, 'docx');
    check('docx 包内必需部件齐全', () => {
      const names = zipEntryNames(docxResult.data);
      for (const part of [
        '[Content_Types].xml',
        '_rels/.rels',
        'word/document.xml',
        'word/_rels/document.xml.rels',
        'word/styles.xml',
        'word/numbering.xml',
      ]) {
        assert.ok(names.includes(part), `缺少部件 ${part}（现有：${names.join(', ')}）`);
      }
      assert.ok(names.some((name) => name.startsWith('word/media/image')), '缺少内嵌图片');
    });
    check('docx XML 中文与转义正确', () => {
      const xml = decode(zipReadEntry(docxResult.data, 'word/document.xml'));
      assert.ok(xml.includes('采文测试报告'));
      assert.ok(xml.includes('&lt;b&gt;你好&lt;/b&gt;'));
      assert.ok(xml.includes('<w:tbl>'));
      assert.ok(xml.includes('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'));
    });
    const docxPath = join(root, 'sample.docx');
    await writeFile(docxPath, docxResult.data);

    console.log('\n[4] xlsx');
    const xlsxResult = await render('xlsx', doc, { readImage });
    assertZipMagic(xlsxResult.data);
    check('xlsx 包内必需部件齐全', () => {
      const names = zipEntryNames(xlsxResult.data);
      for (const part of [
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/workbook.xml',
        'xl/_rels/workbook.xml.rels',
        'xl/styles.xml',
        'xl/worksheets/sheet1.xml',
      ]) {
        assert.ok(names.includes(part), `缺少部件 ${part}（现有：${names.join(', ')}）`);
      }
    });
    check('xlsx XML 中文与表头样式正确', () => {
      const xml = decode(zipReadEntry(xlsxResult.data, 'xl/worksheets/sheet1.xml'));
      assert.ok(xml.includes('采文测试报告'));
      assert.ok(xml.includes('项目'));
      assert.ok(xml.includes('t="inlineStr"'));
      const styles = decode(zipReadEntry(xlsxResult.data, 'xl/styles.xml'));
      assert.ok(styles.includes('<b/>'), '样式表应定义加粗字体');
    });
    const xlsxPath = join(root, 'sample.xlsx');
    await writeFile(xlsxPath, xlsxResult.data);

    console.log('\n[5] pptx');
    const pptxResult = await render('pptx', doc, { readImage });
    assertZipMagic(pptxResult.data);
    check('pptx 包内必需部件齐全', () => {
      const names = zipEntryNames(pptxResult.data);
      for (const part of [
        '[Content_Types].xml',
        '_rels/.rels',
        'ppt/presentation.xml',
        'ppt/_rels/presentation.xml.rels',
        'ppt/slideMasters/slideMaster1.xml',
        'ppt/slideMasters/_rels/slideMaster1.xml.rels',
        'ppt/slideLayouts/slideLayout1.xml',
        'ppt/theme/theme1.xml',
        'ppt/slides/slide1.xml',
        'ppt/slides/_rels/slide1.xml.rels',
      ]) {
        assert.ok(names.includes(part), `缺少部件 ${part}（现有：${names.join(', ')}）`);
      }
      assert.ok(names.some((name) => name.startsWith('ppt/media/image')), '缺少内嵌图片');
      assert.ok(names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length >= 2, '幻灯片数量不足');
    });
    check('pptx XML 含标题、图片引用与主题', () => {
      const slideNames = zipEntryNames(pptxResult.data).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
      const allSlides = slideNames.map((name) => decode(zipReadEntry(pptxResult.data, name))).join('\n');
      assert.ok(allSlides.includes('采文测试报告'));
      assert.ok(allSlides.includes('第一章 概述'));
      assert.ok(allSlides.includes('r:embed="rId2"'));
      const theme = decode(zipReadEntry(pptxResult.data, 'ppt/theme/theme1.xml'));
      assert.ok(theme.includes('<a:clrScheme'));
    });
    const pptxPath = join(root, 'sample.pptx');
    await writeFile(pptxPath, pptxResult.data);

    console.log('\n[6] 负向输入');
    await checkAsync('图片读取失败不影响生成', async () => {
      const { data } = await render('docx', doc, {
        readImage: async () => {
          throw new Error('模拟读取失败');
        },
      });
      assertZipMagic(data);
      assert.ok(!zipEntryNames(data).some((name) => name.startsWith('word/media/')));
    });
    await checkAsync('readImage 返回 null 时跳过图片', async () => {
      const { data } = await render('pptx', { ...doc, blocks: [{ type: 'image', src: 'none.png' }] }, {
        readImage: async () => null,
      });
      assertZipMagic(data);
    });

    console.log('\n[7] python 打开校验');
    if (PYTHON === '' || !existsSync(PYTHON)) {
      console.log('  已跳过：未设置 DSH_TEST_PYTHON（或路径不存在），不做 python 打开校验');
    } else {
      await checkAsync('python-docx 打开 docx 并读到标题/表格/图片', async () => {
        const output = await runPython(DOCX_SCRIPT, [docxPath], root, 'docx');
        assert.ok(output.includes('采文测试报告'), '读不到标题');
        assert.ok(output.includes('第一章 概述'), '读不到一级标题');
        assert.ok(output.includes('项目'), '读不到表格表头');
        assert.ok(output.includes('苹果'), '读不到表格数据');
        assert.ok(output.includes('图 1 示意图'), '读不到图片说明');
        assert.match(output, /INLINE_SHAPES=[1-9]/);
      });
      await checkAsync('openpyxl 打开 xlsx 并读到标题/表格/加粗表头', async () => {
        const output = await runPython(XLSX_SCRIPT, [xlsxPath], root, 'xlsx');
        assert.ok(output.includes('采文测试报告'), '读不到标题');
        assert.ok(output.includes('项目'), '读不到表头');
        assert.ok(output.includes('苹果'), '读不到表格数据');
        const bold = /BOLD=(.*)/.exec(output)?.[1] ?? '';
        assert.ok(bold.includes('项目'), `表头未加粗（BOLD=${bold.slice(0, 120)}）`);
      });
      await checkAsync('python-pptx 打开 pptx 并读到标题/正文/图片', async () => {
        const output = await runPython(PPTX_SCRIPT, [pptxPath], root, 'pptx');
        assert.match(output, /SLIDES=[1-9]/);
        assert.ok(output.includes('采文测试报告'), '读不到封面标题');
        assert.ok(output.includes('第一章 概述'), '读不到正文页标题');
        assert.ok(output.includes('苹果'), '读不到表格文本');
        assert.match(output, /PICTURES=[1-9]/);
      });
    }

    console.log('\n[8] PDF');
    if (PDF_CLI === '' || !existsSync(PDF_CLI)) {
      console.log('  已跳过：未设置 DSH_TEST_PDF_CLI，不做真实 PDF 转换');
      console.log('  提示：设置 DSH_TEST_PDF_NODE 与 DSH_TEST_PDF_CLI 可验证 LibreOffice 转换');
    } else {
      await checkAsync('真实转换：docx → pdf 并以 %PDF- 开头且含页对象', async () => {
        const converter = {
          kind: 'node-cli',
          node: PDF_NODE !== '' ? PDF_NODE : process.execPath,
          cli: PDF_CLI,
        };
        const result = await render('pdf', doc, { readImage, converter });
        assert.equal(result.ext, 'pdf');
        assert.equal(result.mime, 'application/pdf');
        assert.ok(result.data.length > 1000, `PDF 太小（${result.data.length} 字节）`);
        assert.equal(decode(result.data.subarray(0, 5)), '%PDF-');
        const text = Buffer.from(result.data).toString('latin1');
        const pageObjects = text.match(/\/Type\s*\/Page[^s]/g) ?? [];
        assert.ok(pageObjects.length >= 2, `PDF 页对象数量不足（${pageObjects.length}）`);
        assert.ok(result.note && result.note.includes('PDF'));
        const pdfPath = join(root, 'sample.pdf');
        await writeFile(pdfPath, result.data);
        console.log(`      PDF 大小：${result.data.length} 字节，页对象：${pageObjects.length}，说明：${result.note}`);
      });
    }

    console.log('\n[9] 仓库文件隐私检查（不得出现本机绝对路径）');
    await checkAsync('源码不含用户目录/盘符绝对路径', async () => {
      const files = [
        'lib/generate/index.js',
        'lib/generate/zip.js',
        'lib/generate/docx.js',
        'lib/generate/xlsx.js',
        'lib/generate/pptx.js',
        'lib/generate/text.js',
        'lib/generate/pdf.js',
      ];
      const base = new URL('..', import.meta.url);
      const home = homedir();
      let currentUser = '';
      try {
        currentUser = userInfo().username;
      } catch {
        currentUser = '';
      }
      for (const file of files) {
        const text = decode(await readFile(new URL(file, base)));
        assert.ok(!text.includes(home), `${file} 含本机家目录路径`);
        if (currentUser.length >= 3) assert.ok(!text.includes(currentUser), `${file} 含真实用户名`);
        assert.ok(!/[A-Za-z]:\\Users\\/i.test(text), `${file} 含用户目录绝对路径`);
      }
    });

    console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`);
    if (failures.length > 0) {
      console.error('\n失败明细：');
      for (const failure of failures) {
        console.error(`- ${failure.name}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`);
      }
      process.exitCode = 1;
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
