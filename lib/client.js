// dsh-collect · 浏览器半边：左侧边栏「采文」图标 + 采集面板
//
// 契约见 CONTRACT.md §6：
//   - 手写、零构建、零第三方依赖，React 只从 require('react') 取；
//   - 面板数据只走 /dsh-collect/api/*，POST 必须带 x-collect-client: 1；
//   - 颜色只用 --dsw-alias-* 主题变量（第二参数 fallback），不写死颜色；
//   - 开关是 role="switch" + aria-checked 的 button；中英双语文案集中在 T 对象。
//
// 面板为单页滚动，5 个卡片区：顶栏 → 信息获取方式 → 采集 → 生成文件 → 设置。

window.__ModuleLoader__.load({
  id: 'dsh-collect',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // -------------------------------------------------------------------
    // 常量
    // -------------------------------------------------------------------

    /** HTTP API 前缀（CONTRACT §6.2）。 */
    const API = '/dsh-collect/api';
    /** 所有请求都带的客户端标记，POST 必需。 */
    const CLIENT_HEADER = { 'x-collect-client': '1' };
    /** 普通请求超时（毫秒）。 */
    const REQUEST_TIMEOUT_MS = 15000;
    /** 采集 / 生成请求超时（毫秒），这两类请求可能很慢。 */
    const LONG_TIMEOUT_MS = 60000;
    /** 正文预览最多显示的字符数。 */
    const PREVIEW_LIMIT = 4000;
    /** 可生成的文件格式（顺序即面板按钮顺序）。 */
    const FORMATS = ['md', 'html', 'txt', 'csv', 'json', 'docx', 'xlsx', 'pptx', 'pdf'];

    /** 当前界面语言 id，apply 时从 ctx.locale 读一次。 */
    let localeId = '';

    // -------------------------------------------------------------------
    // 文案（所有界面文字集中在这里）
    // -------------------------------------------------------------------

    /** 中英双语文案表。 */
    const T = {
      zh: {
        title: '采文 · CollectKit',
        refresh: '刷新',
        retry: '重试',
        loading: '正在读取插件状态…',
        bootError: '读取插件状态失败',
        timeoutErr: '请求超时，请稍后重试',
        abortedErr: '请求已取消',
        networkErr: '网络请求失败',
        badJson: '服务返回了无法解析的数据',
        close: '关闭',
        acqTitle: '信息获取方式',
        acqNative: '原生联网',
        acqNativeHint: '使用宿主内置的网页抓取与搜索能力',
        acqDirect: '直连抓取',
        acqDirectHint: '插件自己访问网站，不依赖宿主联网服务',
        acqBrowser: '浏览器标签页',
        acqBrowserHint: '通过浏览器调试接口读取页面，不移动鼠标',
        acqComputer: '桌面操控',
        acqComputerHint: '会移动鼠标与键盘，默认关闭（会拦截 computer 操控类工具）',
        acqMcp: 'MCP 工具',
        acqMcpHint: '使用其他数据源插件提供的 MCP 工具',
        capAvailable: '可用',
        capMissing: '未安装',
        capUnknown: '未知',
        capCount: (n) => '可用 ' + n + ' 个',
        collectTitle: '采集',
        urlLabel: '网页地址',
        urlPlaceholder: '每行一个网址，例如\nhttps://example.com/article',
        collectHint: '每行一个网址，也支持逗号或空格分隔',
        startCollect: '开始采集',
        collecting: (n, m) => '正在采集第 ' + n + '/' + m + ' 个…',
        collectingHint: '采集期间请勿重复点击，单个网址最长等待 60 秒',
        noUrls: '请先输入至少一个网址',
        collectEmpty: '还没有采集结果',
        collectSucceeded: (ok, total) => '采集完成：成功 ' + ok + ' / 共 ' + total + ' 个',
        failed: '失败',
        failedUnknown: '没有拿到失败原因：可能是面板接口暂时不可用，请点右上角「刷新」后重试',
        chars: (n) => n + ' 字',
        images: (n) => n + ' 张图',
        selected: '已选',
        selectHint: '点击标题可切换导出对象',
        methodNative: '原生联网',
        methodDirect: '直连抓取',
        methodOther: '采集',
        viewBody: '查看正文',
        hideBody: '收起正文',
        previewLoading: '正在读取正文…',
        previewEmpty: '（正文为空）',
        previewTruncated: '（正文较长，仅显示前 4000 字符）',
        exportTitle: '生成文件',
        exportTarget: '导出对象',
        noExportTarget: '请先采集一篇成功的网页，再生成文件',
        generate: '生成',
        generating: '正在生成…',
        exportDone: '文件已生成',
        exportFail: '生成失败',
        pdfHint: 'PDF 需要本机安装 LibreOffice；未检测到时服务端会降级并给出提示',
        download: '下载',
        settingsTitle: '设置',
        settingDir: '输出目录',
        settingDirHint: '相对工作目录的输出文件夹',
        settingMaxBytes: '单页最大字节',
        settingTimeout: '超时毫秒',
        settingImageLimit: '图片上限',
        settingSaveImages: '下载图片',
        settingSaveImagesHint: '采集时把正文图片一起存到工作目录',
        saveSettings: '保存设置',
        saving: '正在保存…',
        saved: '设置已保存',
        saveFail: '设置保存失败',
        invalidNumber: '设置里的数字不合法：单页最大字节 65536~67108864，超时 1000~120000 毫秒，图片上限 0~100',
        workspaceLabel: '工作目录',
        workspaceMissing: '（目录尚未创建）',
      },
      en: {
        title: 'CollectKit',
        refresh: 'Refresh',
        retry: 'Retry',
        loading: 'Loading plugin state…',
        bootError: 'Failed to load plugin state',
        timeoutErr: 'Request timed out, please retry',
        abortedErr: 'Request cancelled',
        networkErr: 'Network request failed',
        badJson: 'The server returned unparseable data',
        close: 'Close',
        acqTitle: 'Acquisition methods',
        acqNative: 'Native web',
        acqNativeHint: 'Use the host built-in web fetching and search',
        acqDirect: 'Direct HTTP',
        acqDirectHint: 'The plugin fetches sites itself, no host service needed',
        acqBrowser: 'Browser tabs',
        acqBrowserHint: 'Read pages through the browser debug interface, without moving the mouse',
        acqComputer: 'Desktop control',
        acqComputerHint: 'Moves the mouse and keyboard; off by default (blocks computer-control tools)',
        acqMcp: 'MCP tools',
        acqMcpHint: 'Use MCP tools exposed by other data-source plugins',
        capAvailable: 'Available',
        capMissing: 'Not installed',
        capUnknown: 'Unknown',
        capCount: (n) => n + ' available',
        collectTitle: 'Collect',
        urlLabel: 'Page URLs',
        urlPlaceholder: 'One URL per line, e.g.\nhttps://example.com/article',
        collectHint: 'One URL per line; commas or spaces also work',
        startCollect: 'Start collecting',
        collecting: (n, m) => 'Collecting ' + n + '/' + m + '…',
        collectingHint: 'Do not click again while running; each URL may take up to 60 seconds',
        noUrls: 'Enter at least one URL first',
        collectEmpty: 'No collected results yet',
        collectSucceeded: (ok, total) => 'Finished: ' + ok + ' of ' + total + ' succeeded',
        failed: 'Failed',
        failedUnknown: 'No failure reason was returned: the panel API may be temporarily unavailable. Click Refresh and retry.',
        chars: (n) => n + ' chars',
        images: (n) => n + ' images',
        selected: 'selected',
        selectHint: 'Click a title to change the export target',
        methodNative: 'native web',
        methodDirect: 'direct HTTP',
        methodOther: 'collect',
        viewBody: 'View body',
        hideBody: 'Hide body',
        previewLoading: 'Loading body…',
        previewEmpty: '(empty body)',
        previewTruncated: '(body is long; showing the first 4000 characters)',
        exportTitle: 'Generate file',
        exportTarget: 'Export target',
        noExportTarget: 'Collect a page successfully before generating a file',
        generate: 'Generate',
        generating: 'Generating…',
        exportDone: 'File generated',
        exportFail: 'Generation failed',
        pdfHint: 'PDF needs LibreOffice on this machine; without it the server degrades and reports a note',
        download: 'Download',
        settingsTitle: 'Settings',
        settingDir: 'Output folder',
        settingDirHint: 'Output folder relative to the workspace',
        settingMaxBytes: 'Max bytes per page',
        settingTimeout: 'Timeout (ms)',
        settingImageLimit: 'Image limit',
        settingSaveImages: 'Download images',
        settingSaveImagesHint: 'Save body images into the workspace while collecting',
        saveSettings: 'Save settings',
        saving: 'Saving…',
        saved: 'Settings saved',
        saveFail: 'Failed to save settings',
        invalidNumber: 'Invalid number in settings: max bytes 65536-67108864, timeout 1000-120000 ms, image limit 0-100',
        workspaceLabel: 'Workspace',
        workspaceMissing: '(folder not created yet)',
      },
    };

    /**
     * 根据语言 id 选文案，取不到时用中文。
     * @param {string} id 语言 id，如 'zh-CN' / 'en-US'
     * @returns {{[key: string]: any}} 文案表
     */
    function pickT(id) {
      const value = typeof id === 'string' ? id.toLowerCase() : '';
      if (value.indexOf('en') === 0) return T.en;
      return T.zh;
    }

    // -------------------------------------------------------------------
    // 纯函数工具
    // -------------------------------------------------------------------

    /**
     * 把错误转成给用户看的一句话。
     * @param {any} error 错误对象
     * @param {{[key: string]: any}} t 文案表
     * @returns {string} 可读文本
     */
    function errText(error, t) {
      if (!error) return '';
      if (error.code === 'timeout') return t.timeoutErr;
      if (error.code === 'aborted') return t.abortedErr;
      if (error.code === 'badjson') return t.badJson;
      const message = error.message ? String(error.message) : '';
      if (error.code === 'network') return t.networkErr + (message ? '：' + message : '');
      return message || t.networkErr;
    }

    /**
     * 字节数格式化成可读字符串。
     * @param {number} value 字节数
     * @returns {string} 形如 '12.3 KB'
     */
    function formatBytes(value) {
      const n = Number(value);
      if (!isFinite(n) || n < 0) return '';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    /**
     * 取相对路径的文件名部分。
     * @param {string} rel 相对路径
     * @returns {string} 文件名
     */
    function baseName(rel) {
      const text = String(rel || '');
      const parts = text.split(/[\\/]/);
      return parts[parts.length - 1] || text;
    }

    /**
     * 取网址的域名，解析失败时原样返回。
     * @param {string} url 网址
     * @returns {string} 域名
     */
    function domainOf(url) {
      try {
        return new URL(String(url || '')).hostname || String(url || '');
      } catch (error) {
        return String(url || '');
      }
    }

    /**
     * 解析网址输入框：支持换行 / 逗号 / 空格分隔，去重并补全协议。
     * @param {string} text 用户输入
     * @returns {string[]} 网址数组
     */
    function normalizeUrls(text) {
      const parts = String(text || '').split(/[\s,，;；]+/);
      const seen = {};
      const list = [];
      for (let i = 0; i < parts.length; i += 1) {
        let url = parts[i].trim();
        if (!url) continue;
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
        if (!/^https?:\/\//i.test(url)) continue;
        if (seen[url]) continue;
        seen[url] = true;
        list.push(url);
      }
      return list;
    }

    /**
     * 从 config 生成设置区的可编辑草稿。
     * @param {{output?: any}} [config] 服务端 config
     * @returns {{dir: string, saveImages: boolean, imageLimit: number, maxBytes: number, timeoutMs: number}}
     */
    function outputToDraft(config) {
      const output = (config && config.output) || {};
      return {
        dir: typeof output.dir === 'string' ? output.dir : '',
        saveImages: output.saveImages !== false,
        imageLimit: typeof output.imageLimit === 'number' ? output.imageLimit : 20,
        maxBytes: typeof output.maxBytes === 'number' ? output.maxBytes : 8388608,
        timeoutMs: typeof output.timeoutMs === 'number' ? output.timeoutMs : 20000,
      };
    }

    /**
     * 把输入转成区间内的整数，非法返回 null。
     * @param {any} value 输入值
     * @param {number} min 允许的最小值（含）
     * @param {number} max 允许的最大值（含）
     * @returns {number|null} 整数或 null
     */
    function toIntIn(value, min, max) {
      const n = Math.floor(Number(value));
      if (!isFinite(n) || n < min || n > max) return null;
      return n;
    }

    /**
     * 从服务端错误响应里拼出给用户看的文案：优先 error，其次 issues[].message。
     * @param {any} data 已解析的响应体
     * @param {number} status HTTP 状态码
     * @returns {string} 错误文案
     */
    function serverErrorMessage(data, status) {
      if (data && typeof data.error === 'string' && data.error) return data.error;
      if (data && Array.isArray(data.issues)) {
        const messages = data.issues
          .map((item) => (item && typeof item.message === 'string' ? item.message : ''))
          .filter((message) => message);
        if (messages.length) return messages.join('；');
      }
      return 'HTTP ' + status;
    }

    /**
     * 能力字段转成徽章文案。
     * @param {any} cap capabilities 里的一个字段
     * @param {{[key: string]: any}} t 文案表
     * @returns {{available: boolean, text: string, hint: string}} 展示信息
     */
    function describeCapability(cap, t) {
      if (cap === true) return { available: true, text: t.capAvailable, hint: '' };
      if (cap === false) return { available: false, text: t.capMissing, hint: '' };
      if (cap && typeof cap === 'object') {
        const available = !!cap.available;
        let text = available ? t.capAvailable : t.capMissing;
        if (available && typeof cap.count === 'number' && cap.count > 0) text = t.capCount(cap.count);
        return { available: available, text: text, hint: typeof cap.hint === 'string' ? cap.hint : '' };
      }
      return { available: false, text: t.capUnknown, hint: '' };
    }

    /**
     * 采集方式转展示文案。
     * @param {string} method ItemResult.method
     * @param {{[key: string]: any}} t 文案表
     * @returns {string} 展示文本
     */
    function methodLabel(method, t) {
      if (method === 'native-web') return t.methodNative;
      if (method === 'direct-http') return t.methodDirect;
      return method ? String(method) : t.methodOther;
    }

    // -------------------------------------------------------------------
    // HTTP 访问
    // -------------------------------------------------------------------

    /**
     * 构造可读错误。
     * @param {string} message 错误信息
     * @param {string} code 机器可读错误码
     * @param {number} [status] HTTP 状态码
     * @returns {Error} 错误对象
     */
    function makeError(message, code, status) {
      const error = new Error(message || 'request failed');
      error.code = code;
      if (typeof status === 'number') error.status = status;
      return error;
    }

    /**
     * 调插件 HTTP API：带超时、可被外部 signal 中止、统一解析 JSON。
     * @param {string} path API 后缀，如 '/state'
     * @param {{method?: string, body?: any, timeoutMs?: number, signal?: any}} [options] 请求选项
     * @returns {Promise<any>} 已解析且 ok !== false 的响应
     */
    async function request(path, options) {
      const opts = options || {};
      const controller = new AbortController();
      let timedOut = false;
      const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const external = opts.signal;
      const forwardAbort = () => controller.abort();
      if (external) {
        if (external.aborted) controller.abort();
        else if (typeof external.addEventListener === 'function') external.addEventListener('abort', forwardAbort);
      }
      const headers = Object.assign({}, CLIENT_HEADER);
      const init = { method: opts.method || 'GET', headers: headers, cache: 'no-store', signal: controller.signal };
      if (opts.body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
      }
      try {
        const response = await fetch(API + path, init);
        const text = await response.text();
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (error) {
            data = null;
          }
        }
        if (!response.ok) {
          const failure = makeError(serverErrorMessage(data, response.status), 'server', response.status);
          if (data && Array.isArray(data.issues)) failure.issues = data.issues;
          throw failure;
        }
        if (data === null) throw makeError('unparseable response', 'badjson');
        if (data && data.ok === false) {
          throw makeError(serverErrorMessage(data, response.status), 'server', response.status);
        }
        return data;
      } catch (error) {
        if (timedOut) throw makeError('timeout', 'timeout');
        if (external && external.aborted) throw makeError('aborted', 'aborted');
        if (error && error.code) throw error;
        const message = error && error.message ? String(error.message) : 'network error';
        throw makeError(message, 'network');
      } finally {
        clearTimeout(timer);
        if (external && typeof external.removeEventListener === 'function') {
          external.removeEventListener('abort', forwardAbort);
        }
      }
    }

    // -------------------------------------------------------------------
    // 基础组件
    // -------------------------------------------------------------------

    /**
     * 侧边栏图标（采文）：文档 + 向下箭头，跟随 currentColor。
     * @param {{size?: number, active?: boolean}} props 宿主传入的尺寸与选中态
     * @returns {any} SVG 元素
     */
    function PanelIcon(props) {
      const size = (props && props.size) || 18;
      const active = !!(props && props.active);
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          style: { opacity: active ? 1 : 0.72 },
        },
        h('rect', { x: 3, y: 2.5, width: 18, height: 19, rx: 4, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M7 8.5h10M7 12h7', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('path', {
          d: 'M12 14.5v5m0 0-2.2-2.2M12 19.5l2.2-2.2',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /**
     * 卡片分组。
     * @param {{title?: string, extra?: any, children?: any}} props 属性
     * @returns {any} section 元素
     */
    function Card(props) {
      return h(
        'section',
        { className: 'dshc-card' },
        props.title
          ? h('div', { className: 'dshc-card-head' },
              h('h2', { className: 'dshc-card-title' }, props.title),
              props.extra || null)
          : null,
        props.children,
      );
    }

    /**
     * 通用按钮（primary / secondary 两种视觉）。
     * @param {{variant?: string, disabled?: boolean, title?: string, ariaLabel?: string, onClick?: Function, children?: any}} props 属性
     * @returns {any} button 元素
     */
    function Btn(props) {
      const variant = props.variant === 'primary' ? 'primary' : 'secondary';
      return h(
        'button',
        {
          type: 'button',
          className: 'dshc-btn dshc-btn-' + variant,
          disabled: !!props.disabled,
          title: props.title,
          'aria-label': props.ariaLabel,
          onClick: props.onClick,
        },
        props.children,
      );
    }

    /**
     * 开关：button + role="switch" + aria-checked，键盘可操作。
     * @param {{checked?: boolean, disabled?: boolean, label?: string, onChange?: Function}} props 属性
     * @returns {any} button 元素
     */
    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': props.checked ? 'true' : 'false',
          'aria-label': props.label,
          className: 'dshc-switch',
          disabled: !!props.disabled,
          onClick: props.onChange ? () => props.onChange(!props.checked) : undefined,
        },
        h('span', { className: 'dshc-switch-knob', 'aria-hidden': 'true' }),
      );
    }

    /**
     * 能力徽章（可用 / 未安装）。
     * @param {{cap: any, t: any}} props 属性
     * @returns {any} span 元素
     */
    function CapBadge(props) {
      const info = describeCapability(props.cap, props.t);
      return h(
        'span',
        { className: 'dshc-badge ' + (info.available ? 'is-ok' : 'is-missing'), title: info.hint || '' },
        info.text,
      );
    }

    /**
     * 顶部提示条（错误 / 成功）。
     * @param {{banner: {kind: string, text: string}|null, t: any, onClose: Function}} props 属性
     * @returns {any} 提示条或 null
     */
    function Banner(props) {
      if (!props.banner) return null;
      const kind = props.banner.kind === 'success' ? 'is-success' : 'is-error';
      return h(
        'div',
        { className: 'dshc-banner ' + kind, role: 'status' },
        h('div', { className: 'dshc-banner-text' }, props.banner.text),
        h(
          'button',
          {
            type: 'button',
            className: 'dshc-linkbtn',
            'aria-label': props.t.close,
            onClick: props.onClose,
          },
          '×',
        ),
      );
    }

    /**
     * 采集结果行：标题、域名、字数、图片数、方式、相对路径、正文预览。
     * @param {{item: any, t: any, selected: boolean, expanded: boolean, previewNode: any, onSelect: Function, onPreview: Function}} props 属性
     * @returns {any} 结果行元素
     */
    function ItemRow(props) {
      const item = props.item || {};
      const t = props.t;
      const ok = !!item.ok;
      return h(
        'div',
        { className: 'dshc-item' + (props.selected ? ' is-selected' : '') },
        h(
          'div',
          { className: 'dshc-item-head' },
          ok
            ? h(
                'button',
                { type: 'button', className: 'dshc-item-title', title: t.selectHint, onClick: props.onSelect },
                item.title || item.url || '',
              )
            : h('div', { className: 'dshc-item-title' }, t.failed),
          h('div', { className: 'dshc-item-url' }, domainOf(item.url)),
        ),
        ok
          ? h(
              'div',
              { className: 'dshc-item-meta' },
              h('span', { className: 'dshc-badge' }, methodLabel(item.method, t)),
              h('span', null, t.chars(item.chars || 0)),
              h('span', null, t.images(item.images || 0)),
              item.rel ? h('span', { className: 'dshc-item-rel' }, item.rel) : null,
              props.selected ? h('span', { className: 'dshc-badge is-ok' }, t.selected) : null,
            )
          : null,
        ok && item.rel
          ? h(
              'button',
              { type: 'button', className: 'dshc-linkbtn', onClick: props.onPreview },
              props.expanded ? t.hideBody : t.viewBody,
            )
          : null,
        !ok ? h('div', { className: 'dshc-item-error' }, t.failed + '：' + (item.error || t.failedUnknown)) : null,
        props.previewNode || null,
      );
    }

    // -------------------------------------------------------------------
    // 面板
    // -------------------------------------------------------------------

    /** 面板样式（class 全部 dshc- 前缀，颜色只用主题变量）。 */
    const CSS = `
.dshc-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  padding: 16px;
  overflow: auto;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary, #1f2329);
  background: var(--dsw-alias-bg-base, #ffffff);
}
.dshc-header {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 12px;
  background: var(--dsw-alias-bg-base, #ffffff);
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
}
.dshc-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
.dshc-version { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dshc-spacer { flex: 1 1 auto; }
.dshc-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
}
.dshc-card-head { display: flex; align-items: center; gap: 8px; }
.dshc-card-title { margin: 0; font-size: 14px; font-weight: 600; }
.dshc-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
}
.dshc-row:first-child { padding-top: 0; border-top: none; }
.dshc-row-main { flex: 1 1 auto; min-width: 0; }
.dshc-row-label { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; }
.dshc-row-hint { margin-top: 2px; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); word-break: break-word; }
.dshc-badge {
  display: inline-block;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  font-size: 11px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #6b7280);
  white-space: nowrap;
}
.dshc-badge.is-ok { color: var(--dsw-alias-state-success-primary, #1a7f37); border-color: var(--dsw-alias-state-success-primary, #1a7f37); }
.dshc-badge.is-missing { color: var(--dsw-alias-state-idle-primary, #9ca3af); }
.dshc-switch {
  position: relative;
  flex: 0 0 auto;
  width: 38px;
  height: 22px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, #d0d5dd);
  background: var(--dsw-alias-bg-layer-2, #f2f4f7);
  cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease;
}
.dshc-switch:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #2b6ef6); }
.dshc-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2b6ef6); outline-offset: 2px; }
.dshc-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary, #2b6ef6); border-color: var(--dsw-alias-brand-primary, #2b6ef6); }
.dshc-switch:disabled { opacity: .5; cursor: not-allowed; }
.dshc-switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-bg-base, #ffffff);
  transition: transform .15s ease;
}
.dshc-switch[aria-checked='true'] .dshc-switch-knob { transform: translateX(16px); }
.dshc-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dshc-field-label { display: block; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dshc-input, .dshc-textarea, .dshc-select {
  box-sizing: border-box;
  width: 100%;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  background: var(--dsw-alias-bg-layer-2, #f7f8fa);
  color: var(--dsw-alias-label-primary, #1f2329);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  outline: none;
}
.dshc-textarea { resize: vertical; min-height: 76px; }
.dshc-input:focus, .dshc-textarea:focus, .dshc-select:focus { border-color: var(--dsw-alias-brand-primary, #2b6ef6); }
.dshc-input:disabled, .dshc-textarea:disabled, .dshc-select:disabled { color: var(--dsw-alias-state-idle-primary, #9ca3af); cursor: not-allowed; }
.dshc-btn {
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  padding: 5px 12px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-primary, #1f2329);
  cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.dshc-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2, #d0d5dd); }
.dshc-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2b6ef6); outline-offset: 2px; }
.dshc-btn:disabled { color: var(--dsw-alias-state-idle-primary, #9ca3af); border-color: transparent; cursor: not-allowed; }
.dshc-btn-secondary { border-color: var(--dsw-alias-border-l1, #e5e7eb); background: var(--dsw-alias-bg-layer-2, #f7f8fa); }
.dshc-btn-secondary:hover:not(:disabled) { background: var(--dsw-alias-bg-overlay, #ffffff); }
.dshc-btn-primary {
  color: var(--dsw-alias-brand-primary, #2b6ef6);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #2b6ef6) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #2b6ef6) 12%, transparent);
}
.dshc-btn-primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #2b6ef6) 20%, transparent);
  border-color: var(--dsw-alias-brand-primary, #2b6ef6);
}
.dshc-btn-primary:disabled {
  color: var(--dsw-alias-state-idle-primary, #9ca3af);
  border-color: var(--dsw-alias-border-l1, #e5e7eb);
  background: var(--dsw-alias-bg-layer-2, #f7f8fa);
}
.dshc-inline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dshc-hint { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); word-break: break-word; }
.dshc-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  background: var(--dsw-alias-bg-layer-2, #f7f8fa);
  font-size: 12px;
}
.dshc-banner.is-error { color: var(--dsw-alias-state-error-primary, #d93025); border-color: var(--dsw-alias-state-error-primary, #d93025); }
.dshc-banner.is-success { color: var(--dsw-alias-state-success-primary, #1a7f37); border-color: var(--dsw-alias-state-success-primary, #1a7f37); }
.dshc-banner-text { flex: 1 1 auto; min-width: 0; word-break: break-word; }
.dshc-linkbtn {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--dsw-alias-brand-primary, #2b6ef6);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dshc-linkbtn:hover { text-decoration: underline; }
.dshc-linkbtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2b6ef6); outline-offset: 2px; border-radius: 4px; }
.dshc-progress { height: 4px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, #f2f4f7); overflow: hidden; }
.dshc-progress-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary, #2b6ef6); transition: width .2s ease; }
.dshc-list { display: flex; flex-direction: column; gap: 8px; }
.dshc-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #f7f8fa);
}
.dshc-item.is-selected { border-color: var(--dsw-alias-brand-primary, #2b6ef6); }
.dshc-item-head { display: flex; flex-direction: column; gap: 2px; }
.dshc-item-title {
  padding: 0;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  color: var(--dsw-alias-label-primary, #1f2329);
  cursor: pointer;
  word-break: break-word;
}
.dshc-item-title:hover { color: var(--dsw-alias-brand-primary, #2b6ef6); }
.dshc-item-url { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); word-break: break-all; }
.dshc-item-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dshc-item-error { font-size: 12px; color: var(--dsw-alias-state-error-primary, #d93025); word-break: break-word; }
.dshc-item-rel { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); word-break: break-all; }
.dshc-pre {
  box-sizing: border-box;
  max-height: 260px;
  margin: 0;
  padding: 10px;
  overflow: auto;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2329);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.dshc-formats { display: flex; flex-wrap: wrap; gap: 8px; }
.dshc-format {
  font: inherit;
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  background: var(--dsw-alias-bg-layer-2, #f7f8fa);
  color: var(--dsw-alias-label-primary, #1f2329);
  cursor: pointer;
}
.dshc-format:hover { border-color: var(--dsw-alias-border-l2, #d0d5dd); }
.dshc-format:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2b6ef6); outline-offset: 2px; }
.dshc-format.is-active {
  color: var(--dsw-alias-brand-primary, #2b6ef6);
  border-color: var(--dsw-alias-brand-primary, #2b6ef6);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #2b6ef6) 14%, transparent);
}
.dshc-result {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  background: var(--dsw-alias-bg-layer-2, #f7f8fa);
  font-size: 12px;
}
.dshc-download { color: var(--dsw-alias-brand-primary, #2b6ef6); font-size: 12px; text-decoration: none; }
.dshc-download:hover { text-decoration: underline; }
.dshc-download:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2b6ef6); outline-offset: 2px; border-radius: 4px; }
.dshc-note { font-size: 12px; color: var(--dsw-alias-state-warn-primary, #b45309); word-break: break-word; }
.dshc-settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.dshc-empty { padding: 8px 0; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dshc-loading { padding: 24px; font-size: 13px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dshc-error-text { font-size: 13px; color: var(--dsw-alias-state-error-primary, #d93025); word-break: break-word; }
.dshc-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; word-break: break-all; }
`;

    /**
     * 主面板：单页滚动，5 个卡片区。
     * @returns {any} 面板根元素
     */
    function Panel() {
      const t = pickT(localeId);

      const [boot, setBoot] = React.useState({ status: 'loading', error: null });
      const [meta, setMeta] = React.useState({ version: '', config: null, capabilities: null, workspace: null });
      const [items, setItems] = React.useState([]);
      const [banner, setBanner] = React.useState(null);
      const [format, setFormat] = React.useState('docx');
      const [targetSlug, setTargetSlug] = React.useState('');
      const [urlText, setUrlText] = React.useState('');
      const [collecting, setCollecting] = React.useState({ active: false, done: 0, total: 0 });
      const [exporting, setExporting] = React.useState(false);
      const [exportResult, setExportResult] = React.useState(null);
      const [preview, setPreview] = React.useState({ rel: '', status: 'idle', markdown: '', error: null });
      const [settingsDraft, setSettingsDraft] = React.useState(null);
      const [saving, setSaving] = React.useState(false);

      // 卸载时中止所有未完成的请求。
      const abortRef = React.useRef(null);
      // 同步锁：同一 tick 内连点「开始采集」也只跑一轮。
      const busyRef = React.useRef(false);
      React.useEffect(() => {
        const controller = new AbortController();
        abortRef.current = controller;
        return () => {
          abortRef.current = null;
          controller.abort();
        };
      }, []);

      /** 取当前请求应绑定的 abort signal；未挂载时返回 undefined。 */
      const signal = () => (abortRef.current ? abortRef.current.signal : undefined);

      /** 读取 /state 并填充面板；失败进入错误态，可点「重试」。 */
      const loadState = React.useCallback(async () => {
        setBoot({ status: 'loading', error: null });
        setBanner(null);
        try {
          const data = await request('/state', { signal: signal() });
          if (!abortRef.current) return;
          const cfg = (data && data.config) || {};
          const list = data && Array.isArray(data.items) ? data.items : [];
          setMeta({
            version: data && data.version ? String(data.version) : '',
            config: cfg,
            capabilities: (data && data.capabilities) || {},
            workspace: (data && data.workspace) || null,
          });
          setItems(list);
          setFormat(cfg.defaultFormat || 'docx');
          setTargetSlug((prev) => {
            const stillThere = list.filter((it) => it && it.ok && it.slug && it.slug === prev)[0];
            if (stillThere) return prev;
            const first = list.filter((it) => it && it.ok && it.slug)[0];
            return first ? first.slug : '';
          });
          setSettingsDraft(outputToDraft(cfg));
          setBoot({ status: 'ready', error: null });
        } catch (error) {
          if (error.code === 'aborted' || !abortRef.current) return;
          setBoot({ status: 'error', error: errText(error, t) });
        }
      }, [t]);

      React.useEffect(() => {
        loadState();
      }, [loadState]);

      const successful = React.useMemo(
        () => items.filter((it) => it && it.ok && typeof it.slug === 'string' && it.slug),
        [items],
      );
      const draft = settingsDraft || outputToDraft(meta.config || {});
      const config = meta.config || {};
      const acquisition = config.acquisition || {};
      const capabilities = meta.capabilities || {};
      const workspace = meta.workspace || null;
      let effectiveTarget = '';
      if (successful.length) {
        const found = successful.filter((it) => it.slug === targetSlug)[0];
        effectiveTarget = found ? found.slug : successful[0].slug;
      }

      /** 切换信息获取方式：乐观更新，失败回滚并提示。 */
      const toggleAcquisition = async (key, next) => {
        const before = meta.config || {};
        setMeta((prev) => ({
          ...prev,
          config: {
            ...(prev.config || {}),
            acquisition: { ...((prev.config || {}).acquisition || {}), [key]: next },
          },
        }));
        try {
          const res = await request('/settings', {
            method: 'POST',
            body: { patch: { acquisition: { [key]: next } } },
            signal: signal(),
          });
          if (!abortRef.current) return;
          if (res && res.config) setMeta((prev) => ({ ...prev, config: res.config }));
        } catch (error) {
          if (error.code === 'aborted' || !abortRef.current) return;
          setMeta((prev) => ({ ...prev, config: before }));
          setBanner({ kind: 'error', text: t.saveFail + '：' + errText(error, t) });
        }
      };

      /** 依次采集每个网址，逐条追加结果并显示进度。 */
      const collect = async () => {
        if (collecting.active || busyRef.current) return;
        const urls = normalizeUrls(urlText);
        if (!urls.length) {
          setBanner({ kind: 'error', text: t.noUrls });
          return;
        }
        busyRef.current = true;
        try {
          setBanner(null);
          setExportResult(null);
          setItems([]);
          setTargetSlug('');
          setPreview({ rel: '', status: 'idle', markdown: '', error: null });
          setCollecting({ active: true, done: 0, total: urls.length });
          const collected = [];
          for (let i = 0; i < urls.length; i += 1) {
            if (!abortRef.current) break;
            setCollecting({ active: true, done: i, total: urls.length });
            let batch = [];
            try {
              const res = await request('/collect', {
                method: 'POST',
                body: { urls: [urls[i]] },
                timeoutMs: LONG_TIMEOUT_MS,
                signal: signal(),
              });
              batch = res && Array.isArray(res.items) ? res.items : [];
            } catch (error) {
              if (error.code === 'aborted') {
                setCollecting({ active: false, done: i, total: urls.length });
                return;
              }
              batch = [{ ok: false, url: urls[i], error: errText(error, t) }];
            }
            for (let k = 0; k < batch.length; k += 1) collected.push(batch[k]);
            setItems(collected.slice());
          }
          setCollecting({ active: false, done: urls.length, total: urls.length });
          const okCount = collected.filter((it) => it && it.ok).length;
          const firstOk = collected.filter((it) => it && it.ok && it.slug)[0];
          if (firstOk) setTargetSlug(firstOk.slug);
          setBanner({
            kind: okCount > 0 ? 'success' : 'error',
            text: t.collectSucceeded(okCount, urls.length),
          });
        } finally {
          busyRef.current = false;
        }
      };

      /** 展开 / 收起某条结果的正文预览。 */
      const togglePreview = async (item) => {
        if (!item || !item.rel) return;
        if (preview.rel === item.rel) {
          setPreview({ rel: '', status: 'idle', markdown: '', error: null });
          return;
        }
        setPreview({ rel: item.rel, status: 'loading', markdown: '', error: null });
        try {
          const res = await request('/item?rel=' + encodeURIComponent(item.rel), { signal: signal() });
          if (!abortRef.current) return;
          setPreview({
            rel: item.rel,
            status: 'ready',
            markdown: typeof res.markdown === 'string' ? res.markdown : '',
            error: null,
          });
        } catch (error) {
          if (error.code === 'aborted' || !abortRef.current) return;
          setPreview({ rel: item.rel, status: 'error', markdown: '', error: errText(error, t) });
        }
      };

      /** 按当前选中的格式生成文件。 */
      const generate = async () => {
        if (!effectiveTarget || exporting) return;
        const targetItem = successful.filter((it) => it.slug === effectiveTarget)[0];
        const body = { slug: effectiveTarget, format: format || 'docx' };
        // 契约字段是 slug；同时带上 rel（相对路径）与 title：
        // 实现方按 rel 读目录、按 title 命名文件时更稳，不会把 basename 当成相对路径。
        if (targetItem) {
          if (targetItem.rel) body.rel = targetItem.rel;
          if (targetItem.title) body.title = targetItem.title;
        }
        setExporting(true);
        setExportResult(null);
        setBanner(null);
        try {
          const res = await request('/export', {
            method: 'POST',
            body: body,
            timeoutMs: LONG_TIMEOUT_MS,
            signal: signal(),
          });
          if (!abortRef.current) return;
          setExportResult({ file: (res && res.file) || null, note: (res && res.note) || '' });
          setBanner({ kind: 'success', text: t.exportDone });
        } catch (error) {
          if (error.code === 'aborted' || !abortRef.current) return;
          setBanner({ kind: 'error', text: t.exportFail + '：' + errText(error, t) });
        } finally {
          if (abortRef.current) setExporting(false);
        }
      };

      /** 更新设置草稿里的一个字段。 */
      const updateDraft = (key, value) => {
        setSettingsDraft((prev) => {
          const base = prev || outputToDraft(meta.config || {});
          return { ...base, [key]: value };
        });
      };

      /** 保存设置（POST /settings，深合并 output）。 */
      const saveSettings = async () => {
        if (saving) return;
        const dir = String(draft.dir || '').trim();
        const maxBytes = toIntIn(draft.maxBytes, 64 * 1024, 64 * 1024 * 1024);
        const timeoutMs = toIntIn(draft.timeoutMs, 1000, 120000);
        const imageLimit = toIntIn(draft.imageLimit, 0, 100);
        if (!dir || maxBytes === null || timeoutMs === null || imageLimit === null) {
          setBanner({ kind: 'error', text: t.invalidNumber });
          return;
        }
        setSaving(true);
        setBanner(null);
        try {
          const res = await request('/settings', {
            method: 'POST',
            body: {
              patch: {
                output: {
                  dir: dir,
                  saveImages: !!draft.saveImages,
                  imageLimit: imageLimit,
                  maxBytes: maxBytes,
                  timeoutMs: timeoutMs,
                },
              },
            },
            signal: signal(),
          });
          if (!abortRef.current) return;
          if (res && res.config) {
            setMeta((prev) => ({ ...prev, config: res.config }));
            setSettingsDraft(outputToDraft(res.config));
          }
          setBanner({ kind: 'success', text: t.saved });
        } catch (error) {
          if (error.code === 'aborted' || !abortRef.current) return;
          setBanner({ kind: 'error', text: t.saveFail + '：' + errText(error, t) });
        } finally {
          if (abortRef.current) setSaving(false);
        }
      };

      /** 用当前预览状态拼出结果行里的正文预览节点。 */
      const previewNodeFor = (item) => {
        if (!preview.rel || preview.rel !== item.rel) return null;
        if (preview.status === 'loading') return h('div', { className: 'dshc-hint' }, t.previewLoading);
        if (preview.status === 'error') return h('div', { className: 'dshc-item-error' }, preview.error);
        const text = preview.markdown || '';
        return h(
          'div',
          null,
          h('pre', { className: 'dshc-pre' }, text ? text.slice(0, PREVIEW_LIMIT) : t.previewEmpty),
          text.length > PREVIEW_LIMIT ? h('div', { className: 'dshc-hint' }, t.previewTruncated) : null,
        );
      };

      // ---- 顶栏 ----
      const header = h(
        'header',
        { className: 'dshc-header' },
        h('h1', { className: 'dshc-title' }, t.title),
        meta.version ? h('span', { className: 'dshc-version' }, 'v' + meta.version) : null,
        h('span', { className: 'dshc-spacer' }),
        h(
          Btn,
          {
            variant: 'secondary',
            disabled: boot.status === 'loading' || collecting.active,
            onClick: () => {
              if (collecting.active) return;
              loadState();
            },
          },
          t.refresh,
        ),
      );

      // ---- 信息获取方式 ----
      const acquisitionRows = [
        { key: 'nativeWeb', name: t.acqNative, hint: t.acqNativeHint, cap: capabilities.nativeWeb },
        { key: 'directHttp', name: t.acqDirect, hint: t.acqDirectHint, cap: true },
        { key: 'browserTabs', name: t.acqBrowser, hint: t.acqBrowserHint, cap: capabilities.browserTabs },
        { key: 'computerUse', name: t.acqComputer, hint: t.acqComputerHint, cap: capabilities.computerUse },
        { key: 'mcpTools', name: t.acqMcp, hint: t.acqMcpHint, cap: capabilities.mcpTools },
      ];

      const acquisitionCard = h(
        Card,
        { title: t.acqTitle },
        acquisitionRows.map((row) => {
          const capInfo = describeCapability(row.cap, t);
          const hint = capInfo.hint ? row.hint + ' · ' + capInfo.hint : row.hint;
          return h(
            'div',
            { className: 'dshc-row', key: row.key },
            h(
              'div',
              { className: 'dshc-row-main' },
              h(
                'div',
                { className: 'dshc-row-label' },
                row.name,
                h(CapBadge, { cap: row.cap, t: t }),
              ),
              h('div', { className: 'dshc-row-hint' }, hint),
            ),
            h(Switch, {
              checked: !!acquisition[row.key],
              label: row.name,
              onChange: (next) => toggleAcquisition(row.key, next),
            }),
          );
        }),
      );

      // ---- 采集 ----
      const progressPercent = collecting.total
        ? Math.max(0, Math.min(100, Math.round((collecting.done / collecting.total) * 100)))
        : 0;

      const collectCard = h(
        Card,
        { title: t.collectTitle },
        h(
          'label',
          { className: 'dshc-field', htmlFor: 'dshc-collect-urls' },
          h('span', { className: 'dshc-field-label' }, t.urlLabel),
          h('textarea', {
            id: 'dshc-collect-urls',
            className: 'dshc-textarea',
            rows: 4,
            spellCheck: false,
            value: urlText,
            placeholder: t.urlPlaceholder,
            disabled: collecting.active,
            onChange: (event) => setUrlText(event.target.value),
          }),
        ),
        h(
          'div',
          { className: 'dshc-inline' },
          h(
            Btn,
            {
              variant: 'primary',
              disabled: collecting.active || !String(urlText || '').trim(),
              onClick: collect,
            },
            collecting.active ? t.collecting(collecting.done + 1, collecting.total) : t.startCollect,
          ),
          h('span', { className: 'dshc-hint' }, collecting.active ? t.collectingHint : t.collectHint),
        ),
        collecting.active
          ? h(
              'div',
              { className: 'dshc-progress', role: 'progressbar', 'aria-valuenow': progressPercent, 'aria-valuemin': 0, 'aria-valuemax': 100 },
              h('div', { className: 'dshc-progress-fill', style: { width: progressPercent + '%' } }),
            )
          : null,
        items.length
          ? h(
              'div',
              { className: 'dshc-list' },
              items.map((item, index) =>
                h(ItemRow, {
                  key: (item && item.rel ? item.rel : 'item') + '-' + index,
                  item: item,
                  t: t,
                  selected: !!(item && item.slug && item.slug === effectiveTarget),
                  expanded: !!(item && item.rel && preview.rel === item.rel),
                  previewNode: item && item.rel ? previewNodeFor(item) : null,
                  onSelect: () => {
                    if (item && item.slug) setTargetSlug(item.slug);
                  },
                  onPreview: () => togglePreview(item),
                }),
              ),
            )
          : h('div', { className: 'dshc-empty' }, t.collectEmpty),
      );

      // ---- 生成文件 ----
      const pdfInfo = capabilities.pdf && typeof capabilities.pdf === 'object' ? capabilities.pdf : null;
      const exportCard = h(
        Card,
        { title: t.exportTitle },
        h('div', { className: 'dshc-field-label' }, t.exportTarget),
        successful.length
          ? h(
              'select',
              {
                className: 'dshc-select',
                value: effectiveTarget,
                disabled: exporting,
                onChange: (event) => setTargetSlug(event.target.value),
              },
              successful.map((item) =>
                h('option', { key: item.slug, value: item.slug }, item.title || item.slug),
              ),
            )
          : h('div', { className: 'dshc-empty' }, t.noExportTarget),
        pdfInfo && !pdfInfo.available
          ? h('div', { className: 'dshc-note' }, t.pdfHint + (pdfInfo.reason ? '（' + pdfInfo.reason + '）' : ''))
          : null,
        h(
          'div',
          { className: 'dshc-formats' },
          FORMATS.map((name) =>
            h(
              'button',
              {
                type: 'button',
                key: name,
                className: 'dshc-format' + (format === name ? ' is-active' : ''),
                'aria-pressed': format === name,
                onClick: () => setFormat(name),
              },
              name.toUpperCase(),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dshc-inline' },
          h(
            Btn,
            { variant: 'primary', disabled: exporting || !effectiveTarget, onClick: generate },
            exporting ? t.generating : t.generate,
          ),
        ),
        exportResult && exportResult.file
          ? h(
              'div',
              { className: 'dshc-result' },
              h('span', { className: 'dshc-mono' }, baseName(exportResult.file.rel) || exportResult.file.path || ''),
              h('span', { className: 'dshc-hint' }, formatBytes(exportResult.file.bytes)),
              exportResult.file.rel
                ? h(
                    'a',
                    {
                      className: 'dshc-download',
                      href: API + '/file?rel=' + encodeURIComponent(exportResult.file.rel),
                      download: baseName(exportResult.file.rel),
                      target: '_blank',
                      rel: 'noreferrer',
                    },
                    t.download,
                  )
                : null,
            )
          : null,
        exportResult && exportResult.note ? h('div', { className: 'dshc-note' }, exportResult.note) : null,
      );

      // ---- 设置 ----
      const settingsCard = h(
        Card,
        { title: t.settingsTitle },
        workspace
          ? h(
              'div',
              { className: 'dshc-hint' },
              t.workspaceLabel +
                '：' +
                (workspace.outputRoot || workspace.root || '') +
                (workspace.exists === false ? ' ' + t.workspaceMissing : ''),
            )
          : null,
        h(
          'div',
          { className: 'dshc-settings-grid' },
          h(
            'label',
            { className: 'dshc-field', htmlFor: 'dshc-setting-dir' },
            h('span', { className: 'dshc-field-label' }, t.settingDir),
            h('input', {
              id: 'dshc-setting-dir',
              className: 'dshc-input',
              type: 'text',
              value: draft.dir,
              title: t.settingDirHint,
              onChange: (event) => updateDraft('dir', event.target.value),
            }),
          ),
          h(
            'label',
            { className: 'dshc-field', htmlFor: 'dshc-setting-max-bytes' },
            h('span', { className: 'dshc-field-label' }, t.settingMaxBytes),
            h('input', {
              id: 'dshc-setting-max-bytes',
              className: 'dshc-input',
              type: 'number',
              min: 64 * 1024,
              max: 64 * 1024 * 1024,
              step: 1024,
              value: draft.maxBytes,
              onChange: (event) => updateDraft('maxBytes', event.target.value),
            }),
          ),
          h(
            'label',
            { className: 'dshc-field', htmlFor: 'dshc-setting-timeout' },
            h('span', { className: 'dshc-field-label' }, t.settingTimeout),
            h('input', {
              id: 'dshc-setting-timeout',
              className: 'dshc-input',
              type: 'number',
              min: 1000,
              max: 120000,
              step: 1000,
              value: draft.timeoutMs,
              onChange: (event) => updateDraft('timeoutMs', event.target.value),
            }),
          ),
          h(
            'label',
            { className: 'dshc-field', htmlFor: 'dshc-setting-image-limit' },
            h('span', { className: 'dshc-field-label' }, t.settingImageLimit),
            h('input', {
              id: 'dshc-setting-image-limit',
              className: 'dshc-input',
              type: 'number',
              min: 0,
              max: 100,
              step: 1,
              value: draft.imageLimit,
              onChange: (event) => updateDraft('imageLimit', event.target.value),
            }),
          ),
        ),
        h(
          'div',
          { className: 'dshc-row' },
          h(
            'div',
            { className: 'dshc-row-main' },
            h('div', { className: 'dshc-row-label' }, t.settingSaveImages),
            h('div', { className: 'dshc-row-hint' }, t.settingSaveImagesHint),
          ),
          h(Switch, {
            checked: !!draft.saveImages,
            label: t.settingSaveImages,
            onChange: (next) => updateDraft('saveImages', next),
          }),
        ),
        h(
          'div',
          { className: 'dshc-inline' },
          h(Btn, { variant: 'primary', disabled: saving, onClick: saveSettings }, saving ? t.saving : t.saveSettings),
        ),
      );

      // ---- 首次加载 / 首次失败 ----
      let bootNode = null;
      if (boot.status === 'loading') {
        bootNode = h(Card, null, h('div', { className: 'dshc-loading' }, t.loading));
      } else if (boot.status === 'error') {
        bootNode = h(
          Card,
          null,
          h('div', { className: 'dshc-error-text' }, t.bootError + '：' + boot.error),
          h(
            'div',
            { className: 'dshc-inline' },
            h(Btn, { variant: 'primary', onClick: loadState }, t.retry),
          ),
        );
      }

      return h(
        'div',
        { className: 'dshc-root' },
        h('style', null, CSS),
        header,
        h(Banner, { banner: banner, t: t, onClose: () => setBanner(null) }),
        boot.status === 'ready' ? acquisitionCard : null,
        boot.status === 'ready' ? collectCard : null,
        boot.status === 'ready' ? exportCard : null,
        boot.status === 'ready' ? settingsCard : null,
        bootNode,
      );
    }

    // -------------------------------------------------------------------
    // 注册
    // -------------------------------------------------------------------

    /**
     * 把两个 slot 注册到宿主。
     * @param {any} slots 宿主 slots 服务
     */
    function registerInto(slots) {
      slots.inject('sidebar.panellist', () =>
        slots.register(
          { name: 'sidebar.panellist', id: 'dsh-collect', order: 12, label: () => '采文' },
          (props) => h(PanelIcon, props),
        ),
      );
      slots.inject('main', () =>
        slots.register({ name: 'main', key: 'dsh-collect' }, () => h(Panel)),
      );
    }

    /**
     * 读宿主语言 id；拿不到返回空串（按中文处理）。
     * @param {any} ctx 插件上下文
     * @returns {string} 语言 id
     */
    function readLocaleId(ctx) {
      try {
        let service = ctx && ctx.locale;
        if (!service && ctx && typeof ctx.get === 'function') {
          try {
            service = ctx.get('locale');
          } catch (error) {
            service = null;
          }
        }
        const snapshot =
          service && typeof service.getSnapshot === 'function' ? service.getSnapshot() : null;
        return snapshot && typeof snapshot.id === 'string' ? snapshot.id : '';
      } catch (error) {
        return '';
      }
    }

    return {
      inject: ['slots'],
      /**
       * 注册侧边栏图标与主面板。
       * @param {any} ctx 宿主插件上下文
       * @returns {void}
       */
      apply(ctx) {
        try {
          localeId = readLocaleId(ctx);
          const slots = ctx && ctx.slots;
          if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
            registerInto(slots);
            return;
          }
          // 兼容写法：宿主只提供 ctx.inject(['slots'], …) 时走这一支。
          if (ctx && typeof ctx.inject === 'function') {
            ctx.inject(['slots'], (scope) => {
              if (scope && scope.slots) registerInto(scope.slots);
            });
            return;
          }
          throw new Error('宿主客户端缺少 slots 服务');
        } catch (error) {
          console.error('[dsh-collect] 侧边栏面板注册失败：', error);
        }
      },
    };
  },
});
