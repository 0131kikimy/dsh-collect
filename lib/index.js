// dsh-collect · 插件入口（采文 · CollectKit）
//
// 做三件事：
//   1. 注册三个 Agent 工具：collect_fetch / collect_export / collect_settings。
//   2. 挂载面板 API：/dsh-collect/api/*（面板在 lib/client.js，由宿主 Web UI 加载）。
//   3. 按面板设置执行策略：默认**拦截桌面操控类工具**，直到用户在面板里打开开关。
//
// 生命周期约束（实测）：
//   · apply 的返回值必须保持 undefined，不要用 ctx.effect —— 该版 Cordis 会把非 undefined
//     返回值当 effect 校验，返回数组/函数会抛 TypeError 导致整个插件不激活。
//   · 工具注册绑定在本次 apply 的 fiber 上，宿主卸载插件时随之撤销。
//   · 路由注册可能跨 HMR 重入，旧路由要先注销（duplicate route 会抛错）。

import path from 'node:path';
import { access } from 'node:fs/promises';

import { Config, resolveConfig, validateConfig } from './config.js';
import { mergeSettings, readSettings, writeSettings } from './store.js';
import { registerRoutes } from './routes.js';
import { installTools } from './tools.js';
import {
  collectUrls,
  listItems,
  outputRoot,
  parseUrls,
  probeCapabilities,
  readItem,
  safeJoin,
  workspaceRoot,
} from './pipeline.js';

/** 插件版本（与 package.json 同步）。 */
const VERSION = '1.0.0';

/** 跨 HMR 的全局路由登记：模块级变量会被重新求值，只有 globalThis 能活过重载。 */
const ROUTE_REGISTRY = Symbol.for('dsh-collect.routes');

/**
 * 判断一个工具是不是「桌面操控」类。
 * @param {string} toolName - 工具名。
 * @returns {boolean} 是否属于 computer use 家族。
 */
function isComputerUseTool(toolName) {
  return /(^|__)(cua|computer_use|computeruse|windows_computer_use)(__|$)/i.test(toolName)
    || /computer[_ ]?use/i.test(toolName);
}

/**
 * 判断这次调用是否是浏览器标签页（页面内）操作：参数里带 browserTab / pageId。
 * @param {unknown} args - 工具参数。
 * @returns {boolean} 是否浏览器通道。
 */
function isBrowserLaneCall(args) {
  if (!args || typeof args !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (args);
  return typeof record.browserTab === 'string' || typeof record.pageId === 'string';
}

/**
 * 插件入口。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [config] - cordis.patch.yml 里这一行的 config。
 * @returns {void}
 */
export function apply(ctx, config) {
  const baseConfig = resolveConfig(config);

  /** 当前生效配置（面板保存的值优先）。 */
  let active = baseConfig;

  /** 重新解析生效配置；出错时保留上一份可用配置。 */
  const resolveActive = () => {
    try {
      const saved = readSettings().data;
      const result = validateConfig(mergeSettings(baseConfig, saved));
      if (result.issues) throw new Error(result.issues.map((item) => item.message).join('；'));
      active = result.value;
    } catch (error) {
      ctx.logger?.warn?.(`dsh-collect: 设置文件里的配置非法，沿用上一份可用配置（${error?.message ?? error}）`);
    }
    return active;
  };
  active = resolveActive();

  /**
   * 保存设置：先校验「已存设置 + 本次 patch」的合并结果，再落盘。
   * @param {object} patch - 增量设置。
   * @returns {{config: object}|{issues: {message:string}[]}} 结果。
   */
  const applySettings = (patch) => {
    const saved = readSettings().data;
    const candidate = mergeSettings(saved, patch);
    const result = validateConfig(mergeSettings(baseConfig, candidate));
    if (result.issues) return { issues: result.issues };
    writeSettings(candidate);
    active = result.value;
    return { config: active };
  };

  const log = (message) => ctx.logger?.info?.(message);

  // ── 1. 面板 API ───────────────────────────────────────────────────────────
  const deps = {
    version: VERSION,
    getConfig: () => resolveActive(),
    applySettings,
    collect: (input) => collectUrls(ctx, resolveActive(), input.urls, { log }),
    listItems: () => listItems(ctx, resolveActive()),
    readItem: (relative) => readItem(ctx, resolveActive(), relative),
    itemDir: (relative) => {
      const root = workspaceRoot(ctx);
      const output = outputRoot(ctx, resolveActive());
      const absolute = safeJoin(root, relative);
      if (!absolute) return null;
      const normalized = path.resolve(absolute);
      const rootAbsolute = path.resolve(output);
      if (normalized !== rootAbsolute && !normalized.startsWith(rootAbsolute + path.sep)) return null;
      return normalized;
    },
    workspaceRoot: () => workspaceRoot(ctx),
    workspace: async () => {
      const root = workspaceRoot(ctx);
      const output = outputRoot(ctx, resolveActive());
      let exists = false;
      try {
        await access(output);
        exists = true;
      } catch {
        exists = false;
      }
      return { root, outputRoot: output, exists };
    },
    parseUrls,
    capabilities: () => probeCapabilities(ctx, resolveActive()),
    log,
  };

  /**
   * 挂载面板路由（webServer 可能晚于本插件就绪，调用方负责等待）。
   * @param {object} webServer - 宿主 webServer 服务。
   * @param {string} via - 来源标记，用于日志。
   * @returns {void}
   */
  const mountRoutes = (webServer, via) => {
    if (!webServer || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.(`dsh-collect: （${via}）没有 webServer，面板 API 未挂载`);
      return;
    }
    try {
      try {
        globalThis[ROUTE_REGISTRY]?.dispose?.();
      } catch {
        /* 旧路由可能已随宿主撤销 */
      }
      const routes = registerRoutes({ webServer, deps });
      globalThis[ROUTE_REGISTRY] = routes;
      log(`dsh-collect: 面板 API 已挂载（${via}）`);
    } catch (error) {
      const message = String(error?.message ?? error);
      if (/duplicate/i.test(message)) {
        ctx.logger?.warn?.(`dsh-collect: 面板路由已存在（${via}），沿用旧实例`);
        return;
      }
      ctx.logger?.warn?.(`dsh-collect: 面板路由注册失败（${via}）：${message}`);
    }
  };

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (sub) => {
        mountRoutes(sub?.webServer ?? sub?.get?.('webServer'), 'inject');
      });
    } catch (error) {
      ctx.logger?.warn?.(`dsh-collect: 等待 webServer 失败：${error?.message ?? error}`);
    }
  } else {
    mountRoutes(ctx.get?.('webServer'), 'direct');
  }

  // ── 2. 桌面操控策略守卫 ───────────────────────────────────────────────────
  const toolsService = ctx.get?.('tools') ?? ctx.tools;
  if (toolsService?.guard) {
    try {
      toolsService.guard((execution) => {
        const name = String(execution?.name ?? '');
        if (!isComputerUseTool(name)) return undefined;
        const current = resolveActive();
        const browserLane = isBrowserLaneCall(execution?.arguments);
        if (browserLane) {
          if (current.acquisition.browserTabs) return undefined;
          return '采文：当前设置禁止「浏览器标签页」通道。需要时请用户在左侧栏「采文」面板打开该开关。';
        }
        if (current.acquisition.computerUse) return undefined;
        return '采文：当前设置禁止桌面操控（computer 操控类工具已被拦截）。需要时请用户在左侧栏「采文」面板打开「桌面操控」开关。';
      });
    } catch (error) {
      ctx.logger?.warn?.(`dsh-collect: 桌面操控守卫注册失败：${error?.message ?? error}`);
    }
  }

  // ── 3. 提示词补充（让模型知道有这两个工具、以及当前策略） ─────────────────
  const systemPrompt = ctx.get?.('systemPrompt') ?? ctx.systemPrompt;
  if (systemPrompt?.section) {
    try {
      systemPrompt.section({
        name: 'dsh-collect',
        order: 42,
        text: () => {
          const current = resolveActive();
          const policy = [
            current.acquisition.computerUse ? '允许桌面操控' : '禁止桌面操控',
            current.acquisition.browserTabs ? '允许浏览器标签页' : '禁止浏览器标签页',
          ].join('，');
          return [
            '采文（dsh-collect）插件已安装：用户可在左侧栏「采文」面板采集网页并生成文件。',
            `· collect_fetch：抓取网址正文与图片，存到工作目录/${current.output.dir}；`,
            '· collect_export：把采集结果生成为 docx / xlsx / pptx / pdf / md / html / txt / csv / json；',
            '· collect_settings：读取或修改采集设置。',
            `当前策略：${policy}。被策略拦下的工具不要反复重试，改为告诉用户去面板打开对应开关。`,
          ].join('\n');
        },
      });
    } catch (error) {
      ctx.logger?.warn?.(`dsh-collect: 提示词补充失败：${error?.message ?? error}`);
    }
  }

  // ── 4. 工具 ───────────────────────────────────────────────────────────────
  let names = [];
  try {
    names = installTools({
      ctx,
      version: VERSION,
      getConfig: () => resolveActive(),
      applySettings,
      collect: (input) => collectUrls(ctx, resolveActive(), input.urls, { log }),
      readItem: (relative) => readItem(ctx, resolveActive(), relative),
      itemDir: deps.itemDir,
      listItems: deps.listItems,
      log,
    });
  } catch (error) {
    ctx.logger?.error?.(`dsh-collect: 工具注册失败：${error?.stack ?? error}`);
    throw error;
  }

  ctx.logger?.info?.(
    `dsh-collect: 启动完成（v${VERSION}，输出目录 ${active.output.dir}，已注册工具 ${names.join(', ') || '无'}，桌面操控${active.acquisition.computerUse ? '允许' : '已拦截'}）`,
  );

  // 刻意不返回任何值：见文件头注释。
  return undefined;
}
