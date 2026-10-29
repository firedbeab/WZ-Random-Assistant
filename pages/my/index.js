const theme = require('../../utils/theme');
const feedback = require('../../utils/admin-feedback');
const community = require('../../utils/community');
const colors = require('../../utils/color-palette');
const presentation = require('../../utils/my-presentation');
const { cloudCall, isTestMode, storageKey } = require('../../utils/runtime');
// 只放本次小程序会话内存，按测试/正式域隔离；不将账号资料长期落盘。
const snapshots = new Map();
const cacheKey = () => storageKey('my_summary_v1');
async function readUser(data) {
  let res;
  try { res = await cloudCall({ name: 'getUserInfo', ...(data ? { data } : {}) }); }
  catch (_) { throw new Error('网络暂不可用，请稍后重试。'); }
  if (!res.result || !res.result.success) throw new Error(res.result && res.result.message || '账号读取失败');
  return res.result.data;
}
Page(theme.page(feedback.page({
  data: { alias: '点歌同学', profileReady: false, firstUseText: '正在读取首次使用日期', loading: true, error: '', refreshError: '',
    submission: null, week: presentation.loading(), sheet: '', sheetClosing: false, busy: false, dirty: false,
    aliasVisible: false, aliasClosing: false, aliasDraft: '', aliasError: '', focusedField: '', isTestMode: isTestMode(),
    modes: [{ id: 'system', label: '跟随系统' }, { id: 'light', label: '浅色' }, { id: 'dark', label: '深色' }],
    palettes: [{ id: 'green', label: '松绿', color: colors.PRESETS.green }, { id: 'blue', label: '晴蓝', color: colors.PRESETS.blue },
      { id: 'amber', label: '暖橙', color: colors.PRESETS.amber }, { id: 'plum', label: '烟紫', color: colors.PRESETS.plum },
      { id: 'wzred', label: 'WZ红', color: colors.PRESETS.wzred }]
  },
  ...community.sheetMethods,
  onLoad() {
    this._alive = true;
    const cached = snapshots.get(cacheKey());
    if (cached) {
      this._snapshot = cached;
      this.setData({ alias: cached.alias, firstUseText: cached.firstUseText, profileReady: true });
      if (presentation.context(cached.channel).weekKey === cached.periodKey) this.setData({ week: cached.week, submission: cached.submission, loading: false });
    }
  },
  onShow() {
    const state = theme.getState();
    this.setData({ selectedMode: state.mode, selectedPalette: state.palette });
    this.load();
  },
  onHide() { theme.flushPreference(); this.setData({ focusedField: '' }); },
  onUnload() { this._alive = false; theme.flushPreference(); clearTimeout(this._sheetTimer); clearTimeout(this._aliasTimer); clearTimeout(this._colorScrollTimer); },
  async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
  async load() {
    const seq = this._loadSeq = (this._loadSeq || 0) + 1;
    const current = this._snapshot && presentation.context(this._snapshot.channel);
    const keep = current && current.weekKey === this._snapshot.periodKey;
    if (!keep) this.setData({ loading: true, week: presentation.loading(), submission: null });
    this.setData({ error: '', refreshError: '' });
    try {
      const aliasRevision = this._aliasRevision || 0;
      const user = await readUser();
      if (!user) throw new Error('账号资料尚未准备好，请重试。');
      const period = presentation.context(user);
      if (!this._alive || seq !== this._loadSeq) return;
      const profilePatch = { profileReady: true, firstUseText: presentation.firstUse(user.created_at) };
      if (aliasRevision === (this._aliasRevision || 0)) profilePatch.alias = user.name_alias || '点歌同学';
      for (const field of Object.keys(profilePatch)) if (this.data[field] === profilePatch[field]) delete profilePatch[field];
      if (Object.keys(profilePatch).length) this.setData(profilePatch);
      const [submission, schedule] = await Promise.all([
        readUser({ action: 'getMySubmission', weekKey: period.weekKey }),
        readUser({ action: 'getPublishedSchedule', weekKey: period.weekKey })
      ]);
      if (!this._alive || seq !== this._loadSeq) return;
      // 请求期间用户已经改名，旧资料响应不能把新称呼覆盖回去。
      const alias = aliasRevision === (this._aliasRevision || 0) ? user.name_alias || '点歌同学' : this.data.alias;
      const value = { alias, firstUseText: presentation.firstUse(user.created_at), periodKey: period.weekKey,
        channel: { channelForceOpen: user.channelForceOpen, channelForceClose: user.channelForceClose },
        submission, week: presentation.state({ period, submission, schedule }) };
      const patch = { profileReady: true };
      for (const field of ['alias', 'firstUseText', 'submission', 'week']) if (JSON.stringify(this.data[field]) !== JSON.stringify(value[field])) patch[field] = value[field];
      this._snapshot = value; snapshots.set(cacheKey(), value); this.setData(patch);
    } catch (e) {
      if (this._alive && seq === this._loadSeq) this.setData(keep ? { refreshError: '更新失败，当前保留上次读取结果。可下拉重试。' } : { error: e.message, week: presentation.failed() });
    }
    finally { if (this._alive && seq === this._loadSeq) this.setData({ loading: false }); }
  },
  editAlias() { if (this.data.profileReady) { clearTimeout(this._aliasTimer); this.setData({ aliasVisible: true, aliasClosing: false, aliasError: '', aliasDraft: this.data.alias === '点歌同学' ? '' : this.data.alias }); } },
  inputAlias(e) { this.setData({ aliasDraft: e.detail.value, aliasError: '' }); },
  closeAlias() {
    if (this.data.busy || this.data.aliasClosing) return;
    if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
    this.setData({ aliasClosing: true, focusedField: '' });
    this._aliasTimer = setTimeout(() => { if (this._alive) this.setData({ aliasVisible: false, aliasClosing: false }); }, 180);
  },
  async saveAlias() {
    if (this.data.busy) return;
    const alias = this.data.aliasDraft.trim();
    if (Array.from(alias).length < 2 || alias.length > 12) { this.setData({ aliasError: '称呼需要 2–12 个字，无需使用真实姓名。' }); return; }
    this.setData({ busy: true, aliasError: '' });
    try {
      const result = await community.api('setAlias', { alias }); if (!this._alive) return;
      this._aliasRevision = (this._aliasRevision || 0) + 1;
      this.setData({ alias: result.alias, busy: false });
      if (this._snapshot) { this._snapshot = { ...this._snapshot, alias: result.alias }; snapshots.set(cacheKey(), this._snapshot); }
      this.closeAlias(); feedback.showToast(this, { title: '称呼已保存', icon: 'success' });
    }
    catch (e) { if (this._alive) this.setData({ aliasError: e.message }); }
    finally { if (this._alive) this.setData({ busy: false }); }
  },
  openAppearance() { const state = theme.getState(); this.openSheet('appearance', { selectedMode: state.mode, selectedPalette: state.palette, customColor: state.customColor || '#28764f', colorEditing: false }); },
  selectMode(e) { const mode = e.currentTarget.dataset.id; if (theme.setPreference({ mode })) this.setData({ selectedMode: mode }); },
  selectPalette(e) {
    const palette = e.currentTarget.dataset.id;
    if (theme.setPreference({ mode: theme.getState().mode, palette })) this.setData({ selectedPalette: palette, colorEditing: false });
  },
  openColor() {
    this.setData({ colorEditing: !this.data.colorEditing });
    // 只展开不修改选中的配色；实际调色时才切到自定义。
  },
  onColorKeyboardFocus(e) {
    this.onKeyboardFieldFocus({ currentTarget: { dataset: { keyboardTarget: '#color-input-end', keyboardLayer: 'overlay' } }, detail: e.detail || {} });
    clearTimeout(this._colorScrollTimer);
    this.setData({ colorScrollAnchor: '' });
    this._colorScrollTimer = setTimeout(() => { if (this._alive && this.data.sheet === 'appearance' && this.data.colorEditing) this.setData({ colorScrollAnchor: 'color-input-end' }); }, 220);
  },
  onColorKeyboardBlur() { clearTimeout(this._colorScrollTimer); this.setData({ colorScrollAnchor: '' }); this.onKeyboardFieldBlur(); },
  changeColor(e) {
    const value = e.detail.value;
    if (!colors.normalize(value)) return;
    this.setData({ customColor: value, selectedPalette: 'custom' });
    theme.setPreference({ mode: theme.getState().mode, palette: 'custom', customColor: value }, { deferSave: !e.detail.final });
  },
  closeSheet() {
    if (this.data.sheet === 'appearance') { theme.flushPreference(); this.finishSheet(); }
    else return community.sheetMethods.closeSheet.call(this);
  },
  openSubmission() { if (this.data.submission) this.openSheet('submission'); else this.goHome(); },
  weekAction() {
    const action = this.data.week.action;
    if (action === 'retry') this.load();
    else if (action === 'playlist') wx.navigateTo({ url: '/pages/playlist/index' });
    else if (action === 'submission') this.openSubmission();
    else if (action === 'home') this.goHome();
  },
  goHome() { wx.reLaunch({ url: '/pages/index/index' }); },
  goFeedback() { wx.navigateTo({ url: '/pages/feedback/index' }); },
  goAbout() { wx.navigateTo({ url: '/pages/about/index' }); }
})));
