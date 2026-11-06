// collect-engine 自测：extract / img / http / save
//
// 运行：node test/collect.test.mjs
// 全程不联网：http 部分用本地 127.0.0.1 随机端口的 node:http 服务器；
// save 写到 os.tmpdir() 下的唯一目录，结束后删除。

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { fetchUrl, fetchBinary } from '../lib/http.js';
import { extractArticle, htmlToMarkdown } from '../lib/extract.js';
import { sniffImage, guessImageExt } from '../lib/img.js';
import { saveArticle, slugify } from '../lib/save.js';

// ── 内联素材 ─────────────────────────────────────────────────────────────────

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta property="og:title" content="城市更新中的社区参与：一项田野观察">
  <meta property="og:site_name" content="示例新闻网">
  <meta name="description" content="记者走访三个老旧小区，记录居民参与改造的过程。">
  <meta name="author" content="记者 李四">
  <title>页面标题不应优先 - 示例新闻网</title>
  <style>body{color:red}</style>
</head>
<body>
  <nav class="main-nav"><a href="/">首页</a><a href="/news">新闻</a><a href="/about">关于</a></nav>
  <div id="top-bar">登录 | 注册</div>
  <article class="post">
    <header><h1>城市更新中的社区参与：一项田野观察</h1><p class="byline">记者 李四 · 2026-11-06</p></header>
    <p>清晨七点，阳光斜照进和平里的老楼之间。居民们已经聚在院子里，讨论电梯加装的方案。</p>
    <p>“我们最关心的是施工期间的噪音。”一位老人在会上说。这句话被记进了会议纪要&amp;居民的联名信。</p>
    <p>过去半年，社区共召开&lt;12&gt;次协商会，参与人次超过&nbsp;300&nbsp;人。</p>
    <figure>
      <img data-src="/img/photo1.jpg" alt="居民在院子里开会" width="800" height="600">
      <figcaption>2026 年 10 月，和平里社区协商会现场。摄影：李四</figcaption>
    </figure>
    <h2>表格：三次协商会的主要议题</h2>
    <table>
      <thead><tr><th>场次</th><th>时间</th><th>主要议题</th></tr></thead>
      <tbody>
        <tr><td>第一次</td><td>6 月</td><td>电梯加装方案</td></tr>
        <tr><td>第二次</td><td>8 月</td><td>施工噪音与停车</td></tr>
        <tr><td>第三次</td><td>10 月</td><td>公共空间改造</td></tr>
      </tbody>
    </table>
    <h2>居民提出的三点诉求</h2>
    <ul>
      <li>施工时间限定在工作日白天</li>
      <li>保留现有的自行车棚</li>
      <li>增设无障碍坡道</li>
    </ul>
    <blockquote>“改造不是把旧的全拆掉，而是让住在里面的人说了算。”社区规划师说。</blockquote>
    <pre><code class="language-js">const plan = { elevator: true, parking: false };</code></pre>
    <p>更多报道请见 <a href="/topic/1122">专题页面</a>。</p>
    <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="占位">
    <img src="/img/1x1.gif" alt="空图">
    <img src="/img/photo2.jpg" alt="夜间的院子">
    <img src="/img/photo2.jpg" alt="重复的同一张">
  </article>
  <footer>版权所有 © 示例新闻网</footer>
  <script>window.__DATA__ = { a: 1 };</script>
</body>
</html>`;

const LONG_PARAGRAPH = '这条街道的更新计划从去年开始讨论，居民最关心的是车位与绿化如何平衡。'.repeat(6);

const DENSITY_HTML = `<!DOCTYPE html>
<html><head><title>没有 article 的页面</title></head>
<body>
  <nav><a href="/">首页</a><a href="/b">频道</a></nav>
  <div class="sidebar"><ul><li><a href="/x">热门推荐一</a></li><li><a href="/y">热门推荐二</a></li></ul></div>
  <div class="content">
    <h2>街道更新的一年</h2>
    <p>${LONG_PARAGRAPH}</p>
    <p>${LONG_PARAGRAPH}</p>
    <p>${LONG_PARAGRAPH}</p>
  </div>
  <footer>© 版权</footer>
</body></html>`;

// ── img.js ───────────────────────────────────────────────────────────────────

test('sniffImage：识别 png / gif / jpeg / webp', () => {
  const png = sniffImage(PNG_1x1);
  assert.ok(png);
  assert.equal(png.mime, 'image/png');
  assert.equal(png.ext, 'png');
  assert.equal(png.width, 1);
  assert.equal(png.height, 1);

  const gif = sniffImage(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  assert.ok(gif);
  assert.equal(gif.mime, 'image/gif');
  assert.equal(gif.width, 1);

  // 手工拼一个 SOI + APP0 + SOF0（800x600）的 JPEG 头
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00', 'latin1'),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03,
      0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
    Buffer.from([0xff, 0xd9]),
  ]);
  const jpg = sniffImage(jpeg);
  assert.ok(jpg);
  assert.equal(jpg.ext, 'jpg');
  assert.equal(jpg.width, 800);
  assert.equal(jpg.height, 600);

  // VP8X 扩展头的 WebP（800x600）
  const webp = Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'latin1'),
    Buffer.from('VP8X', 'latin1'),
    Buffer.from([0x0a, 0x00, 0x00, 0x00]),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0x1f, 0x03, 0x00]), // 宽 800 - 1
    Buffer.from([0x57, 0x02, 0x00]), // 高 600 - 1
  ]);
  const web = sniffImage(webp);
  assert.ok(web);
  assert.equal(web.mime, 'image/webp');
  assert.equal(web.width, 800);
  assert.equal(web.height, 600);

  assert.equal(sniffImage(Buffer.from('这不是图片，只是普通文本')), null);
});

test('guessImageExt：Content-Type 优先，其次 URL 后缀', () => {
  assert.equal(guessImageExt('https://example.com/a', 'image/png'), 'png');
  assert.equal(guessImageExt('https://example.com/a', 'image/jpeg; charset=binary'), 'jpg');
  assert.equal(guessImageExt('https://example.com/x.PNG?w=2'), 'png');
  assert.equal(guessImageExt('https://example.com/x.jpeg'), 'jpg');
  assert.equal(guessImageExt('https://example.com/x.bin', 'application/octet-stream'), 'bin');
});

// ── extract.js ───────────────────────────────────────────────────────────────

test('extractArticle：中文新闻页（元信息 / 正文 / 表格 / 列表 / 图片）', () => {
  const article = extractArticle(ARTICLE_HTML, 'https://news.example.com/2026/11/06/community.html');
  assert.equal(article.title, '城市更新中的社区参与：一项田野观察');
  assert.equal(article.siteName, '示例新闻网');
  assert.equal(article.lang, 'zh-CN');
  assert.equal(article.byline, '记者 李四');
  assert.ok(article.description.includes('老旧小区'));

  // 正文段落完整
  assert.ok(article.markdown.includes('清晨七点'));
  assert.ok(article.markdown.includes('“我们最关心的是施工期间的噪音。”'));
  // 实体解码
  assert.ok(article.markdown.includes('会议纪要&居民的联名信'));
  assert.ok(article.markdown.includes('<12>次协商会'));
  assert.ok(article.markdown.includes('300 人'));
  // 去噪：导航 / 页脚 / 脚本 / 页面 title
  assert.ok(!article.markdown.includes('首页'));
  assert.ok(!article.markdown.includes('版权所有'));
  assert.ok(!article.markdown.includes('window.__DATA__'));
  assert.ok(!article.markdown.includes('页面标题不应优先'));
  assert.ok(!article.markdown.includes('color:red'));
  // 标题层级 / 列表 / 引用 / 代码块
  assert.ok(article.markdown.includes('## 表格：三次协商会的主要议题'));
  assert.ok(article.markdown.includes('- 施工时间限定在工作日白天'));
  assert.ok(article.markdown.includes('> “改造不是把旧的全拆掉'));
  assert.ok(article.markdown.includes('```js\nconst plan = { elevator: true, parking: false };\n```'));
  // 表格
  assert.ok(/\|\s*场次\s*\|\s*时间\s*\|\s*主要议题\s*\|/.test(article.markdown));
  assert.ok(article.markdown.includes('| --- | --- | --- |'));
  assert.ok(article.markdown.includes('| 第三次 | 10 月 | 公共空间改造 |'));
  // 图片：绝对化、占位图丢弃、同 URL 去重
  assert.deepEqual(article.images.map((image) => image.url), [
    'https://news.example.com/img/photo1.jpg',
    'https://news.example.com/img/photo2.jpg',
  ]);
  assert.ok(article.markdown.includes('![居民在院子里开会](https://news.example.com/img/photo1.jpg)'));
  assert.ok(!article.markdown.includes('1x1.gif'));
  assert.ok(!article.markdown.includes('data:image'));
  // 链接绝对化
  assert.ok(article.markdown.includes('[专题页面](https://news.example.com/topic/1122)'));
  assert.ok(article.links.some((link) => link.url === 'https://news.example.com/topic/1122'));
  // 文本与段落不丢、无三连空行
  assert.ok(article.text.includes('社区规划师'));
  assert.ok(!/\n{3,}/.test(article.markdown));
});

test('extractArticle：无 article/main 时按文本密度挑容器', () => {
  const article = extractArticle(DENSITY_HTML, 'https://example.com/news/1');
  assert.equal(article.title, '没有 article 的页面');
  assert.ok(article.markdown.includes('## 街道更新的一年'));
  assert.ok(article.markdown.includes('车位与绿化如何平衡'));
  assert.ok(!article.markdown.includes('热门推荐'));
  assert.ok(!article.markdown.includes('© 版权'));
});

test('htmlToMarkdown：基础标签与嵌套列表', () => {
  const md = htmlToMarkdown(
    '<h2>二级标题</h2><p>正文<strong>加粗</strong>和<em>斜体</em>与<code>行内代码</code>。</p>'
    + '<hr><ol><li>第一</li><li>第二<ul><li>嵌套</li></ul></li></ol><p><br>收尾</p>',
    'https://example.com/a/b',
  );
  assert.ok(md.includes('## 二级标题'));
  assert.ok(md.includes('**加粗**'));
  assert.ok(md.includes('*斜体*'));
  assert.ok(md.includes('`行内代码`'));
  assert.ok(md.split('\n').includes('---'));
  assert.ok(md.includes('1. 第一'));
  assert.ok(md.includes('2. 第二'));
  assert.ok(md.includes('  - 嵌套'));
  assert.ok(md.includes('收尾'));
  assert.ok(!/\n{3,}/.test(md));
});

// ── http.js（本地服务器，不联网） ────────────────────────────────────────────

const GBK_TEXT = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]); // 「中文测试」的 GBK 字节

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  res.on('error', () => { /* 客户端提前断开时忽略写错误 */ });
  switch (pathname) {
    case '/plain':
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('hello 采文');
      return;
    case '/gzip': {
      const body = zlib.gzipSync(Buffer.from('<html><body><p>压缩过的中文正文</p></body></html>', 'utf8'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
      res.end(body);
      return;
    }
    case '/deflate': {
      const body = zlib.deflateSync(Buffer.from('deflate 中文正文', 'utf8'));
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-encoding': 'deflate' });
      res.end(body);
      return;
    }
    case '/br': {
      const body = zlib.brotliCompressSync(Buffer.from('brotli 中文正文', 'utf8'));
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-encoding': 'br' });
      res.end(body);
      return;
    }
    case '/gbk':
      res.writeHead(200, { 'content-type': 'text/html; charset=gbk' });
      res.end(GBK_TEXT);
      return;
    case '/redirect':
      res.writeHead(302, { location: '/hop' });
      res.end();
      return;
    case '/hop':
      res.writeHead(302, { location: '/final' });
      res.end();
      return;
    case '/final':
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('重定向终点');
      return;
    case '/loop':
      res.writeHead(302, { location: '/loop' });
      res.end();
      return;
    case '/slow':
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('late');
      }, 400);
      return;
    case '/big':
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(Buffer.alloc(20000, 0x41));
      return;
    default:
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
  }
});
server.on('clientError', (err, socket) => socket.destroy());

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

after(() => {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close();
});

test('http：gzip / deflate / br 解压与中文解码', async () => {
  const gzip = await fetchUrl(`${ORIGIN}/gzip`, { allowPrivate: true });
  assert.equal(gzip.ok, true);
  assert.equal(gzip.status, 200);
  assert.ok(gzip.text.includes('压缩过的中文正文'));
  assert.equal(gzip.truncated, false);
  assert.ok(Buffer.isBuffer(gzip.body));

  const deflate = await fetchUrl(`${ORIGIN}/deflate`, { allowPrivate: true });
  assert.equal(deflate.ok, true);
  assert.ok(deflate.text.includes('deflate 中文正文'));

  const br = await fetchUrl(`${ORIGIN}/br`, { allowPrivate: true });
  assert.equal(br.ok, true);
  assert.ok(br.text.includes('brotli 中文正文'));
});

test('http：按响应头 charset 解码 GBK 页面', async () => {
  const result = await fetchUrl(`${ORIGIN}/gbk`, { allowPrivate: true });
  assert.equal(result.ok, true);
  assert.equal(result.charset, 'gbk');
  assert.equal(result.text, '中文测试');
});

test('http：跟随重定向并返回 finalUrl', async () => {
  const result = await fetchUrl(`${ORIGIN}/redirect`, { allowPrivate: true });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.finalUrl, `${ORIGIN}/final`);
  assert.equal(result.text, '重定向终点');
});

test('http：重定向次数上限', async () => {
  const result = await fetchUrl(`${ORIGIN}/loop`, { allowPrivate: true, redirectLimit: 2 });
  assert.equal(result.ok, false);
  assert.match(result.error, /重定向次数超过上限/);
});

test('http：超时', async () => {
  const result = await fetchUrl(`${ORIGIN}/slow`, { allowPrivate: true, timeoutMs: 100 });
  assert.equal(result.ok, false);
  assert.match(result.error, /超时/);
});

test('http：超大响应按 maxBytes 截断并标记', async () => {
  const result = await fetchUrl(`${ORIGIN}/big`, { allowPrivate: true, maxBytes: 1000 });
  assert.equal(result.ok, true);
  assert.equal(result.body.length, 1000);
  assert.equal(result.bytes, 1000);
  assert.equal(result.truncated, true);
});

test('http：SSRF 防护拒绝本机/私有地址与非 http 协议', async () => {
  const privateBlocked = await fetchUrl(`${ORIGIN}/plain`);
  assert.equal(privateBlocked.ok, false);
  assert.match(privateBlocked.error, /SSRF|私有|本机/);

  const badProtocol = await fetchUrl('ftp://example.com/a');
  assert.equal(badProtocol.ok, false);
  assert.match(badProtocol.error, /不支持的协议/);

  const badUrl = await fetchUrl('这不是网址');
  assert.equal(badUrl.ok, false);
  assert.match(badUrl.error, /无效的网址/);

  // 空/空值入参也必须拿回 { ok:false }，绝不抛异常
  for (const empty of ['', null, undefined]) {
    const result = await fetchUrl(empty);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
  }

  // IPv6 环回
  const loopback6 = await fetchUrl('http://[::1]:9/');
  assert.equal(loopback6.ok, false);
  assert.match(loopback6.error, /SSRF|私有|本机/);
});

test('http：fetchBinary 返回原始字节', async () => {
  const result = await fetchBinary(`${ORIGIN}/plain`, { allowPrivate: true });
  assert.equal(result.ok, true);
  assert.ok(Buffer.isBuffer(result.body));
  assert.ok(result.body.toString('utf8').includes('hello 采文'));
});

// ── save.js ──────────────────────────────────────────────────────────────────

test('slugify：安全文件名、限长、保留名', () => {
  assert.equal(slugify('城市更新 社区参与'), '城市更新-社区参与');
  assert.ok(!/[\\/:*?"<>|]/.test(slugify('城市更新：社区参与')));
  assert.equal(slugify('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
  assert.ok(Array.from(slugify('长'.repeat(100))).length <= 48);
  assert.equal(slugify('con'), '_con');
  assert.equal(slugify('   '), 'article');
  assert.equal(slugify('..'), 'article');
});

test('saveArticle：index.md + meta.json + 图片 + 目录去重', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-collect-test-'));
  const item = {
    url: 'https://news.example.com/2026/11/06/community.html',
    title: '城市更新/社区参与：一项*田野*观察？<跨年>',
    siteName: '示例新闻网',
    markdown: '# 城市更新中的社区参与\n\n第一段正文。\n\n'
      + '![居民在院子里开会](https://news.example.com/img/photo1.jpg)\n\n'
      + '![夜间的院子](https://news.example.com/img/photo2.jpg)\n\n结尾。\n',
    text: '城市更新中的社区参与 第一段正文。',
    images: [
      { url: 'https://news.example.com/img/photo1.jpg', alt: '居民在院子里开会' },
      { url: 'https://news.example.com/img/photo2.jpg', alt: '夜间的院子' },
    ],
    collectedAt: '2026-11-06T12:00:00.000Z',
    method: 'direct-http',
  };
  try {
    const saved = await saveArticle(item, {
      rootDir,
      fetchImage: async () => ({ buffer: PNG_1x1, mime: 'image/png' }),
    });
    assert.equal(saved.imagesSaved, 2);
    assert.ok(saved.bytes > 0);
    assert.ok(!/[\\/:*?"<>|]/.test(path.basename(saved.dir)));

    const markdown = await readFile(saved.markdownPath, 'utf8');
    assert.ok(markdown.startsWith('---\ntitle: '));
    assert.ok(markdown.includes('url: "https://news.example.com/2026/11/06/community.html"'));
    assert.ok(markdown.includes('source: "示例新闻网"'));
    assert.ok(markdown.includes('collected_at: "2026-11-06T12:00:00.000Z"'));
    assert.ok(markdown.includes('![居民在院子里开会](./图片/001.png)'));
    assert.ok(markdown.includes('![夜间的院子](./图片/002.png)'));
    assert.ok(!markdown.includes('https://news.example.com/img/photo1.jpg'));
    assert.ok(markdown.includes('第一段正文。'));

    const imageFiles = await readdir(path.join(saved.dir, '图片'));
    assert.deepEqual(imageFiles.sort(), ['001.png', '002.png']);

    const meta = JSON.parse(await readFile(saved.metaPath, 'utf8'));
    assert.equal(meta.method, 'direct-http');
    assert.equal(meta.siteName, '示例新闻网');
    assert.equal(meta.images.length, 2);
    assert.equal(meta.images[0].file, './图片/001.png');

    // 同名再来一次 → 目录追加 -2
    const second = await saveArticle(item, {
      rootDir,
      fetchImage: async () => ({ buffer: PNG_1x1, mime: 'image/png' }),
    });
    assert.notEqual(second.dir, saved.dir);
    assert.ok(path.basename(second.dir).endsWith('-2'));

    // 已经替换好的 ./图片 引用保持原样
    const replaced = await saveArticle(
      { ...item, markdown: '![居民在院子里开会](./图片/001.png)' },
      { rootDir, fetchImage: async () => ({ buffer: PNG_1x1, mime: 'image/png' }) },
    );
    const replacedMarkdown = await readFile(replaced.markdownPath, 'utf8');
    assert.ok(replacedMarkdown.includes('![居民在院子里开会](./图片/001.png)'));

    // 没有 fetchImage 时不下载图片，也不建图片目录
    const noImages = await saveArticle({ ...item, images: [] }, { rootDir });
    assert.equal(noImages.imagesSaved, 0);
    assert.ok(await readFile(noImages.markdownPath, 'utf8'));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
