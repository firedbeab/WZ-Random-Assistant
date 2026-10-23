// 云存储是私有桶（仅"创建者可读写"），普通用户直接拿 fileID 下载会被平台拒绝。
// 这里统一向云函数申请"短期可用的 https 地址"：服务端先核验该文件确实属于已发布内容，
// 再签发一个 10 分钟内有效的签名地址。地址到期后用同一接口自动换新。
const { cloudCall } = require('./runtime');

const SAFETY_MS = 60 * 1000;   // 到期前留一分钟余量，避免用到刚好过期的地址
const MAX_ATTEMPTS = 2;
const RETRY_DELAY = 600;
const MAX_BATCH = 10;          // 与服务端单次上限保持一致

const urls = Object.create(null);      // fileID -> { url, expiresAt }
const pending = Object.create(null);   // fileID -> Promise<string>

function valid(fileID) {
  const item = fileID ? urls[fileID] : null;
  if (!item || typeof item.url !== 'string') return '';
  return item.expiresAt - SAFETY_MS > Date.now() ? item.url : '';
}

function forget(fileID) { if (fileID) delete urls[fileID]; }
function clear() { Object.keys(urls).forEach(key => delete urls[key]); }

async function request(fnName, fileIDs) {
  const res = await cloudCall({ name: fnName, data: { action: 'getImageAccess', fileIDs } });
  const result = res && res.result;
  if (!result || result.success !== true) {
    const error = new Error((result && (result.code || result.message)) || 'IMAGE_ACCESS_FAILED');
    error.code = (result && result.code) || 'IMAGE_ACCESS_FAILED';
    throw error;
  }
  const files = result.data && Array.isArray(result.data.files) ? result.data.files : [];
  files.forEach(file => {
    if (file && typeof file.fileID === 'string' && typeof file.url === 'string' && Number.isFinite(file.expiresAt)) {
      urls[file.fileID] = { url: file.url, expiresAt: file.expiresAt };
    }
  });
  return files;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// 单个文件的地址：先查本地缓存，再走一次带重试的请求；并发请求同一文件时共享同一个 Promise。
async function resolve(fnName, fileID) {
  if (typeof fileID !== 'string' || !fileID) throw new Error('IMAGE_ID_INVALID');
  const cached = valid(fileID);
  if (cached) return cached;
  if (pending[fileID]) return pending[fileID];
  const task = (async () => {
    let lastError;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const files = await request(fnName, [fileID]);
        const hit = files.find(file => file && file.fileID === fileID);
        if (hit && valid(fileID)) return valid(fileID);
        lastError = new Error('IMAGE_URL_MISSING');
      } catch (err) {
        lastError = err;
      }
      if (attempt + 1 < MAX_ATTEMPTS) await sleep(RETRY_DELAY);
    }
    throw lastError || new Error('IMAGE_ACCESS_FAILED');
  })();
  pending[fileID] = task;
  try { return await task; } finally { delete pending[fileID]; }
}

// 批量：只请求还没有有效地址的那些，返回 { fileID: url }，失败项不出现在结果里。
async function resolveMany(fnName, fileIDs) {
  const list = (Array.isArray(fileIDs) ? fileIDs : []).filter(id => typeof id === 'string' && id);
  const result = Object.create(null);
  const missing = [];
  list.forEach(id => { const hit = valid(id); if (hit) result[id] = hit; else if (missing.indexOf(id) < 0) missing.push(id); });
  for (let i = 0; i < missing.length; i += MAX_BATCH) {
    const chunk = missing.slice(i, i + MAX_BATCH);
    try {
      const files = await request(fnName, chunk);
      files.forEach(file => {
        const hit = file && typeof file.fileID === 'string' ? valid(file.fileID) : '';
        if (hit) result[file.fileID] = hit;
      });
    } catch (_) { /* 单批失败不影响其它批次，交给调用方决定重试。 */ }
  }
  return result;
}

module.exports = { resolve, resolveMany, valid, forget, clear };
