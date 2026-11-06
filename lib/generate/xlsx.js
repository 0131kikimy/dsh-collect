/**
 * XLSX（Excel）生成器：把 Doc 模型写成单个工作表的合法 OOXML 包。
 *
 * 版式约定（便于人类阅读，也便于自动化读取）：
 *   A1            文档标题（加粗、放大）
 *   A2/A3         副标题、来源与采集时间（灰色小字）
 *   之后按正文块顺序逐行展开：标题行加粗、列表项带符号、表格保留行列结构（表头加粗并带底纹）。
 *
 * 图片不会嵌入工作表（xlsx 图片需要额外的 drawing 部分），只保留一行"[图片]"文字说明。
 */

import { buildZip } from './zip.js';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

/** 单元格样式索引，与 styles.xml 中 cellXfs 的顺序一一对应。 */
const STYLE = {
  NORMAL: 0,
  HEADER: 1,
  TABLE_CELL: 2,
  TITLE: 3,
  META: 4,
  CODE: 5,
  SECTION: 6,
  BOLD: 7,
  BODY: 8,
};

/**
 * XML 文本转义，并剔除非法控制字符。
 * @param {unknown} value
 * @returns {string}
 */
function escapeXml(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 属性值转义。
 * @param {unknown} value
 * @returns {string}
 */
function escapeAttr(value) {
  return escapeXml(value).replace(/"/g, '&quot;');
}

/**
 * 列序号转 Excel 列名（0 → A，25 → Z，26 → AA）。
 * @param {number} index
 * @returns {string}
 */
function columnName(index) {
  let name = '';
  let value = index;
  do {
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return name;
}

/**
 * 生成一个单元格；字符串一律用 inlineStr，避免共享字符串表。
 * @param {string} address A1 形式的地址
 * @param {string | number} value
 * @param {number} styleIndex
 * @returns {string}
 */
function cellXml(address, value, styleIndex) {
  const style = styleIndex === STYLE.NORMAL ? '' : ` s="${styleIndex}"`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${address}"${style}><v>${value}</v></c>`;
  }
  const text = String(value ?? '');
  if (text === '') return `<c r="${address}"${style}/>`;
  return `<c r="${address}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

/**
 * 工作表名称净化：去掉 Excel 禁止的字符，最长 31 个字符。
 * @param {string} title
 * @returns {string}
 */
function sheetNameOf(title) {
  const cleaned = String(title ?? '')
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? '正文' : cleaned.slice(0, 31);
}

/** styles.xml：字体、填充、边框、单元格格式。 */
const STYLES_XML =
  XML_HEAD +
  `<styleSheet xmlns="${MAIN_NS}">` +
  '<fonts count="6">' +
  '<font><sz val="11"/><name val="Microsoft YaHei"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Microsoft YaHei"/><family val="2"/></font>' +
  '<font><b/><sz val="16"/><color rgb="FF1F3864"/><name val="Microsoft YaHei"/><family val="2"/></font>' +
  '<font><sz val="10"/><name val="Consolas"/><family val="1"/></font>' +
  '<font><sz val="10"/><color rgb="FF7F7F7F"/><name val="Microsoft YaHei"/><family val="2"/></font>' +
  '<font><b/><sz val="13"/><color rgb="FF2F5597"/><name val="Microsoft YaHei"/><family val="2"/></font>' +
  '</fonts>' +
  '<fills count="4">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F1"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF6F8FA"/><bgColor indexed="64"/></patternFill></fill>' +
  '</fills>' +
  '<borders count="2">' +
  '<border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left style="thin"><color rgb="FFA6A6A6"/></left><right style="thin"><color rgb="FFA6A6A6"/></right>' +
  '<top style="thin"><color rgb="FFA6A6A6"/></top><bottom style="thin"><color rgb="FFA6A6A6"/></bottom><diagonal/></border>' +
  '</borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="9">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
  '<alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">' +
  '<alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">' +
  '<alignment vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">' +
  '<alignment vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
  '<alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">' +
  '<alignment vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">' +
  '<alignment vertical="top" wrapText="1"/></xf>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** 根关系清单。 */
const ROOT_RELS =
  XML_HEAD +
  `<Relationships xmlns="${PKG_REL_NS}">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  '</Relationships>';

/**
 * 生成核心属性。
 * @param {string} title
 * @returns {string}
 */
function corePropertiesXml(title) {
  return (
    XML_HEAD +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:title>${escapeXml(title)}</dc:title><dc:creator>采文 · CollectKit</dc:creator>` +
    '</cp:coreProperties>'
  );
}

const APP_PROPERTIES =
  XML_HEAD +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
  '<Application>采文 · CollectKit</Application></Properties>';

/**
 * 生成 xlsx 字节。
 *
 * @param {import('./index.js').Doc} doc
 * @param {{ log?: (message: string) => void }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function renderXlsx(doc, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];
  const sheetName = sheetNameOf(doc?.title);

  /** @type {{ cells: { value: string | number, style: number }[], height?: number }[]} */
  const rows = [];
  const addRow = (cells, height) => {
    if (height !== undefined) rows.push({ cells, height });
    else rows.push({ cells });
  };
  const addTextRow = (text, style) => addRow([{ value: text, style }]);

  if (typeof doc?.title === 'string' && doc.title.trim() !== '') addRow([{ value: doc.title, style: STYLE.TITLE }], 26);
  if (typeof doc?.subtitle === 'string' && doc.subtitle.trim() !== '') addTextRow(doc.subtitle, STYLE.META);
  const metaParts = [];
  if (typeof doc?.sourceUrl === 'string' && doc.sourceUrl !== '') metaParts.push(`来源：${doc.sourceUrl}`);
  if (typeof doc?.collectedAt === 'string' && doc.collectedAt !== '') metaParts.push(`采集时间：${doc.collectedAt}`);
  if (metaParts.length > 0) addTextRow(metaParts.join('　·　'), STYLE.META);
  if (rows.length > 0) addRow([{ value: '', style: STYLE.NORMAL }]);

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'heading': {
        const text = String(block.text ?? '').trim();
        if (text === '') break;
        addTextRow(text, (Number(block.level) || 1) <= 1 ? STYLE.SECTION : STYLE.BOLD);
        break;
      }
      case 'paragraph':
        if (String(block.text ?? '').trim() !== '') addTextRow(String(block.text), STYLE.BODY);
        break;
      case 'quote':
        if (String(block.text ?? '').trim() !== '') addTextRow(`“${String(block.text)}”`, STYLE.BODY);
        break;
      case 'bullets':
        for (const item of Array.isArray(block.items) ? block.items : []) {
          const text = String(item ?? '');
          if (text.trim() !== '') addTextRow(`• ${text}`, STYLE.BODY);
        }
        break;
      case 'numbered': {
        let index = 0;
        for (const item of Array.isArray(block.items) ? block.items : []) {
          const text = String(item ?? '');
          if (text.trim() === '') continue;
          index += 1;
          addTextRow(`${index}. ${text}`, STYLE.BODY);
        }
        break;
      }
      case 'code':
        for (const line of String(block.text ?? '').split('\n')) addTextRow(line === '' ? ' ' : line, STYLE.CODE);
        break;
      case 'table': {
        const headers = Array.isArray(block.headers) ? block.headers.map((item) => String(item ?? '')) : [];
        const bodyRows = Array.isArray(block.rows) ? block.rows.filter((row) => Array.isArray(row)) : [];
        const columns = Math.max(1, headers.length, ...bodyRows.map((row) => row.length));
        if (headers.length > 0) {
          const cells = [];
          for (let index = 0; index < columns; index += 1) cells.push({ value: headers[index] ?? '', style: STYLE.HEADER });
          addRow(cells);
        }
        for (const row of bodyRows) {
          const cells = [];
          for (let index = 0; index < columns; index += 1) cells.push({ value: row[index] ?? '', style: STYLE.TABLE_CELL });
          addRow(cells);
        }
        addRow([{ value: '', style: STYLE.NORMAL }]);
        break;
      }
      case 'image': {
        const label = String(block.caption ?? block.alt ?? block.src ?? '').trim();
        addTextRow(`[图片] ${label}`, STYLE.META);
        break;
      }
      case 'pagebreak':
        addRow([{ value: '', style: STYLE.NORMAL }]);
        break;
      default:
        log(`未知的正文块类型，已忽略：${String(block.type)}`);
        break;
    }
  }

  if (rows.length === 0) addRow([{ value: '', style: STYLE.NORMAL }]);

  const sheetRows = rows
    .map((row, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const cells = row.cells
        .map((cell, columnIndex) => cellXml(`${columnName(columnIndex)}${rowNumber}`, cell.value, cell.style))
        .join('');
      const height = row.height === undefined ? '' : ` ht="${row.height}" customHeight="1"`;
      return `<row r="${rowNumber}"${height}>${cells}</row>`;
    })
    .join('');

  const maxColumns = Math.max(1, ...rows.map((row) => row.cells.length));
  const dimension = `A1:${columnName(maxColumns - 1)}${rows.length}`;
  const worksheet =
    XML_HEAD +
    `<worksheet xmlns="${MAIN_NS}">` +
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    `<dimension ref="${dimension}"/>` +
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="16"/>' +
    '<cols><col min="1" max="1" width="52" customWidth="1"/><col min="2" max="8" width="22" customWidth="1"/></cols>' +
    `<sheetData>${sheetRows}</sheetData>` +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    '<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>' +
    '</worksheet>';

  const workbook =
    XML_HEAD +
    `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    '<bookViews><workbookView/></bookViews>' +
    `<sheets><sheet name="${escapeAttr(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>';

  const workbookRels =
    XML_HEAD +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  const contentTypes =
    XML_HEAD +
    `<Types xmlns="${CT_NS}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';

  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: STYLES_XML },
    { name: 'xl/worksheets/sheet1.xml', data: worksheet },
    { name: 'docProps/core.xml', data: corePropertiesXml(typeof doc?.title === 'string' ? doc.title : '') },
    { name: 'docProps/app.xml', data: APP_PROPERTIES },
  ]);
}
