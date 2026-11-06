# dsh-collect 闆嗘垚濂戠害锛圕ONTRACT锛?
鏈枃浠舵槸**鍞竴鎺ュ彛鐪熸簮**銆傚洓涓ā鍧楀苟琛屽紑鍙戯紝鎵€鏈夎法妯″潡璋冪敤蹇呴』涓ユ牸鎸夋湰鏂囦欢銆?浠讳綍涓€鏂硅鏀规帴鍙ｏ紝蹇呴』鍏堢敱 Lead 鏀规湰鏂囦欢骞堕€氱煡鎵€鏈変汉銆?
---

## 0. 浜у搧鏄粈涔?
`dsh-collect`锛堜腑鏂囧悕銆岄噰鏂?路 CollectKit銆嶏級鏄?DeepSeek Harness 鐨勪竴涓彃浠讹細

1. **宸︿晶杈规爮**澶氫竴涓€岄噰鏂囥€嶅浘鏍囷紝鐐瑰紑鏄竴涓嫭绔嬮潰鏉块〉銆?2. 闈㈡澘閲屽彲浠ラ€夋嫨**淇℃伅鑾峰彇鏂瑰紡**锛堝師鐢熻仈缃?/ 鐩磋繛鎶撳彇 / 娴忚鍣ㄦ爣绛鹃〉 / 妗岄潰鎿嶆帶 / MCP锛夛紝
   骞朵笖鏄庣‘缁欏嚭銆屾槸鍚﹀厑璁?computer 鎿嶆帶绫绘彃浠躲€嶇殑寮€鍏筹紙榛樿鍏抽棴 = 纭嫤鎴級銆?3. 杈撳叆缃戝潃 鈫?鎻掍欢鑷繁鍘绘妸缃戦〉鐨?*姝ｆ枃 + 鍥剧墖**鍙栦笅鏉ワ紝瀛樿繘宸ヤ綔鐩綍銆?4. 渚濇嵁鍙栧埌鐨勫唴瀹癸紝**鐢熸垚鎸囧畾鏍煎紡鏂囦欢**锛歚docx / xlsx / pptx / pdf / md / html / txt / csv / json`銆?5. 鍚屾椂缁?Agent 鎻愪緵涓変釜宸ュ叿锛坄collect_fetch` / `collect_export` / `collect_settings`锛夛紝
   闈㈡澘鍜屽伐鍏疯皟鐢ㄥ悓涓€濂楀簳灞傚疄鐜般€?
杩愯鐜锛欴eepSeek Harness锛圗lectron 妗岄潰鐗?/ Web 鐗堬級锛孨ode.js >= 22锛孍SM锛?*闆剁涓夋柟渚濊禆**銆?
---

## 1. 鐩綍缁撴瀯涓庡綊灞烇紙璋佸啓鍝釜鏂囦欢锛屼弗绂佽法鐣岋級

```
dsh-collect/
鈹溾攢 package.json               Lead
鈹溾攢 cordis.patch.yml           Lead
鈹溾攢 icon.svg                   Lead
鈹溾攢 CONTRACT.md                Lead锛堝彧璇伙紝鍏朵粬浜轰笉瑕佹敼锛?鈹溾攢 README.md                  docs
鈹溾攢 LICENSE                    docs
鈹溾攢 .gitignore                 docs
鈹溾攢 docs/                      docs锛堝畨瑁呫€佷娇鐢ㄣ€丗AQ銆佹牸寮忚鏄庯級
鈹? 鈹溾攢 INSTALL.md
鈹? 鈹溾攢 USAGE.md
鈹? 鈹溾攢 FORMATS.md
鈹? 鈹斺攢 TROUBLESHOOTING.md
鈹溾攢 locale/
鈹? 鈹溾攢 zh.json                 panel-ui
鈹? 鈹斺攢 en.json                 panel-ui
鈹溾攢 lib/
鈹? 鈹溾攢 index.js                Lead锛堟彃浠跺叆鍙?apply锛?鈹? 鈹溾攢 config.js               Lead锛堥厤缃粯璁ゅ€?+ 鏍￠獙 + Config 澹版槑锛?鈹? 鈹溾攢 store.js                Lead锛?DSH_HOME/dsh-collect/settings.json 璇诲啓锛?鈹? 鈹溾攢 routes.js               Lead锛堥潰鏉?HTTP API锛?鈹? 鈹溾攢 tools.js                Lead锛堜笁涓?Agent 宸ュ叿锛?鈹? 鈹溾攢 pipeline.js             Lead锛堥噰闆嗙紪鎺掞細native web 鈫?鐩磋繛 鈫?鎻愮ず闄嶇骇锛?鈹? 鈹溾攢 export.js               Lead锛堟牸寮忓垎鍙戯細Doc 妯″瀷 鈫?鏂囦欢瀛楄妭锛?鈹? 鈹溾攢 http.js                 collect-engine
鈹? 鈹溾攢 extract.js              collect-engine
鈹? 鈹溾攢 img.js                  collect-engine
鈹? 鈹溾攢 save.js                 collect-engine
鈹? 鈹溾攢 client.js               panel-ui
鈹? 鈹斺攢 generate/
鈹?    鈹溾攢 index.js             format-engine锛坮ender 鎬诲叆鍙ｏ級
鈹?    鈹溾攢 zip.js               format-engine
鈹?    鈹溾攢 docx.js              format-engine
鈹?    鈹溾攢 xlsx.js              format-engine
鈹?    鈹溾攢 pptx.js              format-engine
鈹?    鈹溾攢 text.js              format-engine锛坢d / html / txt / csv / json锛?鈹?    鈹斺攢 pdf.js               format-engine锛堟娴?LibreOffice 骞惰浆鎹級
鈹斺攢 test/
   鈹溾攢 generate.test.mjs       format-engine
   鈹斺攢 collect.test.mjs        collect-engine
```

**鍙啓鑷繁鍚嶄笅鐨勬枃浠躲€?* 闇€瑕佸埆浜虹殑鏂囦欢鏀瑰姩鏃讹紝鐢?`send_message` 鎵?Lead銆?
---

## 2. 閫氱敤缂栫爜瑙勫垯锛堟墍鏈夋ā鍧楋級

- Node ESM锛歚import { readFile } from 'node:fs/promises'`锛岀浉瀵瑰鍏ュ繀椤诲甫 `.js` 鍚庣紑銆?- **绂佹** import 浠讳綍 `@deepseek-ai/*` 鍖呫€佺姝?npm 渚濊禆锛堝涓婚噷瑙ｆ瀽涓嶅埌浼氭暣鍖呭穿锛夈€?- 鍙敤 Node 鍐呯疆妯″潡锛涗笉瑕佺敤 `require`銆?- 浠ｇ爜閲?*涓嶈鍑虹幇浠讳綍鏈満涓汉淇℃伅**锛氫笉寰楀嚭鐜扮湡瀹炵敤鎴峰悕銆乣C:\Users\...`銆佹闈㈣矾寰勩€?  鏈哄櫒鍚嶃€佷細璇?id銆傜ず渚嬭矾寰勪竴寰嬪啓 `C:\path\to\...` 鎴?`~/...` 杩欑鍗犱綅銆?- 娉ㄩ噴鐢ㄤ腑鏂囷紝闈㈠悜缁存姢鑰咃紱涓嶈鍐?AI 鐢熸垚"涔嬬被瀛楁牱銆?- 涓嶈 `console.log` 鍒峰睆锛涢渶瑕佹棩蹇楁椂鐢ㄨ皟鐢ㄦ柟浼犲叆鐨?`log` 鍥炶皟鎴?`console.error`銆?- 鎵€鏈夊鍑哄嚱鏁拌鏈?JSDoc 绫诲瀷娉ㄩ噴銆?- 鏃堕棿銆侀殢鏈烘暟銆佺綉缁滀竴寰嬮€氳繃鍙傛暟娉ㄥ叆锛屼究浜庢祴璇曪紙鐢熸垚鍣ㄥ繀椤绘槸绾嚱鏁帮級銆?
---

## 3. Doc 妯″瀷锛堟枃妗ｄ腑闂磋〃绀猴紝鍏ㄩ」鐩敮涓€瀹氫箟锛?
鐢熸垚鍣ㄥ彧璁よ繖涓€涓ā鍨嬨€傞噰闆嗗櫒璐熻矗鎶婄綉椤靛彉鎴愯繖涓ā鍨嬶紙鎴栫敱 Lead 鐨?export.js 鎶?Markdown 鍙樻垚瀹冿級銆?
```js
/**
 * @typedef {Object} Doc
 * @property {string} [title]        鏂囨。鏍囬
 * @property {string} [subtitle]     鍓爣棰橈紙鏉ユ簮銆佹棩鏈熺瓑锛? * @property {string} [sourceUrl]    鏉ユ簮缃戝潃
 * @property {string} [collectedAt]  ISO 鏃堕棿瀛楃涓? * @property {Block[]} blocks        姝ｆ枃鍧楋紝鎸夐『搴? */

/**
 * @typedef {(
 *   { type:'heading',  level:1|2|3, text:string } |
 *   { type:'paragraph', text:string } |
 *   { type:'quote',    text:string } |
 *   { type:'bullets',  items:string[] } |
 *   { type:'numbered', items:string[] } |
 *   { type:'code',     text:string, lang?:string } |
 *   { type:'table',    headers:string[], rows:string[][] } |
 *   { type:'image',    src:string, alt?:string, caption?:string } |
 *   { type:'pagebreak' }
 * )} Block
 */
```

`src` 鏄?*瀹夸富鏂囦欢绯荤粺涓婄殑缁濆璺緞**锛堝浘鐗囧凡缁忎笅杞藉埌宸ヤ綔鐩綍锛夈€?鐢熸垚鍣ㄤ笉鑷繁璇荤洏锛氬浘鐗囧瓧鑺傞€氳繃 `opts.readImage(src)` 鎷裤€?
---

## 4. `lib/generate/index.js`锛坒ormat-engine 鎻愪緵锛孡ead 璋冪敤锛?
```js
export const FORMATS = ['md','html','txt','csv','json','docx','xlsx','pptx','pdf'];

/**
 * @param {string} format  涓婅〃涔嬩竴锛堝皬鍐欙級
 * @param {Doc} doc
 * @param {RenderOptions} opts
 * @returns {Promise<{ data: Uint8Array, mime: string, ext: string, note?: string }>}
 */
export async function render(format, doc, opts);

/**
 * @typedef {Object} RenderOptions
 * @property {(src: string) => Promise<{buffer: Uint8Array, mime: string, width: number, height: number} | null>} readImage
 *   璇诲彇鍥剧墖锛涜繑鍥?null 琛ㄧず璺宠繃璇ュ浘锛堜笉瑕佹姏閿欙級銆? * @property {{ kind:'node-cli', node:string, cli:string } |
 *            { kind:'soffice', bin:string } | null} [converter]
 *   PDF 杞崲鍣紙Lead 妫€娴嬪悗浼犲叆锛夈€俷ull/缂虹渷 = 娌℃湁杞崲鍣紝render('pdf') 蹇呴』鎶?PdfUnavailableError銆? * @property {(message: string) => void} [log]
 */

/** PDF 涓嶅彲鐢ㄦ椂鎶涘嚭锛沵essage 鏄粰鐢ㄦ埛鐪嬬殑涓枃璇存槑銆?*/
export class PdfUnavailableError extends Error { constructor(message, cause) {...} }
```

澶辫触璇箟锛?
- `format` 涓嶈璇?鈫?`throw new Error('unknown format: ' + format)`銆?- `pdf` 涓旀病鏈?`converter` 鈫?`throw new PdfUnavailableError('...')`锛圠ead 浼氶檷绾ф垚 docx + 鎻愮ず锛夈€?- 鍥剧墖璇讳笉鍒?鈫?鐢熸垚鍣ㄨ烦杩囪鍥撅紝缁濅笉鏁翠綋澶辫触銆?
---

## 5. `lib/http.js` / `lib/extract.js` / `lib/img.js` / `lib/save.js`锛坈ollect-engine 鎻愪緵锛?
### 5.1 http.js

```js
/**
 * @param {string} url
 * @param {FetchOptions} [opts]
 * @returns {Promise<FetchResult>}
 */
export async function fetchUrl(url, opts);
export async function fetchBinary(url, opts); // 鍚?fetchUrl锛屼絾涓嶅仛鏂囨湰瑙ｇ爜锛岃繑鍥炲師濮?Buffer

/**
 * @typedef {Object} FetchOptions
 * @property {number} [timeoutMs=20000]
 * @property {number} [maxBytes=8*1024*1024]
 * @property {Record<string,string>} [headers]
 * @property {string} [method='GET']
 * @property {string} [body]
 * @property {number} [redirectLimit=6]
 * @property {string} [userAgent]      榛樿 'dsh-collect/1.0 (+https://github.com/)'
 * @property {boolean} [allowPrivate=false]  false 鏃舵嫆缁?localhost / 绉佹湁缃戞 / 闈?http(s)锛圫SRF 闃叉姢锛? *
 * @typedef {Object} FetchResult
 * @property {boolean} ok            status 200-299
 * @property {number} status
 * @property {string} finalUrl       璺熼殢閲嶅畾鍚戝悗鐨勫湴鍧€
 * @property {string} contentType
 * @property {Record<string,string>} headers
 * @property {Buffer} body
 * @property {number} bytes
 * @property {string} [error]        澶辫触鏃剁殑涓枃鍘熷洜锛堟鏃?ok=false, status 鍙兘涓?0锛? */
```

瑕佹眰锛歡zip/deflate/br 瑙ｅ帇銆佽秴鏃讹紙AbortController锛夈€佸瓧鑺傛暟涓婇檺銆侀噸瀹氬悜娆℃暟涓婇檺銆?鍗忚鍙厑璁?http/https銆乣allowPrivate=false` 鏃惰В鏋愪富鏈哄苟鎷掔粷 loopback/绉佹湁鍦板潃銆?
### 5.2 extract.js

```js
/**
 * 缃戦〉 HTML 鈫?缁撴瀯鍖栨枃绔犮€? * @param {string} html
 * @param {string} baseUrl
 * @returns {{
 *   title: string, siteName: string, lang: string, description: string,
 *   markdown: string, text: string,
 *   images: {url:string, alt:string}[],
 *   links: {url:string, text:string}[],
 *   byline: string
 * }}
 */
export function extractArticle(html, baseUrl);

/** HTML 鈫?Markdown锛坋xtractArticle 鐨勫簳灞傦紝涔熷崟鐙鍑猴級銆?*/
export function htmlToMarkdown(html, baseUrl);
```

瑕佹眰锛?- 鍘?`script/style/noscript/nav/footer/aside/form/svg`锛涙鏂囧惎鍙戝紡锛堟渶闀挎枃鏈潡/`<article>`/`<main>` 浼樺厛锛夈€?- 鏀寔 `h1~h6 / p / ul / ol / li / blockquote / pre / code / table / img / a / br / hr / strong / em`銆?- 瀹炰綋瑙ｇ爜锛堣嚦灏?`&amp; &lt; &gt; &quot; &#39; &nbsp;` 涓庢暟瀛楀疄浣擄級銆?- 鍥剧墖 `src` 瑙ｆ瀽涓?*缁濆 URL**锛宍data:` 寮€澶寸殑涓㈠純锛涘悓涓€ URL 鍘婚噸銆?- 鐩稿閾炬帴鍏ㄩ儴鍩轰簬 `baseUrl` 瑙ｆ瀽銆?- 涓嶄緷璧?DOM/绗笁鏂瑰簱锛岀函姝ｅ垯 + 鐘舵€佹満锛涘崟鏂囦欢 鈮?500 琛屻€?
### 5.3 img.js

```js
/** 浠庡瓧鑺傚ご璇嗗埆鍥剧墖鏍煎紡涓庡昂瀵搞€傛敮鎸?png / jpeg / gif / webp锛岃瘑鍒笉浜嗚繑鍥?null銆?*/
export function sniffImage(buffer); // -> {mime, ext, width, height} | null
/** 浠?URL/Content-Type 鎺ㄦ柇鎵╁睍鍚嶃€?*/
export function guessImageExt(url, contentType); // -> 'png'|'jpg'|'gif'|'webp'|'bin'
```

### 5.4 save.js

```js
/**
 * 鎶婁竴鏉￠噰闆嗙粨鏋滆惤鐩樺埌 rootDir/<slug>/銆? * @param {SaveItem} item
 * @param {{rootDir: string, fetchImage?: (url:string)=>Promise<{buffer:Buffer, mime:string}|null>, log?: Function}} options
 * @returns {Promise<{dir:string, markdownPath:string, metaPath:string,
 *                    imagesSaved:number, imageFiles:string[], bytes:number}>}
 *
 * @typedef {Object} SaveItem
 * @property {string} url
 * @property {string} title
 * @property {string} siteName
 * @property {string} markdown       姝ｆ枃 Markdown锛堝浘鐗囧凡琚浛鎹负 ./鍥剧墖/NNN.ext 鐨勭浉瀵瑰紩鐢ㄦ椂浼樺厛锛? *                                   鏈浛鎹㈡椂鎸?images 椤哄簭鑷姩鏇挎崲锛? * @property {string} text
 * @property {{url:string, alt:string}[]} images
 * @property {string} collectedAt ISO
 * @property {string} method       'native-web' | 'direct-http'
 */
export function slugify(title, url); // 鍚堟硶鏂囦欢鍚嶏紝鈮?48 瀛楃锛屽幓閲嶉潬璋冪敤鏂瑰姞搴忓彿
export function uniqueDir(rootDir, slug); // -> 涓嶅啿绐佺殑鐩綍鍚嶏紙杩藉姞 -2/-3锛?```

钀界洏鍐呭锛歚index.md`锛堝惈 YAML front matter锛歵itle/url/source/collected_at锛夈€乣meta.json`銆乣鍥剧墖/001.ext鈥銆?鍥剧墖淇濆瓨鏁伴噺涓婇檺鐢辫皟鐢ㄦ柟鎺у埗锛堜紶杩涙潵鐨?`images` 宸叉埅鏂級銆?
---

## 6. `lib/client.js`锛坧anel-ui 鎻愪緵锛?
### 6.1 妯″潡褰㈡€侊紙蹇呴』瀹屽叏鐓ф妱杩欎釜楠ㄦ灦锛?
```js
window.__ModuleLoader__.load({
  id: 'dsh-collect',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // ...缁勪欢...
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'dsh-collect', order: 12, label: () => '閲囨枃' },
          (props) => h(PanelIcon, props),
        ));
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'dsh-collect' },
          () => h(Panel),
        ));
      },
    };
  },
});
```

渚ц竟鏍忓浘鏍囩粍浠舵敹鍒?`{ size, active }` 涓や釜 prop锛堥兘瑕佺敤涓婏級銆?
### 6.2 闈㈡澘鏁版嵁鏉ユ簮锛氬彧璧?HTTP

```js
const API = '/dsh-collect/api';
const HEADERS = { 'content-type': 'application/json', 'x-collect-client': '1' };
```

| 鏂规硶 | 璺緞 | 璇锋眰 | 鍝嶅簲 |
| --- | --- | --- | --- |
| GET | `/state` | 鈥?| `{ ok:true, version, config, capabilities, workspace, items }` |
| POST | `/settings` | `{ patch }`锛堟繁鍚堝苟锛?| `{ ok:true, config }` |
| POST | `/collect` | `{ urls:string[], options? }` | `{ ok:true, items:[ItemResult] }` |
| POST | `/export` | `{ slug, format, title? }` | `{ ok:true, file:{ rel, path, bytes, mime }, note? }` |
| GET | `/items` | 鈥?| `{ ok:true, items }` |
| GET | `/item?rel=<鐩稿璺緞>` | 鈥?| `{ ok:true, markdown, meta }` |
| GET | `/file?rel=<鐩稿璺緞>` | 鈥?| 鏂囦欢瀛楄妭锛堜笅杞斤級 |

```js
/** config锛堝彲鍐欏瓧娈典笌榛樿鍊硷級 */
{
  acquisition: { nativeWeb:true, directHttp:true, browserTabs:false, computerUse:false, mcpTools:false },
  output: { dir:'閲囨枃杈撳嚭', saveImages:true, imageLimit:20, maxBytes:8388608, timeoutMs:20000 },
  pdf: { converter:'' },      // 鐣欑┖ = 鑷姩妫€娴?  defaultFormat: 'docx'
}

/** capabilities锛堝彧璇伙紝鐢ㄤ簬闈㈡澘鏄剧ず"鍙敤/涓嶅彲鐢?锛?*/
{
  nativeWeb: boolean,            // 瀹夸富鏈夋病鏈夊彲鐢ㄧ殑鑱旂綉鏈嶅姟
  directHttp: true,              // 鏈彃浠惰嚜甯︼紝鎭?true
  browserTabs: { available:boolean, hint:string },
  computerUse: { available:boolean, hint:string },
  mcpTools: { available:boolean, count:number, hint:string },
  pdf: { available:boolean, reason:string }
}

/** workspace */
{ root: string, outputRoot: string, exists: boolean }

/** ItemResult */
{ ok:boolean, url:string, title?:string, slug?:string, chars?:number, images?:number,
  dir?:string, rel?:string, method?:string, error?:string }
```

鎵€鏈夐敊璇搷搴旂粺涓€ `{ ok:false, error:string }`锛岄潪 2xx 鐘舵€佺爜銆?
### 6.3 闈㈡澘瑕佹湁浠€涔堬紙瑙嗚/浜や簰锛?
鍗曢〉婊氬姩锛屽搴﹁嚜閫傚簲锛屽垎 5 涓尯锛堢敤鍗＄墖寮忓垎缁勶紝闂磋窛 16px锛屽崱鐗囧唴杈硅窛 16px锛夛細

1. **椤舵爮**锛氭爣棰樸€岄噰鏂?路 CollectKit銆? 鍙充晶灏忓瓧鐗堟湰鍙?+ 銆屽埛鏂般€嶆寜閽€?2. **淇℃伅鑾峰彇鏂瑰紡**锛?~6 琛屽紑鍏筹紙switch锛夛紝姣忚 = 宸︿晶鍚嶇О+涓€琛岀伆瀛楄鏄?+ 鍙充晶寮€鍏炽€?   - 鍘熺敓鑱旂綉锛堝涓诲唴缃殑缃戦〉鎶撳彇/鎼滅储锛?   - 鐩磋繛鎶撳彇锛堟彃浠惰嚜宸辫闂綉绔欙級
   - 娴忚鍣ㄦ爣绛鹃〉锛堟棤榧犳爣鎿嶄綔锛岃蛋娴忚鍣ㄨ皟璇曟帴鍙ｏ級
   - 妗岄潰鎿嶆帶锛堜細绉诲姩榧犳爣/閿洏锛岄粯璁ゅ叧闂級
   - MCP 宸ュ叿锛堝叾浠栨暟鎹簮鎻掍欢锛?   姣忚鍙充晶鍙樉绀鸿兘鍔涘窘绔狅紙鍙敤/鏈畨瑁咃級鈥斺€旀潵鑷?`capabilities`銆?   鏀瑰姩绔嬪嵆 `POST /settings`锛堜箰瑙傛洿鏂帮紝澶辫触鍥炴粴骞舵彁绀猴級銆?3. **閲囬泦**锛歎RL 澶氳杈撳叆锛堟瘡琛屼竴涓紝鏀寔閫楀彿/绌烘牸鍒嗛殧锛?銆屽紑濮嬮噰闆嗐€嶆寜閽紱
   閲囬泦鏃舵寜閽?loading銆佹樉绀?姝ｅ湪閲囬泦绗?n/m 涓?锛涘畬鎴愬悗涓嬫柟鍑虹幇缁撴灉鍒楄〃锛?   姣忚鏄剧ず鏍囬銆佹潵婧愬煙鍚嶃€佸瓧鏁般€佸浘鐗囨暟銆佹柟寮忓窘绔犮€佷繚瀛樼浉瀵硅矾寰勶紱
   銆屾煡鐪嬫鏂囥€嶅睍寮€ Markdown 棰勮锛堝彧璇?pre锛屾渶澶?4000 瀛楃锛夈€?4. **鐢熸垚鏂囦欢**锛氭牸寮忔寜閽粍锛? 涓紝褰撳墠閫変腑鐨勯珮浜級+銆岀敓鎴愩€嶆寜閽?+ 涓婃鐢熸垚缁撴灉
   锛堟枃浠跺悕銆佸ぇ灏忋€佷笅杞介摼鎺?`/dsh-collect/api/file?rel=...`锛夈€?5. **璁剧疆**锛氳緭鍑虹洰褰曘€佸崟椤垫渶澶у瓧鑺傘€佽秴鏃舵绉掋€佸浘鐗囦笂闄愩€佹槸鍚︿笅杞藉浘鐗囷紱
   搴曢儴銆屼繚瀛樿缃€嶃€?
缁嗚妭瑕佹眰锛?- 鎵€鏈夐鑹插彧鐢?`var(--dsw-alias-*)` 涓婚鍙橀噺锛堣 6.4锛夛紝鏈畾涔夋椂鍐欑浜屽弬鏁?fallback銆?- 寮€鍏冲繀椤绘槸 `role="switch"` + `aria-checked`锛屽彲閿洏鎿嶄綔锛坆utton 鍏冪礌锛夈€?- 涓嶈鐢?iframe锛屼笉瑕?`document.body` 杩藉姞鑺傜偣锛屼笉瑕佽鍒殑鎻掍欢 DOM銆?- 缁勪欢鍐?`<style>` 鐢?`<style>` 鍏冪礌娓叉煋鍦ㄨ繑鍥炴爲涓婏紙闅忓嵏杞界Щ闄わ級锛宑lass 鍚嶅姞 `dshc-` 鍓嶇紑銆?- 涓嫳鍙岃锛歚const zh = locale.startsWith('zh')`锛岀敤 `ctx.locale?.getSnapshot?.().id` 鍒ゆ柇锛?  鍙栦笉鍒板氨鐢ㄤ腑鏂囥€傛墍鏈夋枃妗堥泦涓湪涓€涓?`const T = {...}` 瀵硅薄閲屻€?- 棣栨鎸傝浇 `GET /state`锛涜姹傚け璐ヨ鏄剧ず鍙閿欒锛屼笉瑕佹妸寮傚父鍚炴帀銆?- 闈㈡澘鍗歌浇鏃朵腑姝㈡湭瀹屾垚鐨?fetch锛圓bortController锛夈€?
### 6.4 鍙敤鐨勪富棰樺彉閲忥紙鍙湁杩欎簺锛?
```
--dsw-alias-bg-base            搴旂敤搴曡壊
--dsw-alias-bg-layer-1         鍗＄墖闈?--dsw-alias-bg-layer-2         娆＄骇鍐呭祵闈?--dsw-alias-bg-overlay         娴眰
--dsw-alias-border-l1          缁嗚竟妗?--dsw-alias-border-l2          寮鸿竟妗?--dsw-alias-brand-primary      寮鸿皟鑹?--dsw-alias-label-primary      涓绘枃瀛?--dsw-alias-label-secondary    娆℃枃瀛?--dsw-alias-state-error-primary 閿欒
--dsw-alias-state-idle-primary  绂佺敤/闈欓粯
--dsw-alias-state-success-primary 鎴愬姛
--dsw-alias-state-warn-primary  璀﹀憡
--dsw-specific-sidebar-fill    渚ц竟鏍忓簳鑹?```

### 6.5 locale/zh.json銆乴ocale/en.json

```json
{ "meta": { "title": "閲囨枃 路 CollectKit", "description": "宸︿晶杈规爮閲囬泦闈㈡澘锛氭姄鍙栫綉椤垫鏂囦笌鍥剧墖锛屾寜闇€鐢熸垚 docx/xlsx/pptx/pdf 绛夋枃浠躲€? } }
```

鑻辨枃 `title` 鐢?"CollectKit"锛屾弿杩颁竴鍙ヨ瘽銆傝繖鏄彃浠剁鐞嗗櫒鍒楄〃鏄剧ず鐢ㄧ殑鍏冩暟鎹€?
---

## 7. 娴嬭瘯瑕佹眰锛堟彁浜ゅ墠蹇呴』鑷繁璺戣繃锛?
format-engine锛?
```bash
# 鐢ㄥ涓昏嚜甯︾殑 node锛堣矾寰勮涓嬶級鍦?test/ 閲屽缓涓存椂鐩綍璺?node test/generate.test.mjs
```

- 鑷冲皯瑕嗙洊锛歮d/html/txt/csv/json 鐨勫瓧绗︿覆鏂█锛沝ocx/xlsx/pptx 鐢熸垚鍚?  **鐢?python 鎵撳紑楠岃瘉**锛堣矾寰勭敱 Lead 鎻愪緵锛屽湪 test 鑴氭湰閲岄€氳繃鐜鍙橀噺璇诲彇锛?  **涓嶈鎶婅繖浜涚粷瀵硅矾寰勫啓杩涗粨搴撴枃浠?*锛夈€?- 閫愭牸寮忔柇瑷€锛氭枃浠堕潪绌恒€亃ip 榄旀暟 `PK\x03\x04`銆乸ython 鑳芥墦寮€骞惰鍒伴鏈熸爣棰樻枃瀛椼€?
collect-engine锛?
```bash
node test/collect.test.mjs
```

- extract 鐢ㄥ唴鑱旂殑 HTML 瀛楃涓叉柇瑷€锛堜笉鑱旂綉锛侊級锛氭爣棰樸€佹鏂囥€佸浘鐗囩粷瀵瑰寲銆佽〃鏍笺€佸垪琛ㄣ€?- http 鐢ㄦ湰鍦?`node:http` 鏈嶅姟鍣ㄦ祴閲嶅畾鍚?gzip/瓒呮椂/澶у搷搴旀埅鏂?绉佹湁鍦板潃鎷掔粷銆?- save 鍐欏埌 `os.tmpdir()` 涓嬬殑鍞竴鐩綍锛岀粨鏉熸竻鐞嗐€?
---

## 8. 瀹屾垚瀹氫箟锛圖efinition of Done锛?
- 鑷繁鍚嶄笅鐨勬枃浠跺叏閮ㄥ啓瀹岋紝`node --check <file>` 閫氳繃锛坈lient.js 涔熻鑳借繃璇硶妫€鏌ワ級銆?- 鑷繁鐨勬祴璇曡剼鏈兘璺戦€氾紝骞跺湪鍥炴姤閲岃创鍏抽敭杈撳嚭銆?- 娌℃湁 TODO 鍗犱綅銆佹病鏈夋湭瀹炵幇鐨勫垎鏀€佹病鏈?`throw new Error('not implemented')`銆?- 鏂囦欢閲屾病鏈変换浣曟湰鏈洪殣绉佷俊鎭€?- 鍥炴姤閲屽啓锛氭敼浜嗕粈涔堟枃浠躲€佹€庝箞楠岃瘉鐨勩€佽繕鍓╀粈涔堥闄┿€?
