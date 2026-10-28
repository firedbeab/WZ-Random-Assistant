const { cloudCall } = require('./runtime');
const feedback = require('./admin-feedback');
const STATUS = { received: '已收到', handling: '处理中', done: '已处理' };
async function api(action, data = {}) {
  let response;
  try { response = await cloudCall({ name: 'manageFeedback', data: { ...data, action } }); }
  catch (_) { throw new Error('反馈服务暂时无法连接，请稍后重试。当前填写的内容会保留。'); }
  const result = response.result;
  if (!result || !result.success) { const e = new Error(result && result.message || '服务暂不可用，请稍后重试'); e.code = result && result.code; throw e; }
  return result.data;
}
function requestId() { return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }
function date(value) {
  if (!Number.isFinite(Number(value))) return '';
  return new Date(Number(value) + 28800000).toISOString().slice(0, 16).replace('T', ' ').replace(/-/g, '.');
}
const feedbackView = item => ({ ...item, statusLabel: STATUS[item.status] || '已收到', date: date(item.createdAt) });
const pollView = item => ({ ...item, deadline: date(item.endsAt), options: item.options.map(option => ({ ...option,
  percent: item.total ? Math.round(option.count / item.total * 100) : 0 })) });
function weekKey() { const d = new Date(Date.now() + 28800000); d.setUTCDate(d.getUTCDate() + (7 - d.getUTCDay()) % 7); return d.toISOString().slice(0, 10); }
// 所有新页面共用关闭保护和退场时间，正文不充当拖动热区。
const sheetMethods = {
  onCommunityFieldFocus(e) { this.setData({ focusedField: e.currentTarget.dataset.focusField || e.currentTarget.dataset.field }); },
  onCommunityFieldBlur(e) { if (this.data.focusedField === (e.currentTarget.dataset.focusField || e.currentTarget.dataset.field)) this.setData({ focusedField: '' }); },
  openSheet(kind, patch = {}) { clearTimeout(this._sheetTimer); this.setData({ sheet: kind, sheetClosing: false, dirty: false, sheetError: '', ...patch }); },
  async closeSheet() {
    if (this.data.busy || this.data.sheetClosing) return;
    if (this.data.dirty) {
      const result = await feedback.showModal(this, { title: '放弃未保存内容？', content: '本次修改尚未保存。', confirmText: '放弃修改' });
      if (!result.confirm || !this._alive) return;
    }
    this.finishSheet();
  },
  finishSheet() {
    if (!this._alive) return;
    if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
    this.setData({ sheetClosing: true });
    this._sheetTimer = setTimeout(() => { if (this._alive) this.setData({ sheet: '', sheetClosing: false, dirty: false }); }, feedback.DRAWER_CLOSE_MS);
  },
  fail(error) { if (this._alive) feedback.showToast(this, { title: error.message || '网络异常，请稍后重试', duration: 5000 }); },
  goBack() { wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/index/index' }) }); }
};
module.exports = { api, requestId, date, feedbackView, pollView, weekKey, STATUS, sheetMethods };
