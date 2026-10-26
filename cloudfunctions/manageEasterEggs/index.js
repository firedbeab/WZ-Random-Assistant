const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const { createDataScope, canUseTestData, isProductionSuperadmin } = require('./dataScope');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const DOC = 'easter_eggs_v1';
const MAX_BYTES = 2 * 1024 * 1024;
const ok = (data) => ({ success: true, data });
const fail = (message) => ({ success: false, message });
const IMAGE_URL_MAX_AGE = 600;
const recentErrors = new Map();

async function recordServerError(scope, action, err) {
  const allowed = ['listPublished', 'getImageAccess', 'listAll', 'uploadImage', 'deleteFiles', 'save', 'delete', 'setEnabled'];
  const operation = allowed.includes(action) ? action : 'unknown';
  const error = Number.isInteger(err && err.errCode) ? `SDK_${err.errCode}` : 'BACKEND_UNAVAILABLE';
  const entry = { source: 'server', module: 'manageEasterEggs', action: `easter.${operation}`, error,
    data_scope: scope.testMode ? 'test' : 'production' };
  console.warn('[彩蛋] 后端异常', entry);
  const key = `${scope.prefix}${operation}`;
  if (Date.now() - (recentErrors.get(key) || 0) < 60000) return;
  recentErrors.set(key, Date.now()); // 每个温实例同一域/动作一分钟最多一条；不记录原始错误、文件地址或身份。
  try {
    await db.collection(scope.collection('system_events')).add({ data: {
      ...entry, category: 'system_error', severity: 'error', created_at: db.serverDate()
    } });
  } catch (_) { console.warn('[彩蛋] 错误事件写入失败'); }
}

function safeFile(fileID, scope) {
  if (typeof fileID !== 'string' || fileID.length > 1024) return false;
  const match = /^cloud:\/\/([^/]+)\/(.+)$/.exec(fileID);
  const env = cloud.getWXContext().ENV;
  return Boolean(match && env && (match[1] === env || match[1].startsWith(`${env}.`)) &&
    new RegExp(`^${scope.testMode ? 'test/' : ''}easter-eggs/[a-zA-Z0-9-]+\\.(jpg|jpeg|png|webp)$`).test(match[2]));
}
function extension(buffer) {
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpg';
  if (buffer.length >= 8 && buffer.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer.length >= 12 && buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP') return 'webp';
  return '';
}
async function read(scope) {
  const res = await db.collection(scope.collection('configs')).where({ _id: DOC }).limit(1).get();
  return res.data[0] || { entries: [], revision: 0 };
}
function entriesOf(config, scope) {
  return (Array.isArray(config.entries) ? config.entries : []).filter(item => safeFile(item.fileID, scope));
}
async function checkText(openid, entry, scope) {
  if (scope.testMode || !entry.enabled) return;
  const content = [entry.topText, entry.bottomText].filter(Boolean).join('\n');
  if (!content) return;
  const res = await cloud.openapi.security.msgSecCheck({ openid, scene: 2, version: 2, content });
  if (!res.result || res.result.suggest !== 'pass') throw new Error('文字未通过安全检查，请修改或稍后重试');
}
async function cleanup(files, scope) {
  try {
    const config = await read(scope);
    const used = entriesOf(config, scope).map(item => item.fileID);
    const safe = [...new Set(files)].filter(file => safeFile(file, scope) && !used.includes(file));
    if (safe.length) await cloud.deleteFile({ fileList: safe });
  } catch (err) { await recordServerError(scope, 'deleteFiles', err); }
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const scope = createDataScope(event);
  try {
    if (!await canUseTestData(db, OPENID, scope)) return { ...fail('仅超级管理员可使用测试环境'), code: 'TEST_ACCESS_DENIED' };
    if (event.action === 'listPublished') {
      const config = await read(scope);
      return ok({ entries: entriesOf(config, scope).filter(item => item.enabled === true), revision: config.revision || 0 });
    }
    // 新接口不改变v1.7的fileID与listPublished结构；需新版前端使用HTTPS地址下载。
    if (event.action === 'getImageAccess') {
      if (!OPENID) return { success: false, code: 'UNAUTHENTICATED', message: '无法确认用户身份' };
      if (!Array.isArray(event.fileIDs) || !event.fileIDs.length || event.fileIDs.length > 10 ||
          !event.fileIDs.every(file => safeFile(file, scope))) {
        return { success: false, code: 'INVALID_IMAGE_REQUEST', message: '图片请求无效' };
      }
      const fileIDs = [...new Set(event.fileIDs)];
      const config = await read(scope);
      const published = new Set(entriesOf(config, scope).filter(item => item.enabled === true).map(item => item.fileID));
      if (!fileIDs.every(file => published.has(file))) {
        return { success: false, code: 'IMAGE_NOT_AVAILABLE', message: '图片已下架或不可访问' };
      }
      const issuedAt = Date.now();
      const signed = await cloud.getTempFileURL({ fileList: fileIDs.map(fileID => ({ fileID, maxAge: IMAGE_URL_MAX_AGE })) });
      const files = fileIDs.map(fileID => {
        const item = (signed.fileList || []).find(file => file.fileID === fileID);
        // 3.0.4会向平台传maxAge，但实际成功响应可能不回传该字段。
        const maxAge = item && item.maxAge === undefined ? IMAGE_URL_MAX_AGE : item && item.maxAge;
        if (!item || item.status !== 0 || typeof item.tempFileURL !== 'string' || !/^https:\/\/[^\s]+$/.test(item.tempFileURL) ||
            !Number.isInteger(maxAge) || maxAge <= 0 || maxAge > IMAGE_URL_MAX_AGE) {
          throw new Error('IMAGE_URL_UNAVAILABLE');
        }
        return { fileID, url: item.tempFileURL, maxAge, expiresAt: issuedAt + maxAge * 1000 };
      });
      return ok({ files, revision: config.revision || 0 });
    }
    if (!await isProductionSuperadmin(db, OPENID)) return { ...fail('仅超级管理员可维护彩蛋'), code: 'FORBIDDEN' };
    if (event.action === 'listAll') {
      const config = await read(scope);
      return ok({ entries: entriesOf(config, scope), revision: config.revision || 0 });
    }
    if (event.action === 'uploadImage') {
      if (typeof event.base64 !== 'string' || event.base64.length > Math.ceil(MAX_BYTES * 4 / 3) + 8) return fail('图片不能超过2MB');
      const buffer = Buffer.from(event.base64, 'base64');
      const ext = extension(buffer);
      if (!ext || !buffer.length || buffer.length > MAX_BYTES) return fail('请选择2MB以内的 JPG、PNG 或 WebP 图片');
      const result = await cloud.uploadFile({ cloudPath: `${scope.testMode ? 'test/' : ''}easter-eggs/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`, fileContent: buffer });
      return ok({ fileID: result.fileID });
    }
    if (event.action === 'deleteFiles') {
      if (!Array.isArray(event.fileIDs) || event.fileIDs.length > 10 || !event.fileIDs.every(file => safeFile(file, scope))) return fail('图片路径无效');
      await cleanup(event.fileIDs, scope);
      return ok(null);
    }
    if (!['save', 'delete', 'setEnabled'].includes(event.action)) return fail('不支持的操作');
    const before = await read(scope);
    if (!Number.isInteger(event.revision) || event.revision !== (before.revision || 0)) return fail('内容已更新，请刷新后再操作');
    const id = typeof event.id === 'string' ? event.id : '';
    const previous = entriesOf(before, scope).find(item => item.id === id);
    if (event.action !== 'save' && !previous) return fail('条目不存在');
    let entry;
    if (event.action === 'save') {
      if (id && !previous) return fail('条目不存在');
      if (!safeFile(event.fileID, scope) || typeof event.topText !== 'string' || typeof event.bottomText !== 'string' || event.topText.length > 40 || event.bottomText.length > 100 || typeof event.enabled !== 'boolean') return fail('条目格式不正确');
      entry = { id: id || crypto.randomBytes(12).toString('hex'), fileID: event.fileID, topText: event.topText.trim(), bottomText: event.bottomText.trim(), enabled: event.enabled };
      const downloaded = await cloud.downloadFile({ fileID: entry.fileID });
      if (!Buffer.isBuffer(downloaded.fileContent) || downloaded.fileContent.length > MAX_BYTES || !extension(downloaded.fileContent)) return fail('图片校验失败，请重新选择');
      await checkText(OPENID, entry, scope);
    } else if (event.action === 'setEnabled') {
      if (typeof event.enabled !== 'boolean') return fail('启用状态无效');
      entry = { ...previous, enabled: event.enabled };
      await checkText(OPENID, entry, scope);
    }
    // 单文档原子比较更新：无需多文档事务，仍能阻止并发覆盖。
    let entries = entriesOf(before, scope);
    if (event.action === 'delete') entries = entries.filter(item => item.id !== id);
    else if (previous) entries = entries.map(item => item.id === id ? entry : item);
    else { if (entries.length >= 60) throw new Error('最多保留60个彩蛋条目'); entries.push(entry); }
    const data = { entries, revision: event.revision + 1, updated_at: db.serverDate() };
    const configCollection = db.collection(scope.collection('configs'));
    if (before._id) {
      // 历史文档可能没有 revision 字段，此时按"字段不存在"匹配，
      // 否则条件更新永远匹配不上，会误报"内容已更新，请刷新后再操作"。
      const revisionMatch = (before.revision === undefined || before.revision === null)
        ? _.exists(false)
        : event.revision;
      const changed = await configCollection.where({ _id: DOC, revision: revisionMatch }).update({ data });
      if (!changed.stats || changed.stats.updated !== 1) throw new Error('内容已更新，请刷新后再操作');
    } else {
      // add 指定文档ID而非 set：同时首次保存时只有一个请求能创建。
      try { await configCollection.add({ data: { _id: DOC, ...data } }); }
      catch (err) { if (/duplicate|already exist/i.test(err.message || '')) throw new Error('内容已更新，请刷新后再操作'); throw err; }
    }
    if (previous && (event.action === 'delete' || previous.fileID !== entry.fileID)) await cleanup([previous.fileID], scope);
    return ok({ id: entry ? entry.id : id, revision: event.revision + 1 });
  } catch (err) {
    const expected = ['内容已更新，请刷新后再操作', '最多保留60个彩蛋条目', '文字未通过安全检查，请修改或稍后重试'].includes(err.message);
    if (!expected) await recordServerError(scope, event.action, err);
    return { ...fail(expected ? err.message : '操作失败，请稍后重试'), code: expected ? 'OPERATION_REJECTED' : 'BACKEND_UNAVAILABLE' };
  }
};
