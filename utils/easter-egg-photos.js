const { cloudCall, storageKey, isTestMode } = require('./runtime');
const imageAccess = require('./image-access');
const diagnostics = require('./image-diagnostics');
const encounters = require('./easter-encounters');
const MANIFEST_KEY = storageKey('easter_manifest_v2');
const FILES_KEY = storageKey('easter_files_v2');
const DIR = `${wx.env.USER_DATA_PATH}/easter-${isTestMode() ? 'test' : 'prod'}`;
const MAX_BYTES = 12 * 1024 * 1024;
const DEFAULT_TOP = '喵，原来是你呀。';
const DEFAULT_BOTTOM = '今天的小幸运，是和小猫碰个面。';
const tasks = Object.create(null);
let manifestTask;
let commitQueue = Promise.resolve();
function storage(key, fallback) { try { return wx.getStorageSync(key) || fallback; } catch (_) { return fallback; } }
function save(key, value) { try { wx.setStorageSync(key, value); } catch (_) { /* 缓存失败不阻断彩蛋。 */ } }
function fsCall(method, options) {
  return new Promise((resolve, reject) => wx.getFileSystemManager()[method]({ ...options, success: resolve, fail: reject }));
}
function withTimeout(promise, ms = 2500) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]).finally(() => clearTimeout(timer));
}
async function manifest(force = false) {
  const cached = storage(MANIFEST_KEY, { entries: [], time: 0 });
  if (!force && Date.now() - cached.time < 60000) return cached.entries;
  if (manifestTask) return manifestTask;
  manifestTask = (async () => {
    try {
      const res = await cloudCall({ name: 'manageEasterEggs', data: { action: 'listPublished' } });
      if (!res.result || !res.result.success) throw new Error('manifest');
      const entries = res.result.data.entries || [];
      save(MANIFEST_KEY, { entries, time: Date.now() });
      return entries;
    } catch (_) { return Date.now() - cached.time < 86400000 ? cached.entries : []; }
  })();
  try { return await manifestTask; } finally { manifestTask = null; }
}
async function cachedPath(fileID) {
  const index = storage(FILES_KEY, {});
  const item = index[fileID];
  if (!item || typeof item.path !== 'string' || !item.path.startsWith(`${DIR}/`)) return '';
  try { await fsCall('access', { path: item.path }); }
  catch (_) { delete index[fileID]; save(FILES_KEY, index); return ''; }
  item.lastUsed = Date.now(); save(FILES_KEY, index);
  return item.path;
}
function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return (value >>> 0).toString(16);
}
function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: res => {
        if (res.statusCode === 200 && res.tempFilePath) resolve(res);
        else reject(Object.assign(new Error(`HTTP_${res.statusCode || 0}`), { code: `HTTP_${res.statusCode || 0}` }));
      },
      fail: err => reject(err)
    });
  });
}
// 私有桶下普通用户不能用 fileID 直接下载，必须先换成服务端签发的短时地址。
async function fetchImage(fileID) {
  try {
    const url = await imageAccess.resolve('manageEasterEggs', fileID);
    return await downloadUrl(url);
  } catch (err) {
    // 上传者本人或旧环境仍可直连 fileID；普通用户会再次失败，由上层回退文字猫。
    diagnostics.record('easter_photo', 'signed_download', err);
    return await wx.cloud.downloadFile({ fileID });
  }
}
function cacheImage(fileID) {
  if (tasks[fileID]) return tasks[fileID];
  tasks[fileID] = (async () => {
    const path = await cachedPath(fileID);
    if (path) return path;
    const download = await fetchImage(fileID);
    const info = await fsCall('getFileInfo', { filePath: download.tempFilePath });
    // 单张上限放宽到 5MB：上限过小时大图只能退回签名地址，导致每次点开大图都要重新下载。
    if (!info.size || info.size > 5 * 1024 * 1024) throw new Error('image size');
    // 下载并行，磁盘/索引提交串行，保证12MB上限及并发索引不丢失。
    const commit = commitQueue.catch(() => {}).then(async () => {
      try { await fsCall('mkdir', { dirPath: DIR, recursive: true }); }
      catch (err) { if (!/exist/i.test(err.errMsg || '')) throw err; }
      const index = storage(FILES_KEY, {});
      let total = Object.values(index).reduce((sum, item) => sum + (Number(item.size) || 0), 0);
      const ids = Object.keys(index).sort((a, b) => index[a].lastUsed - index[b].lastUsed);
      for (const id of ids) {
        if (total + info.size <= MAX_BYTES) break;
        const old = index[id];
        if (typeof old.path === 'string' && old.path.startsWith(`${DIR}/`)) {
          try { await fsCall('unlink', { filePath: old.path }); } catch (_) { /* 失效文件也移除索引。 */ }
        }
        total -= Number(old.size) || 0; delete index[id];
      }
      const ext = /\.(jpg|jpeg|png|webp)$/.exec(fileID);
      const target = `${DIR}/${hash(fileID)}-${Date.now()}.${ext ? ext[1] : 'jpg'}`;
      await fsCall('copyFile', { srcPath: download.tempFilePath, destPath: target });
      index[fileID] = { path: target, size: info.size, lastUsed: Date.now() };
      save(FILES_KEY, index);
      return target;
    });
    commitQueue = commit;
    return commit;
  })();
  tasks[fileID].then(() => { delete tasks[fileID]; }, () => { delete tasks[fileID]; });
  return tasks[fileID];
}
async function prepare(lastId = '') {
  const entries = await withTimeout(manifest());
  const entry = encounters.pick('photo', entries, lastId);
  if (!entry) return null;
  let path = '';
  try {
    path = await cacheImage(entry.fileID);
  } catch (err) {
    // 落盘缓存失败（空间不足、下载中断）时仍可用签名地址直接显示，不再一律回退文字猫。
    diagnostics.record('easter_photo', 'cache', err);
    path = await imageAccess.resolve('manageEasterEggs', entry.fileID).catch(fallbackError => {
      diagnostics.record('easter_photo', 'signed_only', fallbackError);
      return '';
    });
  }
  if (!path) return null;
  return { ...entry, path, catalogIds: entries.map(item => item.id), hasCustomBottom: Boolean((entry.bottomText || '').trim()), topText: entry.topText || DEFAULT_TOP, bottomText: entry.bottomText || DEFAULT_BOTTOM };
}
async function prepareCached(lastId = '') {
  const entries = await withTimeout(manifest());
  const available = (await Promise.all(entries.map(async entry => ({ ...entry, path: await cachedPath(entry.fileID) })))).filter(entry => entry.path);
  const entry = encounters.pick('photo', available, lastId);
  return entry ? { ...entry, catalogIds: entries.map(item => item.id), hasCustomBottom: Boolean((entry.bottomText || '').trim()), topText: entry.topText || DEFAULT_TOP, bottomText: entry.bottomText || DEFAULT_BOTTOM } : null;
}
function warm() { withTimeout(manifest(true)).then(entries => {
  const start = Math.floor(Math.random() * entries.length);
  return Promise.all(entries.slice(start, start + 2).map(entry => cacheImage(entry.fileID).catch(() => '')));
}).catch(() => {}); }
// 预览前确保拿到本地文件；落盘失败时退回刷新后的签名地址。
function ensureLocal(fileID) { return cacheImage(fileID); }
function refreshSignedUrl(fileID) { return imageAccess.resolve('manageEasterEggs', fileID); }
module.exports = { manifest, cacheImage, cachedPath, prepare, prepareCached, warm, withTimeout, ensureLocal, refreshSignedUrl, DEFAULT_TOP, DEFAULT_BOTTOM };
