const theme = require('../../utils/theme');
const feedback = require('../../utils/admin-feedback');
const community = require('../../utils/community');
const { isTestMode } = require('../../utils/runtime');
Page(theme.page(feedback.page({
  data: { tab: 'feedback', categories: ['使用问题', '功能建议', '其他'], category: '使用问题', content: '',
    version: '1.9', isTestMode: isTestMode(), entries: [], polls: [], loading: true, error: '', hasMore: false, offset: 0,
    sheet: '', sheetClosing: false, dirty: false, busy: false, detail: null },
  ...community.sheetMethods,
  onLoad() { this._alive = true; this._requestId = community.requestId(); this.load(); },
  onUnload() { this._alive = false; clearTimeout(this._sheetTimer); },
  async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
  switchTab(e) { const tab = e.currentTarget.dataset.tab; if (this.data.busy || !['feedback', 'polls'].includes(tab) || tab === this.data.tab) return; this.setData({ tab, error: '', hasMore: false, offset: 0 }); this.load(); },
  inputContent(e) { this.setData({ content: e.detail.value }); },
  selectCategory(e) { this.setData({ category: e.currentTarget.dataset.category }); },
  async load(more = false) {
    if (more && this.data.loading) return;
    const tab = this.data.tab, seq = this._seq = (this._seq || 0) + 1, field = tab === 'feedback' ? 'entries' : 'polls';
    this.setData({ loading: true, error: '' });
    try {
      const result = await community.api(tab === 'feedback' ? 'listMine' : 'listPolls', { offset: more ? this.data.offset : 0 });
      if (!this._alive || seq !== this._seq) return;
      const items = result.items.map(tab === 'feedback' ? community.feedbackView : community.pollView);
      const combined = more ? this.data[field].concat(items) : items;
      this.setData({ [field]: [...new Map(combined.map(item => [item._id, item])).values()], hasMore: result.hasMore, offset: result.offset });
    } catch (e) { if (this._alive && seq === this._seq) this.setData({ error: e.message }); }
    finally { if (this._alive && seq === this._seq) this.setData({ loading: false }); }
  },
  loadMore() { this.load(true); },
  retry() { this.load(); },
  async submit() {
    if (this.data.busy) return;
    if (this.data.content.trim().length < 2) { feedback.showToast(this, { title: '请至少填写两个字，描述具体一点更方便处理。' }); return; }
    this.setData({ busy: true }); feedback.showLoading(this, { title: '正在提交反馈', mask: true });
    const content = this.data.content, category = this.data.category;
    // 同一请求失败后保留编号；正文发生变化才成为新请求，避免网络重试重复入库。
    const signature = category + '\n' + content;
    if (signature !== this._requestSignature) { this._requestSignature = signature; this._requestId = community.requestId(); }
    try {
      await community.api('submitFeedback', { category, content, version: this.data.version, requestId: this._requestId });
      if (!this._alive) return;
      this.setData({ content: '' }); this._requestSignature = null;
      feedback.showToast(this, { title: '反馈已收到，可在下方查看处理进度', icon: 'success' }); await this.load();
    } catch (e) { this.fail(e); }
    finally { if (this._alive) { this.setData({ busy: false }); feedback.hideLoading(this); } }
  },
  async openFeedback(e) {
    if (this.data.busy) return;
    const entry = this.data.entries.find(item => item._id === e.currentTarget.dataset.id); if (!entry) return;
    this.openSheet('detail', { detail: entry });
    const sheetToken = this._detailToken = (this._detailToken || 0) + 1;
    try {
      const result = await community.api('getFeedback', { id: entry._id });
      if (!this._alive || sheetToken !== this._detailToken || this.data.sheet !== 'detail' || this.data.sheetClosing) return;
      const detail = community.feedbackView(result); this.setData({ detail });
      // 仅确认这次已展示的回复版本，不把后来更新的回复误标已读。
      if (detail.unread && detail.reply) {
        const updated = await community.api('markRead', { id: detail._id, replyVersion: detail.replyVersion });
        if (!this._alive) return;
        this.setData({ entries: this.data.entries.map(item => item._id === updated._id ? community.feedbackView(updated) : item) });
      }
    } catch (e) { this.fail(e); }
  },
  async vote(e) {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try { await community.api('vote', { id: e.currentTarget.dataset.id, choice: Number(e.currentTarget.dataset.choice) }); if (!this._alive) return; feedback.showToast(this, { title: '选择已记录', icon: 'success' }); await this.load(); }
    catch (e) { this.fail(e); if (e.code === 'POLL_CLOSED' && this._alive) await this.load(); }
    finally { if (this._alive) this.setData({ busy: false }); }
  }
})));
