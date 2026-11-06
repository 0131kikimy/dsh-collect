/**
 * DOCX（Word）生成器：把 Doc 模型写成合法的 OOXML 包。
 *
 * 包内结构：
 *   [Content_Types].xml、_rels/.rels、word/document.xml、
 *   word/_rels/document.xml.rels、word/styles.xml、word/numbering.xml、
 *   以及按需出现的 word/media/imageN.{png|jpeg|gif}。
 *
 * 图片字节由 options.readImage(src) 提供；读不到或格式不支持时跳过该图，整体不失败。
 */

import { buildZip } from './zip.js';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const WP_NS = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const PIC_NS = 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

/** 图片 MIME 到包内扩展名的映射（只收录 Word 能稳定显示的格式）。 */
const IMAGE_EXTENSIONS = {
  'image/png': { ext: 'png', contentType: 'image/png' },
  'image/jpeg': { ext: 'jpeg', contentType: 'image/jpeg' },
  'image/jpg': { ext: 'jpeg', contentType: 'image/jpeg' },
  'image/gif': { ext: 'gif', contentType: 'image/gif' },
};

/** 页面尺寸（A4，单位 twip：1/1440 英寸）与页边距。 */
const SECTION_XML =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1418" w:bottom="1440" w:left="1418" w:header="851" w:footer="992" w:gutter="0"/>' +
  '</w:sectPr>';

/** 段落属性预置。 */
const TITLE_PARAGRAPH = '<w:pPr><w:pStyle w:val="Title"/></w:pPr>';
const SUBTITLE_PARAGRAPH = '<w:pPr><w:pStyle w:val="Subtitle"/></w:pPr>';
const META_PARAGRAPH = '<w:pPr><w:pStyle w:val="Meta"/></w:pPr>';
const CAPTION_PARAGRAPH = '<w:pPr><w:pStyle w:val="Caption"/></w:pPr>';
const QUOTE_PARAGRAPH = '<w:pPr><w:pStyle w:val="Quote"/></w:pPr>';
const CODE_PARAGRAPH = '<w:pPr><w:pStyle w:val="Code"/></w:pPr>';
const BULLET_PARAGRAPH = '<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>';
const NUMBER_PARAGRAPH = '<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr>';

/**
 * XML 文本转义，并剔除 XML 1.0 不允许出现的控制字符。
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
 * XML 属性值转义（在文本转义基础上再转义引号）。
 * @param {unknown} value
 * @returns {string}
 */
function escapeAttr(value) {
  return escapeXml(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * 把文本拆成若干 run：换行用 <w:br/> 表示，保证多行内容在 Word 里也是多行。
 * @param {string} text
 * @param {string} [runProperties] 可选的 <w:rPr> 片段
 * @returns {string}
 */
function textRuns(text, runProperties = '') {
  const lines = String(text ?? '').split('\n');
  const runs = [];
  lines.forEach((line, index) => {
    if (index > 0) runs.push('<w:r><w:br/></w:r>');
    if (line !== '') {
      runs.push(`<w:r>${runProperties}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`);
    }
  });
  return runs.join('');
}

/**
 * 生成一个段落。
 * @param {string} text
 * @param {string} [paragraphProperties]
 * @returns {string}
 */
function paragraphXml(text, paragraphProperties = '') {
  return `<w:p>${paragraphProperties}${textRuns(text)}</w:p>`;
}

/**
 * 生成一个标题段落。
 * @param {string} text
 * @param {number} level 1..3
 * @returns {string}
 */
function headingXml(text, level) {
  const safeLevel = Math.min(3, Math.max(1, Number(level) || 1));
  return `<w:p><w:pPr><w:pStyle w:val="Heading${safeLevel}"/></w:pPr>${textRuns(text)}</w:p>`;
}

/**
 * 生成一个表格；表头加粗并带浅色底纹，列宽按百分比均分。
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {string}
 */
function tableXml(headers, rows) {
  const headerCells = Array.isArray(headers) ? headers.map((header) => String(header ?? '')) : [];
  const bodyRows = Array.isArray(rows) ? rows.filter((row) => Array.isArray(row)) : [];
  const columns = Math.max(1, headerCells.length, ...bodyRows.map((row) => row.length));
  const cellWidthPct = Math.max(1, Math.floor(5000 / columns));
  const cell = (value, options) => {
    const shading = options && options.header ? '<w:shd w:val="clear" w:color="auto" w:fill="DCE6F1"/>' : '';
    const bold = options && options.header ? '<w:b/>' : '';
    return (
      `<w:tc><w:tcPr><w:tcW w:w="${cellWidthPct}" w:type="pct"/>${shading}</w:tcPr>` +
      `<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>` +
      `<w:r><w:rPr>${bold}</w:rPr><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:p></w:tc>`
    );
  };
  const headerRow = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${headerCells.map((value) => cell(value, { header: true })).join('')}</w:tr>`;
  const dataRows = bodyRows.map((row) => {
    const cells = [];
    for (let index = 0; index < columns; index += 1) cells.push(cell(row[index] ?? ''));
    return `<w:tr>${cells.join('')}</w:tr>`;
  });
  const borders =
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>`)
      .join('') +
    '</w:tblBorders>';
  return (
    '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/>' +
    borders +
    '</w:tblPr><w:tblGrid>' +
    Array.from({ length: columns }, () => `<w:gridCol w:w="${Math.floor(9000 / columns)}"/>`).join('') +
    '</w:tblGrid>' +
    headerRow +
    dataRows.join('') +
    '</w:tbl><w:p/>'
  );
}

/**
 * 识别图片 MIME，必要时用魔数兜底。
 * @param {{ mime?: string, buffer: Uint8Array }} data
 * @returns {{ ext: string, contentType: string } | null}
 */
function imageFormatOf(data) {
  const declared = String(data.mime ?? '').toLowerCase().split(';')[0].trim();
  if (IMAGE_EXTENSIONS[declared]) return IMAGE_EXTENSIONS[declared];
  const bytes = data.buffer;
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return IMAGE_EXTENSIONS['image/png'];
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return IMAGE_EXTENSIONS['image/jpeg'];
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return IMAGE_EXTENSIONS['image/gif'];
  }
  return null;
}

/**
 * 把图片像素尺寸换算成控制在 6×8 英寸内的 EMU 尺寸。
 * @param {{ width?: number, height?: number }} data
 * @returns {{ cx: number, cy: number }}
 */
function imageExtent(data) {
  const emuPerInch = 914400;
  const pixelWidth = Number(data.width);
  const pixelHeight = Number(data.height);
  let widthIn = pixelWidth > 0 ? pixelWidth / 96 : 3;
  let heightIn = pixelHeight > 0 ? pixelHeight / 96 : 2;
  if (!(widthIn > 0)) widthIn = 3;
  if (!(heightIn > 0)) heightIn = 2;
  const maxWidth = 6;
  const maxHeight = 8;
  if (widthIn > maxWidth) {
    heightIn *= maxWidth / widthIn;
    widthIn = maxWidth;
  }
  if (heightIn > maxHeight) {
    widthIn *= maxHeight / heightIn;
    heightIn = maxHeight;
  }
  return { cx: Math.round(widthIn * emuPerInch), cy: Math.round(heightIn * emuPerInch) };
}

/**
 * 生成内嵌图片段落（DrawingML inline）。
 * @param {string} relId 关系 id
 * @param {{ ext: string }} format
 * @param {{ width?: number, height?: number }} data
 * @param {string} altText
 * @param {number} shapeId
 * @returns {string}
 */
function imageParagraphXml(relId, format, data, altText, shapeId) {
  const { cx, cy } = imageExtent(data);
  const description = escapeAttr(altText || '');
  return (
    '<w:p><w:pPr><w:spacing w:before="120" w:after="60"/><w:jc w:val="center"/></w:pPr>' +
    '<w:r><w:drawing>' +
    '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${shapeId}" name="图片 ${shapeId}" descr="${description}"/>` +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic><pic:nvPicPr>' +
    `<pic:cNvPr id="${shapeId}" name="image${shapeId}.${format.ext}"/>` +
    '<pic:cNvPicPr/></pic:nvPicPr>' +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/>' +
    `<a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
  );
}

/**
 * 读取一张图片；任何异常或返回空都视为"跳过这张图"。
 * @param {(src: string) => Promise<unknown>} readImage
 * @param {string} src
 * @param {(message: string) => void} log
 * @returns {Promise<{ buffer: Uint8Array, mime: string, width: number, height: number } | null>}
 */
async function readImageSafe(readImage, src, log) {
  if (typeof src !== 'string' || src === '') return null;
  let value;
  try {
    value = await readImage(src);
  } catch (error) {
    log(`读取图片失败，已跳过：${src}（${error instanceof Error ? error.message : String(error)}）`);
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const buffer = value.buffer instanceof Uint8Array ? value.buffer : null;
  if (!buffer || buffer.length === 0) {
    log(`图片内容为空，已跳过：${src}`);
    return null;
  }
  return {
    buffer,
    mime: typeof value.mime === 'string' ? value.mime : '',
    width: Number(value.width) || 0,
    height: Number(value.height) || 0,
  };
}

/** 文档级默认样式：正文、标题、副标题、引用、代码、列表、表格。 */
const STYLES_XML =
  XML_HEAD +
  `<w:styles ${W_NS}>` +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei" w:cs="Calibri"/>' +
  '<w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/>' +
  '</w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
  '</w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:before="240" w:after="120"/><w:jc w:val="center"/></w:pPr>' +
  '<w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:after="80"/><w:jc w:val="center"/></w:pPr>' +
  '<w:rPr><w:color w:val="595959"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Meta"><w:name w:val="Meta"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
  '<w:pPr><w:spacing w:after="200"/><w:jc w:val="center"/></w:pPr>' +
  '<w:rPr><w:color w:val="7F7F7F"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>' +
  '<w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="260" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr>' +
  '<w:rPr><w:b/><w:color w:val="2F5597"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="Heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="220" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr>' +
  '<w:rPr><w:b/><w:color w:val="2F5597"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="8FAADC"/></w:pBdr><w:ind w:left="360"/><w:spacing w:before="100" w:after="140"/></w:pPr>' +
  '<w:rPr><w:i/><w:color w:val="404040"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
  '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/><w:ind w:left="120" w:right="120"/><w:spacing w:before="60" w:after="60" w:line="240" w:lineRule="auto"/></w:pPr>' +
  '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei" w:cs="Consolas"/><w:sz w:val="18"/><w:szCs w:val="18"/><w:color w:val="24292F"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:spacing w:after="60"/><w:ind w:left="480"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
  '<w:pPr><w:spacing w:before="40" w:after="160"/><w:jc w:val="center"/></w:pPr>' +
  '<w:rPr><w:i/><w:color w:val="7F7F7F"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>' +
  '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr>' +
  '<w:tblBorders>' +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>`)
    .join('') +
  '</w:tblBorders></w:tblPr></w:style>' +
  '</w:styles>';

/**
 * 生成一个 abstractNum（多级列表定义）。
 * @param {number} abstractId
 * @param {'bullet' | 'decimal'} format
 * @param {string[]} levelTexts
 * @param {string} [font]
 * @returns {string}
 */
function abstractNumberingXml(abstractId, format, levelTexts, font) {
  const levels = levelTexts
    .map((text, level) => {
      const runProperties =
        format === 'bullet' && font
          ? `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:hint="default"/><w:color w:val="2F5597"/></w:rPr>`
          : '';
      return (
        `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>` +
        `<w:lvlText w:val="${escapeAttr(text)}"/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr>${runProperties}</w:lvl>`
      );
    })
    .join('');
  return `<w:abstractNum w:abstractNumId="${abstractId}"><w:multiLevelType w:val="hybridMultilevel"/>${levels}</w:abstractNum>`;
}

/** 项目符号与编号列表定义：numId=1 项目符号，numId=2 阿拉伯数字。 */
const NUMBERING_XML =
  XML_HEAD +
  `<w:numbering ${W_NS}>` +
  abstractNumberingXml(0, 'bullet', ['\u2022', '\u25e6', '\u25aa'], 'Arial') +
  abstractNumberingXml(1, 'decimal', ['%1.', '%2.', '%3.']) +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
  '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
  '</w:numbering>';

/** 根关系：文档主体 + 核心属性 + 扩展属性。 */
const ROOT_RELS_XML =
  XML_HEAD +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  '</Relationships>';

/**
 * 生成 docProps/core.xml。
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

/** 生成 docProps/app.xml。 */
const APP_PROPERTIES_XML =
  XML_HEAD +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
  '<Application>采文 · CollectKit</Application></Properties>';

/**
 * 生成内容类型清单；图片扩展名按实际使用情况登记。
 * @param {string[]} imageExtensions
 * @returns {string}
 */
function contentTypesXml(imageExtensions) {
  const defaults = imageExtensions
    .map((ext) => `<Default Extension="${ext}" ContentType="${IMAGE_EXTENSIONS[`image/${ext === 'jpeg' ? 'jpeg' : ext}`]?.contentType ?? 'image/png'}"/>`)
    .join('');
  return (
    XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    defaults +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>'
  );
}

/**
 * 生成文档关系清单（样式、编号，以及按需的图片）。
 * @param {{ partName: string }[]} media
 * @returns {string}
 */
function documentRelationshipsXml(media) {
  const images = media
    .map((item, index) => {
      const target = item.partName.replace(/^word\//, '');
      return `<Relationship Id="rId${index + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${escapeAttr(target)}"/>`;
    })
    .join('');
  return (
    XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
    images +
    '</Relationships>'
  );
}

/**
 * 生成 docx 字节。
 *
 * @param {import('./index.js').Doc} doc
 * @param {{ readImage?: (src: string) => Promise<unknown>, log?: (message: string) => void }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function renderDocx(doc, options = {}) {
  const readImage = typeof options.readImage === 'function' ? options.readImage : async () => null;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];
  const body = [];
  /** @type {{ partName: string, ext: string, contentType: string, buffer: Uint8Array }[]} */
  const media = [];
  let shapeId = 0;

  if (typeof doc?.title === 'string' && doc.title.trim() !== '') body.push(paragraphXml(doc.title, TITLE_PARAGRAPH));
  if (typeof doc?.subtitle === 'string' && doc.subtitle.trim() !== '') body.push(paragraphXml(doc.subtitle, SUBTITLE_PARAGRAPH));
  const metaParts = [];
  if (typeof doc?.sourceUrl === 'string' && doc.sourceUrl !== '') metaParts.push(`来源：${doc.sourceUrl}`);
  if (typeof doc?.collectedAt === 'string' && doc.collectedAt !== '') metaParts.push(`采集时间：${doc.collectedAt}`);
  if (metaParts.length > 0) body.push(paragraphXml(metaParts.join('　·　'), META_PARAGRAPH));

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'heading':
        if (typeof block.text === 'string' && block.text.trim() !== '') body.push(headingXml(block.text, block.level));
        break;
      case 'paragraph':
        if (typeof block.text === 'string' && block.text.trim() !== '') body.push(paragraphXml(block.text));
        break;
      case 'quote':
        if (typeof block.text === 'string' && block.text.trim() !== '') body.push(paragraphXml(block.text, QUOTE_PARAGRAPH));
        break;
      case 'bullets':
        for (const item of Array.isArray(block.items) ? block.items : []) {
          if (String(item ?? '').trim() !== '') body.push(paragraphXml(String(item), BULLET_PARAGRAPH));
        }
        break;
      case 'numbered':
        for (const item of Array.isArray(block.items) ? block.items : []) {
          if (String(item ?? '').trim() !== '') body.push(paragraphXml(String(item), NUMBER_PARAGRAPH));
        }
        break;
      case 'code':
        if (typeof block.text === 'string' && block.text !== '') body.push(paragraphXml(block.text, CODE_PARAGRAPH));
        break;
      case 'table':
        body.push(tableXml(block.headers, block.rows));
        break;
      case 'image': {
        const data = await readImageSafe(readImage, block.src, log);
        if (!data) break;
        const format = imageFormatOf(data);
        if (!format) {
          log(`暂不支持该图片格式，已跳过：${block.src}`);
          break;
        }
        shapeId += 1;
        const partName = `word/media/image${media.length + 1}.${format.ext}`;
        const relId = `rId${media.length + 3}`;
        media.push({ partName, ext: format.ext, contentType: format.contentType, buffer: data.buffer });
        body.push(imageParagraphXml(relId, format, data, block.alt ?? '', shapeId));
        if (typeof block.caption === 'string' && block.caption.trim() !== '') {
          body.push(paragraphXml(block.caption, CAPTION_PARAGRAPH));
        }
        break;
      }
      case 'pagebreak':
        body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
        break;
      default:
        log(`未知的正文块类型，已忽略：${String(block.type)}`);
        break;
    }
  }

  const documentXml =
    XML_HEAD +
    `<w:document ${W_NS} ${R_NS} ${WP_NS} ${A_NS} ${PIC_NS}>` +
    `<w:body>${body.join('')}${SECTION_XML}</w:body></w:document>`;

  const imageExtensions = [...new Set(media.map((item) => item.ext))];
  const parts = [
    { name: '[Content_Types].xml', data: contentTypesXml(imageExtensions) },
    { name: '_rels/.rels', data: ROOT_RELS_XML },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: documentRelationshipsXml(media) },
    { name: 'word/styles.xml', data: STYLES_XML },
    { name: 'word/numbering.xml', data: NUMBERING_XML },
    { name: 'docProps/core.xml', data: corePropertiesXml(typeof doc?.title === 'string' ? doc.title : '') },
    { name: 'docProps/app.xml', data: APP_PROPERTIES_XML },
  ];
  for (const item of media) parts.push({ name: item.partName, data: item.buffer });

  return buildZip(parts);
}
