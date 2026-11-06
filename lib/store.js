// dsh-collect · 本机设置存储
//
// 面板里保存的设置写在 $DSH_HOME/dsh-collect/settings.json（只在本机，不上传、不进仓库）。
// 合并规则：**面板保存的值优先于 cordis.patch.yml 里的 config**。
// 每次读取按 mtime 判断是否需要重读，所以保存后不用重启插件。
//
// 文件里不含任何凭据；图片、采集结果都写在用户的工作目录。

import { readFileSync, writeFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** 设置目录：优先 $DSH_HOME/dsh-collect，回退 ~/.dsh/dsh-collect。 */
export function settingsDir() {
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
  return path.join(home, 'dsh-collect');
}

/** 设置文件路径。 */
export function settingsFile() {
  return path.join(settingsDir(), 'settings.json');
}

/** mtime 缓存：同一文件没变就不重复解析。 */
const cache = { mtimeMs: 0, data: undefined };

/**
 * 读取已保存的设置（带 mtime 缓存）。
 * @returns {{data: object, savedAt: string}} 文件不存在时 data 为 {}。
 */
export function readSettings() {
  const file = settingsFile();
  let stat;
  try {
    stat = statSync(file);
  } catch {
    cache.data = {};
    cache.mtimeMs = 0;
    return { data: {}, savedAt: '' };
  }
  if (stat.mtimeMs !== cache.mtimeMs || cache.data === undefined) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      cache.data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      cache.mtimeMs = stat.mtimeMs;
    } catch {
      cache.data = {};
      cache.mtimeMs = stat.mtimeMs;
    }
  }
  const data = cache.data || {};
  return { data, savedAt: typeof data._savedAt === 'string' ? data._savedAt : '' };
}

/**
 * 原子写入设置。`_savedAt` 由本函数维护，其它 `_` 开头的键会被丢弃。
 * @param {object} next - 完整设置对象（不是增量）。
 * @returns {{data: object, savedAt: string}} 落盘后的设置。
 */
export function writeSettings(next) {
  const dir = settingsDir();
  mkdirSync(dir, { recursive: true });
  const data = {};
  for (const [key, value] of Object.entries(next && typeof next === 'object' ? next : {})) {
    if (key.startsWith('_')) continue;
    data[key] = value;
  }
  data._savedAt = new Date().toISOString();
  const file = settingsFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  cache.mtimeMs = 0;
  cache.data = undefined;
  return readSettings();
}

/**
 * 深合并：把已保存设置叠到 cordis 配置之上（保存值优先）。
 * 空字符串 / null / undefined 视为「没设」，不覆盖下层。
 * @param {object} base - cordis 传入的配置。
 * @param {object} saved - 设置文件里的值。
 * @returns {object} 合并结果。
 */
export function mergeSettings(base, saved) {
  const merge = (target, source) => {
    const out = { ...(target || {}) };
    for (const [key, value] of Object.entries(source || {})) {
      if (key.startsWith('_')) continue;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        out[key] = merge(out[key], value);
      } else if (value !== undefined && value !== null && value !== '') {
        out[key] = value;
      }
    }
    return out;
  };
  return merge(base, saved);
}
