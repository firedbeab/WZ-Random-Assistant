const theme = require('../../utils/theme');
const feedback = require('../../utils/admin-feedback');
const community = require('../../utils/community');
const colors = require('../../utils/color-palette');
const { cloudCall, isTestMode } = require('../../utils/runtime');
Page(theme.page(feedback.page({
  data: { alias: '点歌同学', profileReady: false, loading: true, error: '', submission: null, weekLabel: '',
    sheet: '', sheetClosing: false, busy: false, dirty: false, aliasDraft: '', isTestMode: isTestMode(),
    modes: [{ id: 'system', label: '跟随系统' }, { id: 'light', label: '浅色' }, { id: 'dark', label: '深色' }],
    palettes: [{ id: 'green', label: '松绿', color: colors.PRESETS.green }, { id: 'blue', label: '晴蓝', color: colors.PRESETS.blue },
      { id: 'amber', label: '暖橙', color: colors.PRESETS.amber }, { id: 'plum', label: '烟紫', color: colors.PRESETS.plum }]
  },
  ...community.sheetMethods,
  onLoad() { this._alive = true; },
  onShow() { this.load(); },
  onUnload() { this._alive = false; clearTimeout(this._sheetTimer); },
  async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
  async load() {
    const seq = this._loadSeq = (this._loadSeq || 0) + 1;
    this.setData({ loading: true, error: '' });
    try {
      // 先沿用原接口准备旧用户；显示称呼不创建另一套身份。
      const user = await cloudCall({ name: 'getUserInfo' });
      if (!user.result || !user.result.success) throw new Error(user.result && user.result.message || '账号读取失败');
      const [profile, record] = await Promise.all([community.api('getProfile'), cloudCall({ name: 'getUserInfo', data: { action: 'getMySubmission', weekKey: community.weekKey() } })]);
      if (!record.result || !record.result.success) throw new Error('本周点歌读取失败，请刷新重试');
      if (!this._alive || seq !== this._loadSeq) return;
      this.setData({ alias: profile.alias, profileReady: true, submission: record.result.data,
        weekLabel: community.weekKey().replace(/-/g, '.') + ' 期' });
    } catch (e) { if (this._alive && seq === this._loadSeq) this.setData({ error: e.message }); }
    finally { if (this._alive && seq === this._loadSeq) this.setData({ loading: false }); }
  },
  editAlias() { if (this.data.profileReady) this.openSheet('alias', { aliasDraft: this.data.alias === '点歌同学' ? '' : this.data.alias }); },
  inputAlias(e) { this.setData({ aliasDraft: e.detail.value, dirty: true, sheetError: '' }); },
  async saveAlias() {
    if (this.data.busy) return;
    const alias = this.data.aliasDraft.trim();
    if (Array.from(alias).length < 2 || alias.length > 12) { this.setData({ sheetError: '称呼需要 2–12 个字，无需使用真实姓名。' }); return; }
    this.setData({ busy: true, sheetError: '' });
    try { const result = await community.api('setAlias', { alias }); if (!this._alive) return; this.setData({ alias: result.alias, dirty: false }); this.finishSheet(); feedback.showToast(this, { title: '称呼已保存', icon: 'success' }); }
    catch (e) { if (this._alive) this.setData({ sheetError: e.message }); }
    finally { if (this._alive) this.setData({ busy: false }); }
  },
  openAppearance() { const state = theme.getState(); this.openSheet('appearance', { selectedMode: state.mode, selectedPalette: state.palette, customColor: state.customColor || '#28764f', colorEditing: false }); },
  selectMode(e) { this.setData({ selectedMode: e.currentTarget.dataset.id, dirty: true }); },
  selectPalette(e) { this.setData({ selectedPalette: e.currentTarget.dataset.id, colorEditing: false, dirty: true }); },
  openColor() { this.setData({ colorEditing: true, selectedPalette: 'custom', dirty: true }); },
  changeColor(e) { this.setData({ customColor: e.detail.value, selectedPalette: 'custom', dirty: true }); },
  saveAppearance() {
    if (!theme.setPreference({ mode: this.data.selectedMode, palette: this.data.selectedPalette, customColor: this.data.customColor })) { this.setData({ sheetError: '颜色无效，请使用六位十六进制颜色。' }); return; }
    this.setData({ dirty: false }); this.finishSheet(); feedback.showToast(this, { title: '外观已保存', icon: 'success' });
  },
  openSubmission() { if (this.data.submission) this.openSheet('submission'); else this.goHome(); },
  goHome() { wx.reLaunch({ url: '/pages/index/index' }); },
  goFeedback() { wx.navigateTo({ url: '/pages/feedback/index' }); },
  goAbout() { wx.navigateTo({ url: '/pages/about/index' }); }
})));
