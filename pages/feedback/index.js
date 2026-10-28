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
  goHistory() { wx.navigateTo({ url: '/pages/feedback/history' }); },
  onTabTouchStart(e) {
    const t = e.touches && e.touches.length === 1 && e.touches[0];
    this._tabTouch = !this.data.busy && !this.data.focusedField && t && t.clientX >= 24 ? { x:t.clientX, y:t.clientY, time:e.timeStamp } : null;
  },
  onTabTouchMove(e) {
    const t = e.touches && e.touches.length === 1 && e.touches[0], s = this._tabTouch;
    if (s && (!t || Math.abs(t.clientY-s.y) > 18 && Math.abs(t.clientY-s.y) > Math.abs(t.clientX-s.x))) this._tabTouch = null;
  },
  onTabTouchCancel() { this._tabTouch = null; },
  onTabTouchEnd(e) {
    const s = this._tabTouch, t = e.changedTouches && e.changedTouches.length === 1 && e.changedTouches[0]; this._tabTouch = null;
    if (!s || !t || e.timeStamp-s.time > 650) return;
    const dx = t.clientX-s.x, dy = t.clientY-s.y;
    if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy)*1.8) return;
    if (dx < 0 && this.data.tab === 'feedback' || dx > 0 && this.data.tab === 'polls') this.switchTab({currentTarget:{dataset:{tab:dx < 0 ? 'polls' : 'feedback'}}});
  },
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
      feedback.showToast(this, { title: '反馈已收到，可在我的反馈查看进度', icon: 'success' }); await this.load();
    } catch (e) { this.fail(e); }
    finally { if (this._alive) { this.setData({ busy: false }); feedback.hideLoading(this); } }
  },
  async vote(e) {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try { await community.api('vote', { id: e.currentTarget.dataset.id, choice: Number(e.currentTarget.dataset.choice) }); if (!this._alive) return; feedback.showToast(this, { title: '选择已记录', icon: 'success' }); await this.load(); }
    catch (e) { this.fail(e); if (e.code === 'POLL_CLOSED' && this._alive) await this.load(); }
    finally { if (this._alive) this.setData({ busy: false }); }
  }
})));
