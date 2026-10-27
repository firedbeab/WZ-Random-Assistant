const theme = require('../../utils/theme');
const feedback = require('../../utils/admin-feedback');
const community = require('../../utils/community');
const { isTestMode } = require('../../utils/runtime');
Page(theme.page(feedback.page({
  data: { allowed: false, tab: 'feedback', loading: true, error: '', entries: [], polls: [], status: '', userKey: '',
    offset: 0, hasMore: false, busy: false, sheet: '', dirty: false, sheetClosing: false, detail: null, reply: '', selectedStatus: 'received',
    statuses: [{ id: '', label: '全部' }, { id: 'received', label: '已收到' }, { id: 'handling', label: '处理中' }, { id: 'done', label: '已处理' }],
    processStatuses: [{ id: 'received', label: '已收到' }, { id: 'handling', label: '处理中' }, { id: 'done', label: '已处理' }],
    title: '', description: '', options: ['', ''], days: 7, durations: [3, 7, 14], isTestMode: isTestMode() },
  ...community.sheetMethods,
  async onLoad() {
    this._alive = true;
    // 服务端先鉴权；即使客户端篡改 allowed，所有管理接口仍验证正式超管身份。
    await this.load();
  },
  onUnload() { this._alive = false; clearTimeout(this._sheetTimer); },
  async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
  switchTab(e) { const tab = e.currentTarget.dataset.tab; if (this.data.busy || !['feedback', 'polls'].includes(tab) || tab === this.data.tab) return; this.setData({ tab, hasMore: false, offset: 0, error: '' }); this.load(); },
  filter(e) { if (this.data.busy) return; this.setData({ status: e.currentTarget.dataset.id }); this.load(); },
  sameUser() { const key = this.data.detail.userKey; this.setData({ userKey: key }); this.finishSheet(); this.load(); },
  clearUser() { this.setData({ userKey: '' }); this.load(); },
  async load(more = false) {
    if (more && this.data.loading) return;
    const tab = this.data.tab, seq = this._seq = (this._seq || 0) + 1, field = tab === 'feedback' ? 'entries' : 'polls';
    this.setData({ loading: true, error: '' });
    try {
      const result = await community.api(tab === 'feedback' ? 'adminList' : 'adminListPolls', { offset: more ? this.data.offset : 0, status: this.data.status, userKey: this.data.userKey });
      if (!this._alive || seq !== this._seq) return;
      const items = result.items.map(tab === 'feedback' ? community.feedbackView : community.pollView), combined = more ? this.data[field].concat(items) : items;
      this.setData({ allowed: true, [field]: [...new Map(combined.map(item => [item._id, item])).values()], hasMore: result.hasMore, offset: result.offset });
    } catch (e) { if (this._alive && seq === this._seq) this.setData({ error: e.message, ...(e.code === 'FORBIDDEN' || e.code === 'TEST_ACCESS_DENIED' ? { allowed: false, entries: [], polls: [] } : {}) }); }
    finally { if (this._alive && seq === this._seq) this.setData({ loading: false }); }
  },
  retry() { this.load(); },
  loadMore() { this.load(true); },
  openFeedback(e) {
    const detail = this.data.entries.find(item => item._id === e.currentTarget.dataset.id);
    if (detail && this.data.allowed) this.openSheet('detail', { detail, reply: detail.reply, selectedStatus: detail.status });
  },
  inputReply(e) { this.setData({ reply: e.detail.value, dirty: true, sheetError: '' }); },
  selectStatus(e) { this.setData({ selectedStatus: e.currentTarget.dataset.id, dirty: true }); },
  async saveReply() {
    if (this.data.busy || !this.data.allowed) return;
    this.setData({ busy: true, sheetError: '' });
    try {
      await community.api('adminUpdate', { id: this.data.detail._id, revision: this.data.detail.revision, status: this.data.selectedStatus, reply: this.data.reply });
      if (!this._alive) return;
      this.setData({ dirty: false }); this.finishSheet(); feedback.showToast(this, { title: '处理结果已保存', icon: 'success' }); await this.load();
    } catch (e) { if (this._alive) this.setData({ sheetError: e.message }); }
    finally { if (this._alive) this.setData({ busy: false }); }
  },
  newPoll() { if (!this.data.allowed) return; this._createId = community.requestId(); this._createSignature = ''; this.openSheet('newPoll', { title: '', description: '', options: ['', ''], days: 7 }); },
  inputPoll(e) { const field = e.currentTarget.dataset.field; if (['title', 'description'].includes(field)) this.setData({ [field]: e.detail.value, dirty: true, sheetError: '' }); },
  inputOption(e) { const index = Number(e.currentTarget.dataset.index); if (!Number.isInteger(index) || index < 0 || index >= this.data.options.length) return; const options = this.data.options.slice(); options[index] = e.detail.value; this.setData({ options, dirty: true, sheetError: '' }); },
  addOption() { if (this.data.options.length < 4) this.setData({ options: this.data.options.concat(''), dirty: true }); },
  removeOption(e) { if (this.data.options.length <= 2) return; const index = Number(e.currentTarget.dataset.index); this.setData({ options: this.data.options.filter((_, i) => i !== index), dirty: true }); },
  selectDays(e) { this.setData({ days: Number(e.currentTarget.dataset.days), dirty: true }); },
  async createPoll() {
    if (this.data.busy || !this.data.allowed) return;
    if (this.data.title.trim().length < 2 || this.data.options.some(option => !option.trim()) || new Set(this.data.options.map(v => v.trim())).size !== this.data.options.length) { this.setData({ sheetError: '填写标题和 2–4 个不重复的选项。' }); return; }
    this.setData({ busy: true, sheetError: '' });
    try {
      const signature = JSON.stringify([this.data.title, this.data.description, this.data.options, this.data.days]);
      if (signature !== this._createSignature) { this._createId = community.requestId(); this._createSignature = signature; }
      await community.api('createPoll', { title: this.data.title, description: this.data.description, options: this.data.options, days: this.data.days, requestId: this._createId });
      if (!this._alive) return;
      this.setData({ dirty: false }); this.finishSheet(); feedback.showToast(this, { title: '投票已发布', icon: 'success' }); await this.load();
    } catch (e) { if (this._alive) this.setData({ sheetError: e.message }); }
    finally { if (this._alive) this.setData({ busy: false }); }
  },
  async endPoll(e) {
    if (this.data.busy || !this.data.allowed) return;
    const id = e.currentTarget.dataset.id;
    const result = await feedback.showModal(this, { title: '结束这个投票？', content: '结束后不能再投票或改票，结果会保留。', confirmText: '结束投票' });
    if (!result.confirm || !this._alive) return;
    this.setData({ busy: true });
    try { await community.api('endPoll', { id }); if (!this._alive) return; feedback.showToast(this, { title: '投票已结束', icon: 'success' }); await this.load(); }
    catch (e) { this.fail(e); }
    finally { if (this._alive) this.setData({ busy: false }); }
  }
})));
