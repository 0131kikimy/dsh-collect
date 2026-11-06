/**
 * PPTX（PowerPoint）生成器：把 Doc 模型写成合法的 OOXML 演示文稿。
 *
 * 版式策略：
 * - 有标题时生成一页封面（标题 + 副标题/来源）；
 * - 正文按二级及以上标题分页，每页标题取自标题文字，正文条目过多时自动续页；
 * - 每张图片单独成页并按比例缩放居中，使用 DrawingML（p:pic + a:blip r:embed）内嵌；
 * - 表格在正文里按"表头 | 单元格"的文本行展开（演示文稿不建表对象）。
 *
 * 图片字节由 options.readImage(src) 提供；读不到或格式不支持时跳过该图，整体不失败。
 */

import { buildZip } from './zip.js';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const PKG_REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const CT_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/content-types"';

/** 16:9 画布尺寸（EMU：1 英寸 = 914400）。 */
const SLIDE_CX = 12192000;
const SLIDE_CY = 6858000;
const EMU_PER_INCH = 914400;

/** 正文条目上限，超过则自动续页。 */
const MAX_BODY_ITEMS = 12;

/** 图片 MIME 到包内扩展名的映射。 */
const IMAGE_EXTENSIONS = {
  'image/png': { ext: 'png', contentType: 'image/png' },
  'image/jpeg': { ext: 'jpeg', contentType: 'image/jpeg' },
  'image/jpg': { ext: 'jpeg', contentType: 'image/jpeg' },
  'image/gif': { ext: 'gif', contentType: 'image/gif' },
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
  return escapeXml(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * 组合形状树。
 * @param {string} children
 * @returns {string}
 */
function shapeTree(children) {
  return (
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    children +
    '</p:spTree>'
  );
}

/**
 * 文本 run（统一处理字号、加粗、颜色、斜体、等宽字体）。
 * @param {string} text
 * @param {{ size?: number, bold?: boolean, italic?: boolean, color?: string, mono?: boolean }} [style]
 * @returns {string}
 */
function runXml(text, style = {}) {
  const attributes = [`lang="zh-CN"`, `sz="${style.size ?? 1800}"`, 'dirty="0"'];
  if (style.bold) attributes.push('b="1"');
  if (style.italic) attributes.push('i="1"');
  const fill = style.color ? `<a:solidFill><a:srgbClr val="${style.color}"/></a:solidFill>` : '';
  const fonts = style.mono ? '<a:latin typeface="Consolas"/><a:cs typeface="Consolas"/>' : '';
  const runProperties = `<a:rPr ${attributes.join(' ')}>${fill}${fonts}</a:rPr>`;
  return `<a:r>${runProperties}<a:t xml:space="preserve">${escapeXml(text)}</a:t></a:r>`;
}

/**
 * 正文段落（含项目符号与编号）。
 * @param {{ kind: string, text: string }} item
 * @returns {string}
 */
function bodyParagraphXml(item) {
  switch (item.kind) {
    case 'h3':
      return `<a:p><a:pPr><a:spcBef><a:spcPts val="600"/></a:spcBef></a:pPr>${runXml(item.text, { size: 2000, bold: true, color: '2F5597' })}</a:p>`;
    case 'quote':
      return `<a:p><a:pPr marL="285750" indent="-285750"><a:lnSpc><a:spcPct val="110000"/></a:lnSpc></a:pPr>${runXml(item.text, { size: 1700, italic: true, color: '595959' })}</a:p>`;
    case 'code':
      return `<a:p><a:pPr><a:spcBef><a:spcPts val="200"/></a:spcBef></a:pPr>${runXml(item.text, { size: 1300, mono: true, color: '24292F' })}</a:p>`;
    case 'tableHead':
      return `<a:p>${runXml(item.text, { size: 1400, bold: true, color: '1F3864' })}</a:p>`;
    case 'tableRow':
      return `<a:p>${runXml(item.text, { size: 1400 })}</a:p>`;
    case 'bullet':
      return (
        '<a:p><a:pPr marL="285750" indent="-285750">' +
        '<a:buFont typeface="Arial" pitchFamily="34" charset="0"/>' +
        '<a:buChar char="\u2022"/></a:pPr>' +
        runXml(item.text) +
        '</a:p>'
      );
    case 'number':
      return (
        '<a:p><a:pPr marL="285750" indent="-285750">' +
        '<a:buFont typeface="Arial" pitchFamily="34" charset="0"/>' +
        '<a:buAutoNum type="arabicPeriod"/></a:pPr>' +
        runXml(item.text) +
        '</a:p>'
      );
    case 'p':
    default:
      return `<a:p><a:pPr><a:spcBef><a:spcPts val="200"/></a:spcBef></a:pPr>${runXml(item.text)}</a:p>`;
  }
}

/**
 * 文本框形状。
 * @param {number} id 形状 id（页内唯一）
 * @param {string} name 形状名
 * @param {number} x 左上角 x（EMU）
 * @param {number} y 左上角 y（EMU）
 * @param {number} cx 宽（EMU）
 * @param {number} cy 高（EMU）
 * @param {string} paragraphs
 * @param {{ anchor?: 't' | 'ctr' | 'b' }} [options]
 * @returns {string}
 */
function textBoxXml(id, name, x, y, cx, cy, paragraphs, options = {}) {
  const anchor = options.anchor ?? 't';
  return (
    '<p:sp><p:nvSpPr>' +
    `<p:cNvPr id="${id}" name="${escapeAttr(name)}"/>` +
    '<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm>' +
    `<a:off x="${Math.round(x)}" y="${Math.round(y)}"/>` +
    `<a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    `<p:txBody><a:bodyPr wrap="square" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
  );
}

/**
 * 图片形状（DrawingML inline 图）。
 * @param {number} id 形状 id
 * @param {string} relId 关系 id
 * @param {number} x
 * @param {number} y
 * @param {number} cx
 * @param {number} cy
 * @param {string} altText
 * @returns {string}
 */
function pictureXml(id, relId, x, y, cx, cy, altText) {
  return (
    '<p:pic><p:nvPicPr>' +
    `<p:cNvPr id="${id}" name="图片 ${id}" descr="${escapeAttr(altText)}"/>` +
    '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
    `<p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/>` +
    `<a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
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
 * 读取图片；任何异常或空返回都视为"跳过"。
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

/** 主题：配色、字体、格式方案，Office 与 LibreOffice 都能接受的最小完整形态。 */
const THEME_XML =
  XML_HEAD +
  `<a:theme ${A_NS} name="CollectKit"><a:themeElements>` +
  '<a:clrScheme name="CollectKit">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="1F3864"/></a:dk2>' +
  '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="2F5597"/></a:accent1>' +
  '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>' +
  '<a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>' +
  '<a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
  '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
  '<a:fontScheme name="CollectKit"><a:majorFont><a:latin typeface="Calibri Light"/>' +
  '<a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="Microsoft YaHei"/>' +
  '<a:cs typeface=""/></a:minorFont></a:fontScheme>' +
  '<a:fmtScheme name="CollectKit">' +
  '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr">' +
  '<a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs>' +
  '<a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/>' +
  '<a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst>' +
  '<a:lin ang="5400000" scaled="0"/></a:gradFill>' +
  '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr">' +
  '<a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs>' +
  '<a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/>' +
  '<a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst>' +
  '<a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst>' +
  '<a:lnStyleLst>' +
  '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '</a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/>' +
  '</a:schemeClr></a:solidFill>' +
  '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr">' +
  '<a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/>' +
  '</a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr">' +
  '<a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/>' +
  '</a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>' +
  '</a:bgFillStyleLst></a:fmtScheme></a:themeElements>' +
  '<a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

/** 幻灯片母版：空白母版，只提供默认字号层级，具体排版由每页文本框决定。 */
const SLIDE_MASTER_XML =
  XML_HEAD +
  `<p:sldMaster ${A_NS} ${R_NS} ${P_NS}><p:cSld name="采文母版">${shapeTree('')}</p:cSld>` +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
  'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" ' +
  'hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle>' +
  '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr></p:bodyStyle>' +
  '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles>' +
  '</p:sldMaster>';

const SLIDE_LAYOUT_XML =
  XML_HEAD +
  `<p:sldLayout ${A_NS} ${R_NS} ${P_NS} type="blank" preserve="1">` +
  `<p:cSld name="空白">${shapeTree('')}</p:cSld>` +
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

const MASTER_RELS_XML =
  XML_HEAD +
  `<Relationships ${PKG_REL_NS}>` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
  '</Relationships>';

const LAYOUT_RELS_XML =
  XML_HEAD +
  `<Relationships ${PKG_REL_NS}>` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
  '</Relationships>';

/**
 * 生成某个文本框的标题/正文段落。
 * @param {string} text
 * @param {{ size?: number, bold?: boolean, color?: string, anchor?: 'ctr' }} [options]
 * @returns {string}
 */
function simpleParagraphXml(text, options = {}) {
  const alignment = options.anchor === 'ctr' ? '<a:pPr algn="ctr"/>' : '<a:pPr/>';
  return `<a:p>${alignment}${runXml(text, { size: options.size, bold: options.bold, color: options.color })}</a:p>`;
}

/**
 * 生成一页幻灯片。
 * @param {object} slide 内部页面模型
 * @param {{ images: Map<string, { data: object, partName: string }> }} context 已解析的图片表（键为 image-块序号）
 * @returns {{ xml: string, rels: string }}
 */
function slidePartsOf(slide, context) {
  const shapes = [];
  let relId = 2; // rId1 固定指向版式
  /** @type {{ relId: string, partName: string }[]} */
  const imageRelationships = [];

  if (slide.kind === 'title') {
    shapes.push(
      textBoxXml(
        2,
        '标题',
        EMU_PER_INCH * 0.8,
        EMU_PER_INCH * 2.1,
        SLIDE_CX - EMU_PER_INCH * 1.6,
        EMU_PER_INCH * 1.7,
        simpleParagraphXml(slide.title, { size: 4000, bold: true, color: '1F3864', anchor: 'ctr' }),
        { anchor: 'ctr' },
      ),
    );
    if (slide.subtitle) {
      shapes.push(
        textBoxXml(
          3,
          '副标题',
          EMU_PER_INCH * 0.9,
          EMU_PER_INCH * 4.0,
          SLIDE_CX - EMU_PER_INCH * 1.8,
          EMU_PER_INCH * 2.2,
          slide.subtitle
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => simpleParagraphXml(line, { size: 1800, color: '595959', anchor: 'ctr' }))
            .join(''),
          { anchor: 'ctr' },
        ),
      );
    }
  } else if (slide.kind === 'image') {
    shapes.push(
      textBoxXml(
        2,
        '标题',
        EMU_PER_INCH * 0.6,
        EMU_PER_INCH * 0.3,
        SLIDE_CX - EMU_PER_INCH * 1.2,
        EMU_PER_INCH * 0.8,
        simpleParagraphXml(slide.title, { size: 2400, bold: true, color: '1F3864' }),
      ),
    );
    const image = context.images.get(slide.imageKey);
    if (image) {
      const { cx, cy } = fitImage(image.data);
      const x = Math.max(0, Math.round((SLIDE_CX - cx) / 2));
      const y = Math.round(EMU_PER_INCH * 1.3);
      const relIdForImage = `rId${relId}`;
      imageRelationships.push({ relId: relIdForImage, partName: image.partName });
      shapes.push(pictureXml(3, relIdForImage, x, y, cx, cy, slide.alt ?? ''));
      relId += 1;
      // 只有当说明文字与页标题不同时才单独加一行，避免同一句话出现两遍。
      if (slide.caption && slide.caption !== slide.title) {
        shapes.push(
          textBoxXml(
            4,
            '图片说明',
            EMU_PER_INCH * 0.8,
            y + cy + EMU_PER_INCH * 0.08,
            SLIDE_CX - EMU_PER_INCH * 1.6,
            EMU_PER_INCH * 0.4,
            simpleParagraphXml(slide.caption, { size: 1200, color: '7F7F7F', anchor: 'ctr' }),
            { anchor: 'ctr' },
          ),
        );
      }
    }
  } else {
    shapes.push(
      textBoxXml(
        2,
        '标题',
        EMU_PER_INCH * 0.6,
        EMU_PER_INCH * 0.3,
        SLIDE_CX - EMU_PER_INCH * 1.2,
        EMU_PER_INCH * 0.85,
        simpleParagraphXml(slide.title, { size: 2800, bold: true, color: '1F3864' }),
      ),
    );
    shapes.push(
      textBoxXml(
        3,
        '正文',
        EMU_PER_INCH * 0.7,
        EMU_PER_INCH * 1.35,
        SLIDE_CX - EMU_PER_INCH * 1.4,
        SLIDE_CY - EMU_PER_INCH * 1.75,
        slide.body.map((item) => bodyParagraphXml(item)).join(''),
      ),
    );
  }

  const slideXml =
    XML_HEAD +
    `<p:sld ${A_NS} ${R_NS} ${P_NS}><p:cSld>${shapeTree(shapes.join(''))}</p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';

  const imageXml = imageRelationships
    .map(
      (item) =>
        `<Relationship Id="${item.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${escapeAttr(item.partName)}"/>`,
    )
    .join('');
  const slideRels =
    XML_HEAD +
    `<Relationships ${PKG_REL_NS}>` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    imageXml +
    '</Relationships>';

  return { xml: slideXml, rels: slideRels };
}

/**
 * 把图片尺寸限制在 8×4.8 英寸内并保持比例。
 * @param {{ width?: number, height?: number }} data
 * @returns {{ cx: number, cy: number }}
 */
function fitImage(data) {
  const pixelWidth = Number(data.width);
  const pixelHeight = Number(data.height);
  let widthIn = pixelWidth > 0 ? pixelWidth / 96 : 4;
  let heightIn = pixelHeight > 0 ? pixelHeight / 96 : 3;
  if (!(widthIn > 0)) widthIn = 4;
  if (!(heightIn > 0)) heightIn = 3;
  const maxWidth = 8;
  const maxHeight = 4.8;
  if (widthIn > maxWidth) {
    heightIn *= maxWidth / widthIn;
    widthIn = maxWidth;
  }
  if (heightIn > maxHeight) {
    widthIn *= maxHeight / heightIn;
    heightIn = maxHeight;
  }
  return { cx: Math.round(widthIn * EMU_PER_INCH), cy: Math.round(heightIn * EMU_PER_INCH) };
}

/**
 * 生成 pptx 字节。
 *
 * @param {import('./index.js').Doc} doc
 * @param {{ readImage?: (src: string) => Promise<unknown>, log?: (message: string) => void }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function renderPptx(doc, options = {}) {
  const readImage = typeof options.readImage === 'function' ? options.readImage : async () => null;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];

  /** @type {Map<number, { data: object, format: { ext: string, contentType: string }, partName: string }>} */
  const resolvedImages = new Map();
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block || block.type !== 'image') continue;
    const data = await readImageSafe(readImage, block.src, log);
    if (!data) continue;
    const format = imageFormatOf(data);
    if (!format) {
      log(`暂不支持该图片格式，已跳过：${block.src}`);
      continue;
    }
    resolvedImages.set(index, { data, format, partName: '' });
  }

  /** @type {{ kind: 'title', title: string, subtitle: string } | { kind: 'content', title: string, body: { kind: string, text: string }[] } | { kind: 'image', title: string, imageKey: string, alt: string, caption: string }} */
  const slides = [];
  const metaParts = [];
  if (typeof doc?.subtitle === 'string' && doc.subtitle.trim() !== '') metaParts.push(doc.subtitle);
  if (typeof doc?.sourceUrl === 'string' && doc.sourceUrl !== '') metaParts.push(`来源：${doc.sourceUrl}`);
  if (typeof doc?.collectedAt === 'string' && doc.collectedAt !== '') metaParts.push(`采集时间：${doc.collectedAt}`);

  const hasCover = typeof doc?.title === 'string' && doc.title.trim() !== '';
  /** 没有标题页时的正文页兜底标题。 */
  const fallbackTitle = hasCover ? '正文' : '采文文档';

  if (hasCover) {
    slides.push({ kind: 'title', title: doc.title, subtitle: metaParts.join('\n') });
  }

  /** @type {{ kind: 'content', title: string, body: { kind: string, text: string }[] } | null} */
  let current = null;
  const flush = () => {
    if (current && (current.body.length > 0 || current.title !== '')) slides.push(current);
    current = null;
  };
  const ensureCurrent = () => {
    if (!current) {
      current = { kind: 'content', title: fallbackTitle, body: [] };
    }
    return current;
  };
  const pushBody = (item) => {
    let slide = ensureCurrent();
    if (slide.body.length >= MAX_BODY_ITEMS) {
      const title = slide.title;
      flush();
      slide = ensureCurrent();
      slide.title = `${title}（续）`;
    }
    slide.body.push(item);
  };

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'heading': {
        const text = String(block.text ?? '').trim();
        if (text === '') break;
        const level = Number(block.level) || 1;
        if (level <= 2) {
          flush();
          current = { kind: 'content', title: text, body: [] };
        } else {
          pushBody({ kind: 'h3', text });
        }
        break;
      }
      case 'paragraph':
        if (String(block.text ?? '').trim() !== '') pushBody({ kind: 'p', text: String(block.text) });
        break;
      case 'quote':
        if (String(block.text ?? '').trim() !== '') pushBody({ kind: 'quote', text: String(block.text) });
        break;
      case 'bullets':
        for (const item of Array.isArray(block.items) ? block.items : []) {
          if (String(item ?? '').trim() !== '') pushBody({ kind: 'bullet', text: String(item) });
        }
        break;
      case 'numbered':
        for (const item of Array.isArray(block.items) ? block.items : []) {
          if (String(item ?? '').trim() !== '') pushBody({ kind: 'number', text: String(item) });
        }
        break;
      case 'code':
        for (const line of String(block.text ?? '').split('\n')) {
          if (line !== '') pushBody({ kind: 'code', text: line });
        }
        break;
      case 'table': {
        const headers = Array.isArray(block.headers) ? block.headers.map((item) => String(item ?? '')) : [];
        const bodyRows = Array.isArray(block.rows) ? block.rows.filter((row) => Array.isArray(row)) : [];
        if (headers.length > 0) pushBody({ kind: 'tableHead', text: headers.join(' ｜ ') });
        for (const row of bodyRows) pushBody({ kind: 'tableRow', text: row.map((item) => String(item ?? '')).join(' ｜ ') });
        break;
      }
      case 'image': {
        const image = resolvedImages.get(index);
        if (!image) break;
        flush();
        slides.push({
          kind: 'image',
          title: String(block.caption ?? block.alt ?? '图片'),
          imageKey: `image-${index}`,
          alt: String(block.alt ?? ''),
          caption: String(block.caption ?? ''),
        });
        break;
      }
      case 'pagebreak':
        flush();
        break;
      default:
        log(`未知的正文块类型，已忽略：${String(block.type)}`);
        break;
    }
  }
  flush();
  if (slides.length === 0) {
    slides.push({ kind: 'content', title: fallbackTitle, body: [] });
  }

  // 给图片分配包内路径与媒体序号；每张图片只写一次。
  const media = [];
  const imagesByKey = new Map();
  for (const [blockIndex, image] of resolvedImages) {
    const mediaNumber = media.length + 1;
    const extension = image.format.ext;
    media.push({
      partName: `ppt/media/image${mediaNumber}.${extension}`,
      buffer: image.data.buffer,
      ext: extension,
      contentType: image.format.contentType,
    });
    imagesByKey.set(`image-${blockIndex}`, {
      data: image.data,
      partName: `../media/image${mediaNumber}.${extension}`,
    });
  }

  const slideXmlParts = slides.map((slide) => slidePartsOf(slide, { images: imagesByKey }));

  const slideOverrides = slides
    .map(
      (_, index) =>
        `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join('');
  const imageDefaults = [...new Set(media.map((item) => item.ext))]
    .map((ext) => {
      const contentType = ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
      return `<Default Extension="${ext}" ContentType="${contentType}"/>`;
    })
    .join('');

  const contentTypes =
    XML_HEAD +
    `<Types ${CT_NS}>` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    imageDefaults +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    slideOverrides +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';

  const slideIds = slides
    .map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`)
    .join('');
  const presentationXml =
    XML_HEAD +
    `<p:presentation ${A_NS} ${R_NS} ${P_NS} saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${slideIds}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_CX}" cy="${SLIDE_CY}"/>` +
    '<p:notesSz cx="6858000" cy="9144000"/></p:presentation>';

  const presentationRels =
    XML_HEAD +
    `<Relationships ${PKG_REL_NS}>` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
    slides
      .map(
        (_, index) =>
          `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
      )
      .join('') +
    '</Relationships>';

  const rootRels =
    XML_HEAD +
    `<Relationships ${PKG_REL_NS}>` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';

  const coreXml =
    XML_HEAD +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:title>${escapeXml(typeof doc?.title === 'string' ? doc.title : '')}</dc:title>` +
    '<dc:creator>采文 · CollectKit</dc:creator></cp:coreProperties>';

  const appXml =
    XML_HEAD +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    '<Application>采文 · CollectKit</Application><PresentationFormat>宽屏</PresentationFormat></Properties>';

  const parts = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'ppt/presentation.xml', data: presentationXml },
    { name: 'ppt/_rels/presentation.xml.rels', data: presentationRels },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: SLIDE_MASTER_XML },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: MASTER_RELS_XML },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: SLIDE_LAYOUT_XML },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: LAYOUT_RELS_XML },
    { name: 'ppt/theme/theme1.xml', data: THEME_XML },
    { name: 'docProps/core.xml', data: coreXml },
    { name: 'docProps/app.xml', data: appXml },
  ];
  slideXmlParts.forEach((slide, index) => {
    parts.push({ name: `ppt/slides/slide${index + 1}.xml`, data: slide.xml });
    parts.push({ name: `ppt/slides/_rels/slide${index + 1}.xml.rels`, data: slide.rels });
  });
  for (const item of media) parts.push({ name: item.partName, data: item.buffer });

  return buildZip(parts);
}
