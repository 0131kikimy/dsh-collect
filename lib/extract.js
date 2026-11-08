// dsh-collect · 网页正文抽取（契约见 CONTRACT.md §5.2：extractArticle / htmlToMarkdown）
// 纯字符串 + 状态机：切词建轻量树 → 去噪 → 挑正文容器（article/main → 文本密度）→ 转 Markdown。
// 元信息（title/siteName/lang/description/byline）用正则从 <head> 里单独抽。
const VOID_TAGS = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const SKIP_TAGS = new Set('script style noscript nav footer aside form svg iframe template canvas button select option video audio object'.split(' '));
const RAW_TAGS = new Set('script style textarea title xmp noscript iframe svg'.split(' '));
const BLOCK_TAGS = new Set('address article blockquote details dialog div dl dd dt fieldset figcaption figure h1 h2 h3 h4 h5 h6 header hr li main ol p pre section table tbody td tfoot th thead tr ul'.split(' '));
const HEADING_LEVEL = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
// 导航/分享/评论/广告一类容器的关键词，只作提示，还要结合链接密度才判噪声
const NOISE_HINT = /(?:^|[-_\s])(?:nav(?:igation)?|menu|sidebar|side-bar|footer|comment(?:s|list)?|share|social|related|recommend|advert?|ads?|banner|cookie|popup|modal|toolbar|breadcrumb|pagination|pager|copyright|disclaimer|subscribe|newsletter|tags?|tag-list|meta-list|hot-list|rank-list)(?:[-_\s]|$)/i;
const MAX_IMAGES = 40;
const MAX_LINKS = 500;
// 常用命名实体表；值里可能含空白字符（&nbsp; 等），所以用 | 分隔而不用空格。
const ENTITY_PAIRS = `amp:&|lt:<|gt:>|quot:"|apos:'|nbsp:\u00a0|iexcl:¡|cent:¢|pound:£|yen:¥|euro:€|copy:©|reg:®|trade:™|deg:°|plusmn:±|times:×|divide:÷|frac12:½|frac14:¼|frac34:¾|sup2:²|sup3:³|micro:µ|para:¶|sect:§|middot:·|bull:•|hellip:…|mdash:—|ndash:–|lsquo:‘|rsquo:’|ldquo:“|rdquo:”|laquo:«|raquo:»|prime:′|Prime:″|larr:←|uarr:↑|rarr:→|darr:↓|harr:↔|lArr:⇐|rArr:⇒|hArr:⇔|le:≤|ge:≥|ne:≠|equiv:≡|asymp:≈|inf:∞|sum:∑|prod:∏|radic:√|part:∂|isin:∈|notin:∉|cap:∩|cup:∪|and:∧|or:∨|not:¬|forall:∀|exist:∃|empty:∅|ensp:\u2002|emsp:\u2003|thinsp:\u2009|shy:\u00ad|zwj:\u200d|zwnj:\u200c`;
const NAMED_ENTITIES = Object.fromEntries(ENTITY_PAIRS.split('|').map((pair) => [pair.slice(0, pair.indexOf(':')), pair.slice(pair.indexOf(':') + 1)]));
// 实体解码：命名实体 + 十进制/十六进制数字实体
function decodeEntities(text) {
  const s = String(text ?? ''); if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]{1,31});?/gi, (match, body) => {
    if (body[0] === '#') {
      const code = /\d/.test(body[1]) ? parseInt(body.slice(1), 10) : parseInt(body.slice(2), 16);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}
// 文本节点 → 实体解码（&nbsp; 折成普通空格）
function inlineText(raw) { return decodeEntities(String(raw ?? '').replace(/\u00a0/g, ' ')); }
// 行内拼接后的收尾：折空白、去空行、去首尾空格
function finishInline(text) {
  return String(text || '').replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n').replace(/[ \t]+$/gm, '').trim();
}
// 给行内文本加 Markdown 标记，保留两侧空白
function wrap(text, mark) {
  const value = String(text || '');
  if (!value.trim()) return value;
  return `${/^\s/.test(value) ? ' ' : ''}${mark}${value.trim()}${mark}${/\s$/.test(value) ? ' ' : ''}`;
}
// URL 进 Markdown 前转义括号/空白，避免截断链接
function mdUrl(url) {
  try {
    return encodeURI(url).replace(/\(/g, '%28').replace(/\)/g, '%29')
      .replace(/\[/g, '%5B').replace(/\]/g, '%5D').replace(/ /g, '%20');
  } catch { return url; }
}
// 相对地址 → 绝对地址；非法/危险协议返回 ''
function resolveUrl(raw, base) {
  const value = String(raw || '').trim();
  if (!value || value.startsWith('#')) return '';
  if (/^(?:data|javascript|blob|about|file|ftp):/i.test(value)) return '';
  try {
    const url = new URL(value, base || undefined);
    return /^https?:$/i.test(url.protocol) || /^mailto:/i.test(url.protocol) ? url.href : '';
  } catch { return ''; }
}
// 解析标签属性串（引号感知由 findTagEnd 保证）
function parseAttrs(raw) {
  const attrs = {};
  const re = /([^\s/>=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  for (let match = re.exec(String(raw || '')); match; match = re.exec(String(raw || ''))) {
    const name = match[1].toLowerCase();
    if (!name || name === '/' || name.startsWith('<')) continue;
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}
// 找标签结束的 '>'（跳过引号里的内容）；返回 -1 表示这个 '<' 不是标签
function findTagEnd(src, start) {
  let quote = '';
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch; else if (ch === '>') return i; else if (ch === '<') return -1;
  }
  return -1;
}
// 处理 HTML 里常见的隐式闭合（<p> 遇到块级、<li> 遇到 <li> 等）
function autoClose(stack, tag) {
  const closeOne = (name) => {
    for (let k = stack.length - 1; k > 0; k -= 1) {
      if (stack[k].tag === name) { stack.length = k; return; }
      if (BLOCK_TAGS.has(stack[k].tag)) return;
    }
  };
  if (BLOCK_TAGS.has(tag) && tag !== 'p' && tag !== 'li') closeOne('p');
  if (tag === 'li') { closeOne('li'); closeOne('p'); }
  if (tag === 'td' || tag === 'th') { closeOne('td'); closeOne('th'); }
  if (tag === 'tr') { closeOne('tr'); closeOne('td'); closeOne('th'); }
  if (tag === 'dt' || tag === 'dd') { closeOne('dt'); closeOne('dd'); }
}
// 建轻量树：{tag, attrs, children[]}，文本节点是字符串
function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] }; const stack = [root];
  const src = String(html ?? ''); const top = () => stack[stack.length - 1];
  for (let i = 0; i < src.length;) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { top().children.push(src.slice(i)); break; }
    if (lt > i) top().children.push(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const end = src.indexOf('-->', lt + 4); i = end < 0 ? src.length : end + 3; continue; }
    if (src.startsWith('<!', lt)) { const end = src.indexOf('>', lt); i = end < 0 ? src.length : end + 1; continue; }
    const closeMatch = /^<\/([a-zA-Z][\w:-]*)\s*>/.exec(src.slice(lt, lt + 80));
    if (closeMatch) {
      const tag = closeMatch[1].toLowerCase();
      for (let k = stack.length - 1; k > 0; k -= 1) if (stack[k].tag === tag) { stack.length = k; break; }
      i = lt + closeMatch[0].length;
      continue;
    }
    const end = findTagEnd(src, lt + 1);
    if (end < 0) { top().children.push(src.slice(lt)); break; }
    const rawTag = src.slice(lt + 1, end);
    const nameMatch = /^([a-zA-Z][\w:-]*)/.exec(rawTag);
    if (!nameMatch) { top().children.push(src.slice(lt, end + 1)); i = end + 1; continue; }
    const tag = nameMatch[1].toLowerCase();
    const node = { tag, attrs: parseAttrs(rawTag.slice(nameMatch[1].length)), children: [] };
    top().children.push(node);
    if (!RAW_TAGS.has(tag)) {
      if (!/\/\s*$/.test(rawTag) && !VOID_TAGS.has(tag)) { autoClose(stack, tag); stack.push(node); }
      i = end + 1;
      continue;
    }
    const closeRe = new RegExp(`</${tag}\\s*>`, 'ig');
    closeRe.lastIndex = end + 1;
    const closeTag = closeRe.exec(src);
    const textEnd = closeTag ? closeTag.index : src.length;
    if (textEnd > end + 1) node.children.push(src.slice(end + 1, textEnd));
    i = closeTag ? closeTag.index + closeTag[0].length : src.length;
  }
  return root;
}
// 子树文本长度（只数文本节点）
function textLength(node) {
  if (typeof node === 'string') return node.trim().length;
  return (node.children || []).reduce((total, child) => total + textLength(child), 0);
}
// 子树里 <a> 文本长度，用来算链接密度
function linkTextLength(node) {
  if (typeof node === 'string' || !node.children) return 0;
  return node.tag === 'a' ? textLength(node) : node.children.reduce((total, child) => total + linkTextLength(child), 0);
}
// 明显是导航/分享/评论/广告的小容器：class/id 关键词 + 链接密度
function isNoiseBox(node) {
  if (!['div', 'section', 'ul', 'figure'].includes(node.tag)) return false;
  const attrs = node.attrs || {};
  const token = `${attrs.class || ''} ${attrs.id || ''}`.trim();
  if (!token || !NOISE_HINT.test(token)) return false;
  const text = textLength(node);
  return text < 300 || linkTextLength(node) >= text * 0.4;
}
// 递归去噪：整棵树上剔除 SKIP_TAGS 与噪声容器
function prune(node) {
  if (!node.children) return;
  node.children = node.children.filter((child) => typeof child === 'string'
    || (!SKIP_TAGS.has(child.tag) && !isNoiseBox(child)));
  for (const child of node.children) if (typeof child !== 'string') prune(child);
}
// 深度优先收集指定标签
function walkTags(root, tags) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (typeof node === 'string' || !node.children) continue;
    if (tags.has(node.tag)) out.push(node);
    for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]);
  }
  return out;
}
function findFirst(root, tag) { return walkTags(root, new Set([tag]))[0] || null; }
function bestByText(nodes) {
  return nodes.reduce((best, node) => (textLength(node) > textLength(best) ? node : best), nodes[0]);
}
// 正文容器启发式：article → main → 文本密度最高的容器 → body
function pickContent(body) {
  const articles = walkTags(body, new Set(['article']));
  if (articles.length) return bestByText(articles);
  const mains = walkTags(body, new Set(['main']));
  if (mains.length) return bestByText(mains);
  let best = null;
  let bestScore = 0;
  for (const node of walkTags(body, new Set(['div', 'section', 'td']))) {
    const text = textLength(node);
    if (text < 200) continue;
    const score = text - 1.5 * linkTextLength(node);
    if (score > bestScore) { bestScore = score; best = node; }
  }
  return bestScore >= 200 && best ? best : body;
}
// <head> 元信息抽取
function parseMeta(html, baseUrl) {
  const meta = { title: '', ogTitle: '', siteName: '', lang: '', description: '', byline: '', baseHref: '' };
  const tags = new Map();
  const metaRe = /<meta\b([^>]*)>/gi;
  for (let match = metaRe.exec(html); match; match = metaRe.exec(html)) {
    const attrs = parseAttrs(match[1]);
    if (attrs.content === undefined || !String(attrs.content).trim()) continue;
    const key = String(attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && !tags.has(key)) tags.set(key, attrs.content);
    if (String(attrs['http-equiv'] || '').toLowerCase() === 'content-language' && !meta.lang) meta.lang = String(attrs.content).trim();
  }
  const get = (...keys) => {
    const value = keys.map((key) => tags.get(key)).find((item) => item !== undefined && String(item).trim());
    return value === undefined ? '' : String(value).trim();
  };
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleMatch) meta.title = finishInline(decodeEntities(titleMatch[1].replace(/<[^>]*>/g, ' ')));
  meta.ogTitle = get('og:title', 'twitter:title', 'dc.title');
  meta.siteName = get('og:site_name', 'application-name', 'twitter:site');
  meta.description = get('og:description', 'description', 'twitter:description');
  meta.byline = get('article:author', 'author', 'byl');
  const htmlTag = /<html\b([^>]*)>/i.exec(html);
  if (htmlTag) { const lang = parseAttrs(htmlTag[1]).lang; if (lang) meta.lang = String(lang).trim(); }
  const baseTag = /<base\b([^>]*)>/i.exec(html);
  if (baseTag) { const href = parseAttrs(baseTag[1]).href; if (href) { try { meta.baseHref = new URL(href, baseUrl || undefined).href; } catch { /* 忽略非法 base */ } } }
  return meta;
}
// 图片是否明显是占位图（1x1 透明图、懒加载占位、空地址）
function isPlaceholderImage(node, url) {
  const attrs = node.attrs || {};
  const width = Number(attrs.width);
  const height = Number(attrs.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width <= 2 && height <= 2) return true;
  let pathname = url;
  try { pathname = new URL(url).pathname + new URL(url).search; } catch { /* 保留原串 */ }
  return /(?:^|[\/._-])(?:1x1|spacer|blank|pixel|transparent|placeholder|loading|lazy|grey|gray)\.(?:gif|png)$/i.test(pathname);
}
// 渲染 <img>：绝对化、占位图丢弃、按 URL 去重、最多 MAX_IMAGES 张
function renderImage(node, ctx) {
  const attrs = node.attrs || {};
  // 懒加载站点的 src 常是占位图，真实地址在 data-src 一类属性上（微信、知乎、多数 CMS）。
  // 按「真实度」排序取第一个可用地址，避免把占位图当成正文图。
  const candidates = [
    attrs['data-src'], attrs['data-original'], attrs['data-actualsrc'],
    attrs['data-lazy-src'], attrs['data-echo'], attrs.src,
  ];
  if (!attrs.src && attrs.srcset) candidates.push(String(attrs.srcset).split(',')[0].trim().split(/\s+/)[0]);
  let url = '';
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = resolveUrl(candidate, ctx.baseUrl);
    if (!resolved || !/^https?:/i.test(resolved)) continue;
    if (isPlaceholderImage(node, resolved)) continue;
    url = resolved;
    break;
  }
  if (!url) return '';
  if (ctx.imageSeen.has(url) || ctx.images.length >= MAX_IMAGES) return '';
  const alt = finishInline(inlineText(attrs.alt || attrs.title || ''));
  ctx.imageSeen.add(url);
  ctx.images.push({ url, alt });
  return `![${alt}](${mdUrl(url)})`;
}
// 渲染 <a>：绝对化并顺带收集链接列表
function renderAnchor(node, ctx) {
  const text = renderChildrenInline(node, ctx);
  const url = resolveUrl((node.attrs || {}).href, ctx.baseUrl);
  if (!url) return text;
  if (ctx.links.length < MAX_LINKS) ctx.links.push({ url, text: finishInline(text) || url });
  return text ? `[${text}](${mdUrl(url)})` : '';
}
// 行内渲染
function renderInline(node, ctx) {
  if (typeof node === 'string') return inlineText(node);
  const tag = node.tag;
  if (SKIP_TAGS.has(tag)) return '';
  if (tag === 'br') return '\n';
  if (tag === 'img') return renderImage(node, ctx);
  if (tag === 'a') return renderAnchor(node, ctx);
  if (tag === 'code') {
    const code = rawText(node).replace(/\s+/g, ' ').trim();
    return code ? `\`${code}\`` : '';
  }
  if (tag === 'strong' || tag === 'b') return wrap(renderChildrenInline(node, ctx), '**');
  if (tag === 'em' || tag === 'i') return wrap(renderChildrenInline(node, ctx), '*');
  if (tag === 'del' || tag === 's' || tag === 'strike') return wrap(renderChildrenInline(node, ctx), '~~');
  return renderChildrenInline(node, ctx);
}
// 行内子节点拼接
function renderChildrenInline(node, ctx) {
  let out = '';
  for (const child of node.children || []) out += typeof child === 'string' ? inlineText(child) : renderInline(child, ctx);
  return out;
}
// 表格单元格：只保留行内内容，折成一行并转义竖线
function renderCellText(cell, ctx) {
  return finishInline(renderChildrenInline(cell, ctx)).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
// <table> → Markdown 表格（首行当表头）
function renderTable(node, ctx) {
  const rows = [];
  const walk = (current) => {
    for (const child of current.children || []) {
      if (typeof child === 'string') continue;
      if (child.tag === 'tr') rows.push(child);
      else if (child.tag !== 'table') walk(child);
    }
  };
  walk(node);
  const matrix = rows
    .map((tr) => (tr.children || []).filter((cell) => typeof cell !== 'string' && (cell.tag === 'td' || cell.tag === 'th'))
      .map((cell) => renderCellText(cell, ctx)))
    .filter((row) => row.length > 0);
  if (matrix.length === 0) return '';
  const width = Math.max(...matrix.map((row) => row.length));
  const pad = (row) => { const copy = row.slice(); while (copy.length < width) copy.push(''); return copy; };
  const [header, ...body] = matrix.map(pad);
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const row of body) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}
// <pre>（或 <pre><code>）→ 围栏代码块，读 class 里的语言名
function renderPre(node) {
  const codeNode = findFirst(node, 'code');
  const code = rawText(codeNode || node).replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
  if (!code.trim()) return '';
  const cls = String((codeNode && codeNode.attrs && codeNode.attrs.class) || (node.attrs && node.attrs.class) || ''); const langMatch = /(?:language|lang)-([\w+#.-]+)/i.exec(cls);
  return `${code.includes('```') ? '````' : '```'}${langMatch ? langMatch[1].toLowerCase() : ''}\n${code}\n${code.includes('```') ? '````' : '```'}`;
}
// <ul>/<ol> → 列表，嵌套列表按两空格缩进
function renderList(node, ctx, ordered) {
  const items = (node.children || []).filter((child) => typeof child !== 'string' && child.tag === 'li');
  if (!items.length) return '';
  const lines = [];
  items.forEach((li, index) => {
    const marker = ordered ? `${index + 1}. ` : '- ';
    let inline = '';
    const nested = [];
    for (const child of li.children || []) {
      if (typeof child === 'string') { inline += inlineText(child); continue; }
      if (SKIP_TAGS.has(child.tag)) continue;
      if (child.tag === 'ul' || child.tag === 'ol') { nested.push(renderList(child, ctx, child.tag === 'ol')); continue; }
      if (BLOCK_TAGS.has(child.tag)) {
        const block = renderBlock(child, ctx);
        if (block) nested.push(block);
        continue;
      }
      inline += renderInline(child, ctx);
    }
    lines.push((marker + finishInline(inline)).trimEnd());
    for (const block of nested) for (const line of block.split('\n')) lines.push(line ? `  ${line}` : '');
  });
  return lines.join('\n');
}
// 块级渲染
function renderBlock(node, ctx) {
  const tag = node.tag;
  if (SKIP_TAGS.has(tag)) return '';
  const level = HEADING_LEVEL[tag];
  if (level) {
    const text = finishInline(renderChildrenInline(node, ctx));
    return text ? `${'#'.repeat(level)} ${text}` : '';
  }
  switch (tag) {
    case 'p': return finishInline(renderChildrenInline(node, ctx));
    case 'hr': return '---';
    case 'img': return renderImage(node, ctx);
    case 'pre': return renderPre(node);
    case 'ul': return renderList(node, ctx, false);
    case 'ol': return renderList(node, ctx, true);
    case 'table': return renderTable(node, ctx);
    case 'blockquote': { const inner = renderBlocks(node, ctx); return inner ? inner.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n') : ''; }
    case 'figcaption': { const text = finishInline(renderChildrenInline(node, ctx)); return text ? `*${text}*` : ''; }
    case 'dt': { const text = finishInline(renderChildrenInline(node, ctx)); return text ? `**${text}**` : ''; }
    case 'dd': return finishInline(renderChildrenInline(node, ctx));
    case 'li': { const text = finishInline(renderChildrenInline(node, ctx)); return text ? `- ${text}` : ''; }
    default: return renderBlocks(node, ctx);
  }
}
// 容器渲染：块级子节点之间用一个空行分隔，行内碎片攒成段落
function renderBlocks(node, ctx) {
  const blocks = [];
  let inline = '';
  const flush = () => {
    const text = finishInline(inline);
    if (text) blocks.push(text);
    inline = '';
  };
  for (const child of node.children || []) {
    if (typeof child === 'string') { inline += inlineText(child); continue; }
    if (SKIP_TAGS.has(child.tag)) continue;
    if (BLOCK_TAGS.has(child.tag)) {
      flush();
      const block = renderBlock(child, ctx);
      if (block) blocks.push(block);
    } else inline += renderInline(child, ctx);
  }
  flush();
  return blocks.join('\n\n');
}
// 原样取文本（pre 用）：解码实体但保留空白与换行
function rawText(node) {
  if (typeof node === 'string') return decodeEntities(node);
  if (!node.children) return '';
  if (node.tag === 'br') return '\n';
  let out = '';
  for (const child of node.children) out += rawText(child);
  return out;
}
// 纯文本版本（给字数统计/预览用）
function plainText(node) {
  const parts = [];
  const walk = (current) => {
    if (typeof current === 'string') { parts.push(inlineText(current)); return; }
    if (SKIP_TAGS.has(current.tag)) return;
    const isBlock = BLOCK_TAGS.has(current.tag);
    if (isBlock) parts.push('\n');
    if (current.tag === 'br') parts.push('\n');
    else if (current.tag === 'img') {
      const alt = (current.attrs || {}).alt;
      if (alt) parts.push(inlineText(alt));
    }
    for (const child of current.children || []) walk(child);
    if (isBlock) parts.push('\n');
  };
  walk(node);
  return parts.join('').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
// 收敛换行：块之间最多一个空行，代码围栏内原样保留
function normalizeMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!fence && /^`{3,}/.test(trimmed)) { fence = trimmed.slice(0, 3); out.push(line.replace(/\s+$/, '')); continue; }
    if (fence) {
      out.push(line);
      if (trimmed.startsWith(fence)) fence = '';
      continue;
    }
    if (!trimmed) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    out.push(line.replace(/\s+$/, ''));
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n').replace(/^\n+/, '');
}
// 第一个 h1（没有就 h2），作为标题兜底
function firstHeading(root) {
  const heading = findFirst(root, 'h1') || findFirst(root, 'h2');
  return heading ? finishInline(plainText(heading)) : '';
}
// 把 baseUrl 归一化成可用作相对地址基准的绝对 URL
function normalizeBase(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.href;
  } catch { return ''; }
}
// ── 微信公众号文章：站点专用适配 ──────────────────────────────────────────────
// 微信对「看起来像浏览器」的请求返回完整正文（正文在 #js_content 里，图片在 data-src 上）；
// 对机器人 UA 或高频 IP 则返回 18KB 的「环境异常」验证页。这里单独挑正文并识别被拦页。
const WECHAT_HOST = /(^|\.)mp\.weixin\.qq\.com$/i;

/**
 * 判断是不是微信公众号文章地址。
 * @param {string} url
 * @returns {boolean}
 */
export function isWeChatUrl(url) {
  try {
    return WECHAT_HOST.test(new URL(String(url || '')).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 按 id 找第一个节点（微信用 #js_content / #activity-name 这类固定 id）。
 * @param {object} root 解析树根节点
 * @param {string} id 目标 id
 * @returns {object|null}
 */
function findById(root, id) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (typeof node === 'string' || !node.children) continue;
    if (node.attrs && node.attrs.id === id) return node;
    for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]);
  }
  return null;
}

/**
 * 判断是不是被反爬验证页拦住（微信「环境异常」、访问过于频繁等）。
 * @param {string} html 原始 HTML
 * @param {string} [title] 已解析出的标题
 * @returns {boolean}
 */
export function looksBlocked(html, title = '') {
  const head = String(html || '').slice(0, 12000);
  const heading = String(title || '');
  if (/环境异常|访问过于频繁|请输入验证码|完成验证|Access Denied/i.test(heading)) return true;
  if (/环境异常|完成验证后即可继续访问|访问过于频繁|请用微信客户端打开|请在微信中打开/.test(head)) return true;
  return false;
}

/**
 * 微信文章专用抽取：正文取 #js_content，标题/公众号/发布时间取固定 id。
 * @param {string} html
 * @param {string} baseUrl
 * @returns {object|null} 不是文章结构（也没有被拦）时返回 null，交给通用抽取
 */
function extractWeChat(html, baseUrl) {
  const base = normalizeBase(baseUrl);
  const meta = parseMeta(html, base);
  const tree = parseHtml(html);
  prune(tree);
  const body = findFirst(tree, 'body') || tree;
  const content = findById(body, 'js_content');
  const blocked = looksBlocked(html, meta.ogTitle || meta.title);
  if (!content && !blocked) return null;

  const titleNode = findById(body, 'activity-name');
  const authorNode = findById(body, 'js_name');
  const timeNode = findById(body, 'publish_time');
  const ctx = { baseUrl: meta.baseHref || base, images: [], imageSeen: new Set(), links: [] };
  const markdown = content ? normalizeMarkdown(renderBlocks(content, ctx)) : '';
  const title = finishInline(meta.ogTitle || (titleNode ? plainText(titleNode) : '') || meta.title || '');
  return {
    title: blocked && !content ? '环境异常（微信反爬验证页）' : title,
    siteName: finishInline(authorNode ? plainText(authorNode) : (meta.siteName || '微信公众平台')),
    lang: meta.lang || 'zh-CN',
    description: meta.description || '',
    markdown,
    text: (content ? plainText(content) : '') || markdown.replace(/[#*>`|~\-[\]()!]/g, '').trim(),
    images: ctx.images,
    links: ctx.links,
    byline: finishInline(timeNode ? plainText(timeNode) : (meta.byline || '')),
    blocked: blocked || !content,
    blockedReason: blocked || !content ? '微信返回了「环境异常」验证页，正文容器 #js_content 不存在' : '',
  };
}

// 解析一次，供两个导出复用
function analyze(html, baseUrl) {
  const source = String(html ?? '');
  const base = normalizeBase(baseUrl);
  const meta = parseMeta(source, base);
  const tree = parseHtml(source);
  prune(tree);
  const body = findFirst(tree, 'body') || tree;
  const root = pickContent(body);
  const ctx = { baseUrl: meta.baseHref || base, images: [], imageSeen: new Set(), links: [] };
  return { base, meta, body, root, ctx };
}
/**
 * HTML → Markdown（extractArticle 的底层，也单独导出）。
 * @param {string} html
 * @param {string} baseUrl 相对地址的基准；缺省时相对链接会被丢弃
 * @returns {string}
 */
export function htmlToMarkdown(html, baseUrl) {
  const { root, ctx } = analyze(html, baseUrl);
  return normalizeMarkdown(renderBlocks(root, ctx));
}
/**
 * 网页 HTML → 结构化文章。
 * @param {string} html
 * @param {string} baseUrl
 * @returns {{title:string, siteName:string, lang:string, description:string,
 *   markdown:string, text:string, images:{url:string,alt:string}[],
 *   links:{url:string,text:string}[], byline:string}}
 */
export function extractArticle(html, baseUrl) {
  // 微信文章走专用适配：#js_content 是固定正文容器，通用密度启发式容易被 3MB 的脚本噪声带偏。
  if (isWeChatUrl(baseUrl)) {
    const wechat = extractWeChat(html, baseUrl);
    if (wechat) return wechat;
  }
  const { base, meta, body, root, ctx } = analyze(html, baseUrl);
  let markdown = normalizeMarkdown(renderBlocks(root, ctx));
  // 密度启发式挑偏时（例如整页只有极少正文）退回整页重新渲染
  if (markdown.replace(/[\s#*>`|~\-\[\]()!]/g, '').length < 20 && root !== body) {
    const retry = { baseUrl: ctx.baseUrl, images: [], imageSeen: new Set(), links: [] };
    markdown = normalizeMarkdown(renderBlocks(body, retry));
    ctx.images = retry.images;
    ctx.links = retry.links;
  }
  let host = '';
  try { host = new URL(base).hostname.replace(/^www\./i, ''); } catch { /* base 不可用时留空 */ }
  const title = meta.ogTitle || meta.title || firstHeading(root);
  const blocked = looksBlocked(html, title);
  return {
    title: title || '',
    siteName: meta.siteName || host,
    lang: meta.lang || '',
    description: meta.description || '',
    markdown,
    text: plainText(root) || markdown.replace(/[#*>`|~\-[\]()!]/g, '').trim(),
    images: ctx.images,
    links: ctx.links,
    byline: meta.byline || '',
    blocked,
    blockedReason: blocked ? '页面是反爬验证页，没有拿到正文' : '',
  };
}
