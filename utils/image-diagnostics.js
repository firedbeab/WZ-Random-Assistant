// 轻量、脱敏的图片诊断记录：只保留模块、阶段、错误码和时间。
// 不记录 openid、投稿内容、图片地址或签名链接，最多保留最近 30 条。
const STORAGE_KEY = 'img_diag_v1';
const LIMIT = 30;

function codeOf(error) {
  if (!error) return 'unknown';
  const raw = error.code || error.errMsg || error.message || String(error);
  return String(raw).replace(/https?:\/\/\S+/g, '[url]').slice(0, 80);
}

function record(module, stage, error) {
  const entry = { module: String(module || 'unknown'), stage: String(stage || 'unknown'), code: codeOf(error), at: Date.now() };
  try {
    const list = wx.getStorageSync(STORAGE_KEY);
    const next = (Array.isArray(list) ? list : []).concat(entry).slice(-LIMIT);
    wx.setStorageSync(STORAGE_KEY, next);
  } catch (_) { /* 写缓存失败不影响主流程。 */ }
  try { console.warn('[image]', entry.module, entry.stage, entry.code); } catch (_) { /* 忽略。 */ }
  return entry;
}

function list() {
  try { const value = wx.getStorageSync(STORAGE_KEY); return Array.isArray(value) ? value : []; }
  catch (_) { return []; }
}

module.exports = { record, list, STORAGE_KEY };
