const theme = require('../../utils/theme');
const feedback = require('../../utils/admin-feedback');
const community = require('../../utils/community');
Page(theme.page(feedback.page({
 data: { entries: [], loading: true, error: '', offset: 0, hasMore: false, sheet: '', sheetClosing: false, detail: null, busy: false },
 ...community.sheetMethods,
 onLoad() { this._alive = true; },
 onShow() { this.load(); },
 onUnload() { this._alive = false; clearTimeout(this._sheetTimer); },
 async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
 async load(more = false) {
   if (more && this.data.loading) return;
   const seq = this._seq = (this._seq || 0) + 1;
   this.setData({ loading: true, error: '' });
   try {
     const result = await community.api('listMine', { offset: more ? this.data.offset : 0 });
     if (!this._alive || seq !== this._seq) return;
     const items = (more ? this.data.entries : []).concat(result.items.map(community.feedbackView));
     this.setData({ entries: [...new Map(items.map(item => [item._id, item])).values()], offset: result.offset, hasMore: result.hasMore });
   } catch (e) { if (this._alive && seq === this._seq) this.setData({ error: e.message }); }
   finally { if (this._alive && seq === this._seq) this.setData({ loading: false }); }
 },
 retry() { this.load(); }, loadMore() { this.load(true); },
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

})));
