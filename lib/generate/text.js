/**
 * 文本类格式生成器：Markdown / HTML / 纯文本 / CSV / JSON。
 *
 * 全部是纯函数：输入 Doc 模型，返回 UTF-8 字符串（字节化由 index.js 负责）。
 * CSV 输出带 UTF-8 BOM，方便 Excel 直接双击打开时正确识别中文。
 */

/**
 * HTML 转义。
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 把一段多行文本转成 HTML（换行 → <br>）。
 * @param {string} text
 * @returns {string}
 */
function htmlText(text) {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

/**
 * 收集文档元信息行（副标题、来源、采集时间）。
 * @param {import('./index.js').Doc} doc
 * @returns {string[]}
 */
function metaLines(doc) {
  const lines = [];
  if (typeof doc?.subtitle === 'string' && doc.subtitle !== '') lines.push(doc.subtitle);
  if (typeof doc?.sourceUrl === 'string' && doc.sourceUrl !== '') lines.push(`来源：${doc.sourceUrl}`);
  if (typeof doc?.collectedAt === 'string' && doc.collectedAt !== '') lines.push(`采集时间：${doc.collectedAt}`);
  return lines;
}

/**
 * 生成 Markdown。
 * @param {import('./index.js').Doc} doc
 * @returns {string}
 */
export function renderMarkdown(doc) {
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];
  const lines = [];
  if (typeof doc?.title === 'string' && doc.title !== '') {
    lines.push(`# ${doc.title}`, '');
  }
  const meta = metaLines(doc);
  if (meta.length > 0) {
    for (const line of meta) lines.push(`> ${line}`);
    lines.push('');
  }
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'heading': {
        const level = Math.min(3, Math.max(1, Number(block.level) || 1));
        const text = String(block.text ?? '');
        if (text !== '') lines.push(`${'#'.repeat(level)} ${text}`, '');
        break;
      }
      case 'paragraph':
        if (String(block.text ?? '').trim() !== '') lines.push(String(block.text), '');
        break;
      case 'quote':
        if (String(block.text ?? '').trim() !== '') {
          lines.push(
            String(block.text)
              .split('\n')
              .map((line) => `> ${line}`)
              .join('\n'),
            '',
          );
        }
        break;
      case 'bullets':
        for (const item of Array.isArray(block.items) ? block.items : []) {
          if (String(item ?? '') !== '') lines.push(`- ${String(item)}`);
        }
        lines.push('');
        break;
      case 'numbered': {
        let index = 0;
        for (const item of Array.isArray(block.items) ? block.items : []) {
          if (String(item ?? '') === '') continue;
          index += 1;
          lines.push(`${index}. ${String(item)}`);
        }
        lines.push('');
        break;
      }
      case 'code': {
        const language = typeof block.lang === 'string' ? block.lang : '';
        lines.push('```' + language, String(block.text ?? ''), '```', '');
        break;
      }
      case 'table': {
        const headers = Array.isArray(block.headers) ? block.headers.map((item) => String(item ?? '')) : [];
        const rows = Array.isArray(block.rows) ? block.rows.filter((row) => Array.isArray(row)) : [];
        if (headers.length > 0) {
          lines.push(`| ${headers.join(' | ')} |`);
          lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
          for (const row of rows) {
            const cells = [];
            for (let index = 0; index < headers.length; index += 1) cells.push(String(row[index] ?? ''));
            lines.push(`| ${cells.join(' | ')} |`);
          }
          lines.push('');
        }
        break;
      }
      case 'image': {
        const alt = String(block.alt ?? '');
        const src = String(block.src ?? '');
        lines.push(`![${alt}](${src})`);
        if (typeof block.caption === 'string' && block.caption !== '') lines.push('', `*${block.caption}*`);
        lines.push('');
        break;
      }
      case 'pagebreak':
        lines.push('---', '');
        break;
      default:
        break;
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * 生成完整的 HTML5 文档（样式内联，无外部依赖）。
 * @param {import('./index.js').Doc} doc
 * @returns {string}
 */
export function renderHtml(doc) {
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];
  const parts = [];
  if (typeof doc?.title === 'string' && doc.title !== '') parts.push(`<h1>${escapeHtml(doc.title)}</h1>`);
  const meta = metaLines(doc);
  if (meta.length > 0) {
    parts.push(`<p class="meta">${meta.map((line) => escapeHtml(line)).join('<br>')}</p>`);
  }
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'heading': {
        const level = Math.min(3, Math.max(1, Number(block.level) || 1)) + 1;
        const text = String(block.text ?? '');
        if (text !== '') parts.push(`<h${level}>${escapeHtml(text)}</h${level}>`);
        break;
      }
      case 'paragraph':
        if (String(block.text ?? '').trim() !== '') parts.push(`<p>${htmlText(String(block.text))}</p>`);
        break;
      case 'quote':
        if (String(block.text ?? '').trim() !== '') parts.push(`<blockquote>${htmlText(String(block.text))}</blockquote>`);
        break;
      case 'bullets': {
        const items = (Array.isArray(block.items) ? block.items : []).filter((item) => String(item ?? '') !== '');
        if (items.length > 0) parts.push(`<ul>${items.map((item) => `<li>${htmlText(String(item))}</li>`).join('')}</ul>`);
        break;
      }
      case 'numbered': {
        const items = (Array.isArray(block.items) ? block.items : []).filter((item) => String(item ?? '') !== '');
        if (items.length > 0) parts.push(`<ol>${items.map((item) => `<li>${htmlText(String(item))}</li>`).join('')}</ol>`);
        break;
      }
      case 'code': {
        const language = typeof block.lang === 'string' ? escapeHtml(block.lang) : '';
        const className = language === '' ? '' : ` class="language-${language}"`;
        parts.push(`<pre><code${className}>${escapeHtml(String(block.text ?? ''))}</code></pre>`);
        break;
      }
      case 'table': {
        const headers = Array.isArray(block.headers) ? block.headers.map((item) => String(item ?? '')) : [];
        const rows = Array.isArray(block.rows) ? block.rows.filter((row) => Array.isArray(row)) : [];
        if (headers.length > 0) {
          const head = `<thead><tr>${headers.map((item) => `<th>${escapeHtml(item)}</th>`).join('')}</tr></thead>`;
          const body = rows
            .map((row) => `<tr>${headers.map((_, index) => `<td>${escapeHtml(row[index] ?? '')}</td>`).join('')}</tr>`)
            .join('');
          parts.push(`<table>${head}<tbody>${body}</tbody></table>`);
        }
        break;
      }
      case 'image': {
        const alt = escapeHtml(block.alt ?? '');
        const src = escapeHtml(block.src ?? '');
        const caption =
          typeof block.caption === 'string' && block.caption !== ''
            ? `<figcaption>${escapeHtml(block.caption)}</figcaption>`
            : '';
        parts.push(`<figure><img src="${src}" alt="${alt}" loading="lazy">${caption}</figure>`);
        break;
      }
      case 'pagebreak':
        parts.push('<hr class="pagebreak">');
        break;
      default:
        break;
    }
  }
  const style = [
    ':root{color-scheme:light dark}',
    'body{margin:0;background:#fff;color:#24292f;font:16px/1.75 -apple-system,"Microsoft YaHei",sans-serif}',
    'article{max-width:820px;margin:0 auto;padding:48px 24px 64px}',
    'h1{font-size:2em;line-height:1.3;color:#1f3864;margin:0 0 .4em}',
    'h2{margin-top:1.6em;border-bottom:1px solid #e1e4e8;padding-bottom:.3em}',
    'h3,h4{margin-top:1.3em;color:#2f5597}',
    '.meta{color:#6a737d;font-size:.92em}',
    'blockquote{margin:1em 0;padding:.2em 1em;border-left:4px solid #8faadc;color:#4b5563;background:#f6f8fa}',
    'pre{background:#f6f8fa;border:1px solid #e1e4e8;border-radius:6px;padding:14px 16px;overflow:auto}',
    'code{font-family:Consolas,"Courier New",monospace;font-size:.92em}',
    'table{border-collapse:collapse;width:100%;margin:1em 0}',
    'th,td{border:1px solid #d0d7de;padding:8px 10px;text-align:left;vertical-align:top}',
    'th{background:#dce6f1;font-weight:600}',
    'figure{margin:1.4em 0;text-align:center}',
    'img{max-width:100%;height:auto;border-radius:4px}',
    'figcaption{color:#6a737d;font-size:.9em;margin-top:.4em}',
    'hr.pagebreak{border:0;border-top:2px dashed #d0d7de;margin:2.4em 0}',
  ].join('');
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtml(typeof doc?.title === 'string' ? doc.title : '采文文档')}</title>` +
    `<style>${style}</style></head><body><article>${parts.join('')}</article></body></html>\n`
  );
}

/**
 * 生成纯文本（UTF-8）。
 * @param {import('./index.js').Doc} doc
 * @returns {string}
 */
export function renderPlainText(doc) {
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];
  const lines = [];
  if (typeof doc?.title === 'string' && doc.title !== '') {
    lines.push(doc.title, '='.repeat(40), '');
  }
  const meta = metaLines(doc);
  if (meta.length > 0) {
    lines.push(...meta, '');
  }
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'heading': {
        const text = String(block.text ?? '');
        if (text !== '') lines.push(text, '-'.repeat(40), '');
        break;
      }
      case 'paragraph':
        if (String(block.text ?? '').trim() !== '') lines.push(String(block.text), '');
        break;
      case 'quote':
        if (String(block.text ?? '').trim() !== '') {
          lines.push(
            String(block.text)
              .split('\n')
              .map((line) => `> ${line}`)
              .join('\n'),
            '',
          );
        }
        break;
      case 'bullets':
        for (const item of Array.isArray(block.items) ? block.items : []) {
          if (String(item ?? '') !== '') lines.push(`- ${String(item)}`);
        }
        lines.push('');
        break;
      case 'numbered': {
        let index = 0;
        for (const item of Array.isArray(block.items) ? block.items : []) {
          if (String(item ?? '') === '') continue;
          index += 1;
          lines.push(`${index}. ${String(item)}`);
        }
        lines.push('');
        break;
      }
      case 'code':
        for (const line of String(block.text ?? '').split('\n')) lines.push(`    ${line}`);
        lines.push('');
        break;
      case 'table': {
        const headers = Array.isArray(block.headers) ? block.headers.map((item) => String(item ?? '')) : [];
        const rows = Array.isArray(block.rows) ? block.rows.filter((row) => Array.isArray(row)) : [];
        if (headers.length > 0) {
          lines.push(headers.join(' | '));
          lines.push(headers.map(() => '--------').join('-+-'));
          for (const row of rows) {
            const cells = [];
            for (let index = 0; index < headers.length; index += 1) cells.push(String(row[index] ?? ''));
            lines.push(cells.join(' | '));
          }
          lines.push('');
        }
        break;
      }
      case 'image': {
        const label = String(block.alt ?? block.caption ?? block.src ?? '图片');
        lines.push(`[图片] ${label}`);
        if (typeof block.caption === 'string' && block.caption !== '') lines.push(`说明：${block.caption}`);
        lines.push('');
        break;
      }
      case 'pagebreak':
        lines.push('--- 分页 ---', '');
        break;
      default:
        break;
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * CSV 字段转义：包含逗号、引号或换行时用双引号包裹并转义内部引号。
 * @param {unknown} value
 * @returns {string}
 */
function csvField(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * 生成 CSV（两列：类型 / 内容；表格按"表头"和"表格行"逐行展开）。
 * @param {import('./index.js').Doc} doc
 * @returns {string}
 */
export function renderCsv(doc) {
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];
  const rows = [['类型', '内容']];
  const push = (type, content) => rows.push([type, content]);
  if (typeof doc?.title === 'string' && doc.title !== '') push('标题', doc.title);
  if (typeof doc?.subtitle === 'string' && doc.subtitle !== '') push('副标题', doc.subtitle);
  if (typeof doc?.sourceUrl === 'string' && doc.sourceUrl !== '') push('来源', doc.sourceUrl);
  if (typeof doc?.collectedAt === 'string' && doc.collectedAt !== '') push('采集时间', doc.collectedAt);
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'heading': {
        const text = String(block.text ?? '');
        if (text !== '') push(`标题${Number(block.level) || 1}`, text);
        break;
      }
      case 'paragraph':
        if (String(block.text ?? '').trim() !== '') push('正文', String(block.text));
        break;
      case 'quote':
        if (String(block.text ?? '').trim() !== '') push('引用', String(block.text));
        break;
      case 'bullets':
        for (const item of Array.isArray(block.items) ? block.items : []) {
          if (String(item ?? '') !== '') push('无序列表', String(item));
        }
        break;
      case 'numbered':
        for (const item of Array.isArray(block.items) ? block.items : []) {
          if (String(item ?? '') !== '') push('有序列表', String(item));
        }
        break;
      case 'code':
        for (const line of String(block.text ?? '').split('\n')) push('代码', line);
        break;
      case 'table': {
        const headers = Array.isArray(block.headers) ? block.headers.map((item) => String(item ?? '')) : [];
        const bodyRows = Array.isArray(block.rows) ? block.rows.filter((row) => Array.isArray(row)) : [];
        if (headers.length > 0) push('表头', headers.join(' | '));
        for (const row of bodyRows) push('表格行', row.map((item) => String(item ?? '')).join(' | '));
        break;
      }
      case 'image': {
        const label = String(block.alt ?? block.caption ?? block.src ?? '');
        push('图片', label);
        break;
      }
      case 'pagebreak':
        push('分页', '');
        break;
      default:
        break;
    }
  }
  return `\ufeff${rows.map((row) => row.map(csvField).join(',')).join('\r\n')}\r\n`;
}

/**
 * 生成 JSON（规范化后的 Doc 模型本身）。
 * @param {import('./index.js').Doc} doc
 * @returns {string}
 */
export function renderJson(doc) {
  const output = {};
  if (typeof doc?.title === 'string' && doc.title !== '') output.title = doc.title;
  if (typeof doc?.subtitle === 'string' && doc.subtitle !== '') output.subtitle = doc.subtitle;
  if (typeof doc?.sourceUrl === 'string' && doc.sourceUrl !== '') output.sourceUrl = doc.sourceUrl;
  if (typeof doc?.collectedAt === 'string' && doc.collectedAt !== '') output.collectedAt = doc.collectedAt;
  output.blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];
  return `${JSON.stringify(output, null, 2)}\n`;
}
