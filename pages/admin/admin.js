const feedback = require('../../utils/admin-feedback');
const conflict = require('../../utils/schedule-conflict');
const theme = require('../../utils/theme');
// pages/admin/admin.js
const { cloudCall, collectionName, isTestMode, storageKey } = require('../../utils/runtime');

// 订阅消息模板 ID（管理员：参与活动提醒）
const ADMIN_TPL_ID = 'G9y63KY2Q0mPOS-ML_PtxVu9wqE5xKqVnnNgEFtPC_8';

// showToast 与 showLoading 共用同一层：在 finally 里关掉 loading 会把刚弹出的提示一起抹掉。
// 统一延后一帧再弹，保证提示一定看得见；用户无感知（0ms）。
function toastLater(page, options) {
  setTimeout(() => {
    try { feedback.showToast(page, options); } catch (_) { /* 页面已卸载时忽略 */ }
  }, 0);
}

// 北京时间“本周日”的周标识，与云函数里的算法保持一致（周日当天返回当天）。
function currentWeekKey() {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const diff = (7 - bj.getUTCDay()) % 7;
  const sun = new Date(bj.getTime());
  sun.setUTCDate(bj.getUTCDate() + diff);
  return sun.toISOString().split('T')[0];
}

Page(theme.page(feedback.page({
  data: {
    isTestMode: isTestMode(),
    // 审核相关
    thisWeekKey: currentWeekKey(),
    scheduleWeekKey: '',
    scheduleIsCurrentWeek: true,
    schedule: null,
    note: '',
    publishing: false,
    showModal: false,
    modalSong: null,
    modalDay: 0,
    modalSongIndex: null,
    selectedReason: '',
    customReason: '',
    reasons: ['内容不可用', '内容不适宜', '版权受限'],
    // 选项卡
    currentTab: 'audit',
    panelVisible: true,
    bulkDay: -1,
    batchMode: false,
    batchRemoving: false,
    batchSelectedCount: 0,
    batchResultMessage: '',
    showBulkConfirmDrawer: false,
    bulkConfirmDays: [],
    auditChecked: { day0: {}, day1: {}, day2: {}, day3: {}, day4: {} },
    activeSongCount: 0,
    auditLoading: false,
    auditError: '',
    scheduleConflict: false,
    showAuditTips: false,
    showPublishNote: false,
    showPublishDrawer: false,
    publishNoteValid: false,
    publishDayCount: 0,
    publishError: '',
    showBatchDrawer: false,
    showSongDrawer: false,
    actionSong: null,
    actionDay: 0,
    actionSongIndex: 0,
    drawerClosing: false,
    // 验证码管理
    codeList: [],
    showCodeModal: false,
    newCode: '',
    newExpireDate: '',
    editingCodeId: null,
    // 测试工具
    isTestEnv: false,
    isSuperAdmin: false,
    testStats: null,
    // 管理员管理
    passcodeList: [],
    adminList: [],
    helpArticleList: [],
    helpLoading: false,
    showPasscodeModal: false,
    newPasscodeLabel: '',
    showPasscodeResultModal: false,
    generatedPasscode: '',
    // 通知订阅
    subscribed: false,
    // 通道控制
    channelMode: undefined,
    channelLoading: false,
    channelBusy: false,
    // 特殊备注弹窗
    showNoteModal: false,
    noteSong: null,
    noteDay: 0,
    noteSongIndex: null,
    noteText: '',
    noteSaving: false,
    auditSelections: { day0: [], day1: [], day2: [], day3: [], day4: [] },
    pendingRemovalCount: 0,
    dayCounts: [],
  },

  onLoad() {
    this._adminUnloaded = false;
    this.setData({ panelVisible: true, drawerClosing: false });
    const app = getApp();

    // 先使用已加载的云端角色初始化界面，随后再次从服务端校验
    const isTestEnv = app.globalData.isTestEnv || false;
    const isSuperAdmin = (app.globalData.userInfo &&
                          app.globalData.userInfo.role === 'superadmin') || false;
    this.setData({ isTestEnv: isTestEnv || isSuperAdmin, isSuperAdmin });

    // 每次进入都从服务端校验权限，确保被撤销的管理员立即失效
    this.checkPermissionFromCloud();
  },

  // 下拉刷新：任何页面状态不对时，管理员可以自己拉一下，不必退出重进。
  async onPullDownRefresh() {
    if (this.data.batchRemoving || this.data.publishing) { wx.stopPullDownRefresh(); return; }
    await this.loadPlaylist(false);
    if (this.data.currentTab === 'codes') await this.loadCodeList({ force: true });
    if (this.data.currentTab === 'admins') await Promise.all([this.loadPasscodeList(), this.loadAdminList()]);
    if (this.data.currentTab === 'test') await Promise.all([this.loadTestStats(), this.loadChannelStatus()]);
    if (this.data.currentTab === 'help') await this.loadHelpArticles(false);
    wx.stopPullDownRefresh();
  },

  onShow() {
    if (this.data.currentTab === 'help' && this.data.isSuperAdmin) {
      this.loadHelpArticles(false);
    }
  },

  onUnload() { feedback.clear(this);
    this._adminUnloaded = true;
    clearTimeout(this._panelTimer);
    clearTimeout(this._panelShowTimer);
    clearTimeout(this._drawerTimer);
  },

  goEasterEggs() {
    if (this.data.isSuperAdmin) wx.navigateTo({ url: '/pages/admin/easter-eggs' });
  },

  goFeedbackManager() {
    if (this.data.isSuperAdmin) wx.navigateTo({ url: '/pages/admin/feedback' });
  },

  async checkPermissionFromCloud() {
    feedback.showLoading(this, { title: '验证身份...' });
    try {
      const res = await cloudCall({ name: 'getUserInfo' });
      if (res.result.success && (res.result.data.role === 'admin' || res.result.data.role === 'superadmin')) {
        const app = getApp();
        const userInfo = res.result.data;
        const role = userInfo.role;
        const isSuperAdmin = role === 'superadmin';
        app.globalData.userInfo = userInfo;

        // 本地缓存只用于兼容旧逻辑，管理权限和超管界面均以云端角色为准
        wx.setStorageSync(storageKey('admin_auth'), {
          isAdmin: true,
          isSuperAdmin,
          role
        });
        this.setData({
          isTestEnv: (app.globalData.isTestEnv || false) || isSuperAdmin,
          isSuperAdmin
        });
        // 首屏只加载审核页需要的数据；验证码、测试工具和管理员列表改为切页时再加载。
        await Promise.all([
          this.loadPlaylist(false),
          this.checkSubscriptionStatus()
        ]);
        // 静默预取验证码列表：管理员多半会切到该页，提前拉一次可省掉首次切页的冷启动等待。
        this.loadCodeList({ silent: true });
      } else {
        this.showNoPermission();
      }
    } catch (err) {
      console.warn('身份验证失败');
      toastLater(this, { title: '网络异常', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
    } finally {
      feedback.hideLoading(this);
    }
  },

  // 检查订阅状态，更新按钮显示
  async checkSubscriptionStatus() {
    if (this.data.isTestMode) {
      this.setData({ subscribed: false });
      return;
    }
    try {
      const db = wx.cloud.database();
      const res = await db.collection(collectionName('message_subscriptions'))
        .where({ openid: '{openid}', template_id: ADMIN_TPL_ID, type: 'admin', consumed: false })
        .limit(1).get();
      this.setData({ subscribed: res.data.length > 0 });
    } catch (e) {
      // 检查失败不影响主流程
    }
  },

  showNoPermission() {
    toastLater(this, { title: '无权限访问', icon: 'none' });
    setTimeout(() => wx.navigateBack(), 1500);
  },

  // 管理员身份绑定微信账号，返回首页不会清除云端角色
  onBackHome() {
    wx.navigateBack();
  },

  // 切换选项卡
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!['audit', 'codes', 'test', 'manage', 'admins', 'help', 'data'].includes(tab)) return;
    if (tab === 'test' && !this.data.isTestEnv) return;
    if (['manage', 'admins', 'help', 'data'].includes(tab) && !this.data.isSuperAdmin) return;
    // 导航立即更新，淡入交给新面板CSS；不让定时器或透明层阻挡点击。
    clearTimeout(this._panelTimer);
    clearTimeout(this._panelShowTimer);
    if (tab === this.data.currentTab) {
      this.setData({ panelVisible: true });
      return;
    }
    this.setData({ currentTab: tab, panelVisible: true });
    this.loadTabData(tab);
  },

  adminTabs() {
    const tabs = ['audit', 'codes'];
    if (this.data.isTestEnv) tabs.push('test');
    if (this.data.isSuperAdmin) tabs.push('manage');
    return tabs;
  },
  onAdminTouchStart(e) {
    this._adminTouch = null;
    if (!this.adminTabs().includes(this.data.currentTab) || this.data.batchMode || this.data.publishing || this.data._adminFeedbackLoading) return;
    const touch = e.touches && e.touches.length === 1 && e.touches[0];
    if (!touch || !Number.isFinite(touch.clientX) || !Number.isFinite(touch.clientY) || touch.clientX < 24) return;
    this._adminTouch = { x: touch.clientX, y: touch.clientY, time: e.timeStamp };
  },
  onAdminTouchMove(e) {
    const start = this._adminTouch, touch = e.touches && e.touches.length === 1 && e.touches[0];
    if (!start) return;
    if (!touch || !Number.isFinite(touch.clientX) || !Number.isFinite(touch.clientY)) return this.onAdminTouchCancel();
    const dx = Math.abs(touch.clientX - start.x), dy = Math.abs(touch.clientY - start.y);
    if (dy > 12 && dy > dx) this.onAdminTouchCancel();
  },
  onAdminTouchCancel() { this._adminTouch = null; },
  onAdminTouchEnd(e) {
    const start = this._adminTouch; this._adminTouch = null;
    const touch = e.changedTouches && e.changedTouches.length === 1 && e.changedTouches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y, elapsed = e.timeStamp - start.time;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || elapsed < 50 || elapsed > 650 || Math.abs(dx) < 60 || Math.abs(dy) > 50 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
    const tabs = this.adminTabs(), next = tabs.indexOf(this.data.currentTab) + (dx < 0 ? 1 : -1);
    if (next < 0 || next >= tabs.length) return;
    this.switchTab({ currentTarget: { dataset: { tab: tabs[next] } } });
  },

  loadTabData(tab) {
    if (tab === 'codes') {
      this.loadCodeList({ force: true });
    } else if (tab === 'test') {
      Promise.all([this.loadTestStats(), this.loadChannelStatus()]);
    } else if (tab === 'admins') {
      Promise.all([this.loadPasscodeList(), this.loadAdminList()]);
    } else if (tab === 'help') {
      this.loadHelpArticles();
    } else if (tab === 'audit') {
      this.loadPlaylist();
    }
  },

  toggleAuditTips() { this.setData({ showAuditTips: !this.data.showAuditTips }); },
  togglePublishNote() { this.setData({ showPublishNote: !this.data.showPublishNote }); },
  retryPlaylist() { return this.loadPlaylist(); },
  toggleAuditDay(e) {
    const day = Number(e.currentTarget.dataset.day);
    if (!Number.isInteger(day) || day < 0 || day > 4) return;
    this.setData({ bulkDay: this.data.bulkDay === day ? -1 : day,
      auditSelections: { day0: [], day1: [], day2: [], day3: [], day4: [] },
      auditChecked: { day0: {}, day1: {}, day2: {}, day3: {}, day4: {} } });
  },
  openSongActions(e) {
    if (this.data.scheduleConflict) { this.notifyScheduleConflict(); return; }
    const { song, day, songIndex } = e.currentTarget.dataset;
    this.setData({ showSongDrawer: true, actionSong: song, actionDay: Number(day), actionSongIndex: Number(songIndex) });
  },
  closeSongDrawer() { this.closeAdminDrawer('showSongDrawer'); },
  onSongDrawerAction(e) {
    const { actionSong: song, actionDay: day, actionSongIndex: songIndex } = this.data;
    const action = e.currentTarget.dataset.action;
    if (!song || !['note', 'exception', 'remove'].includes(action)) return;
    this.closeAdminDrawer('showSongDrawer', () => {
      const next = { currentTarget: { dataset: { song, day, songIndex } } };
      if (action === 'note') this.onOpenNote(next);
      if (action === 'exception') this.onException(next);
      if (action === 'remove') {
        this.setData({ [`auditSelections.day${day}`]: [String(songIndex)] });
        this.onRemoveSelectedFromDay(next);
      }
    });
  },
  openBatchRemoval() {
    if (this.data.scheduleConflict) { this.notifyScheduleConflict(); return; }
    if (!this.data.schedule || this.data.batchRemoving) return;
    this.setData({ batchMode: !this.data.batchMode, batchSelectedCount: 0, batchResultMessage: '', bulkDay: -1,
      auditSelections: { day0: [], day1: [], day2: [], day3: [], day4: [] },
      auditChecked: { day0: {}, day1: {}, day2: {}, day3: {}, day4: {} } });
  },
  closeBatchDrawer() { this.closeAdminDrawer('showBatchDrawer'); },
  chooseBatchDay(e) {
    const day = Number(e.currentTarget.dataset.day);
    if (!Number.isInteger(day) || day < 0 || day > 4 || !this.data.dayCounts[day].active) return;
    this.closeAdminDrawer('showBatchDrawer', () => this.toggleAuditDay({ currentTarget: { dataset: { day } } }));
  },
  toggleAuditSong(e) {
    const { day, songIndex } = e.currentTarget.dataset;
    if (!this.data.batchMode || this.data.batchRemoving) return;
    const song = this.data.schedule && (this.data.schedule[`day${Number(day) + 1}`] || [])[Number(songIndex)];
    if (!song || song.audit_state === 'pending_remove') return;
    const selected = (this.data.auditSelections[`day${day}`] || []).slice();
    const index = selected.indexOf(String(songIndex));
    if (index < 0) selected.push(String(songIndex)); else selected.splice(index, 1);
    this.onAuditSelectionChange({ currentTarget: { dataset: { day } }, detail: { value: selected } });
  },
  closeAdminDrawer(field, afterClose) {
    if (this.data.drawerClosing) return;
    this.setData({ drawerClosing: true });
    this._drawerTimer = setTimeout(() => {
      if (this._adminUnloaded) return;
      this.setData({ [field]: false, drawerClosing: false });
      if (afterClose) afterClose();
    }, feedback.DRAWER_CLOSE_MS);
  },

  // 按钮点击：开启通知（首次订阅，会弹窗）
  async onEnableNotification() {
    if (this.data.isTestMode) {
      this.setData({ subscribed: true });
      toastLater(this, { title: '测试环境已模拟订阅', icon: 'none' });
      return;
    }
    try {
      const db = wx.cloud.database();
      const openid = getApp().globalData.userInfo.openid;

      const res = await wx.requestSubscribeMessage({ tmplIds: [ADMIN_TPL_ID] });
      if (res[ADMIN_TPL_ID] === 'accept') {
        // 再次检查避免重复创建
        const existing = await db.collection(collectionName('message_subscriptions'))
          .where({ openid: '{openid}', template_id: ADMIN_TPL_ID, type: 'admin', consumed: false })
          .limit(1).get();
        if (existing.data.length === 0) {
          await db.collection(collectionName('message_subscriptions')).add({
            data: {
              openid,
              template_id: ADMIN_TPL_ID,
              type: 'admin',
              consumed: false,
              created_at: db.serverDate()
            }
          });
        }
        this.setData({ subscribed: true });
        toastLater(this, { title: '已开启通知', icon: 'success' });
      }
    } catch (err) {
      console.warn('订阅失败:', err);
    }
  },

  // ========== 审核相关方法 ==========

  notifyScheduleConflict() {
    this.setData({ scheduleConflict: true, showPublishDrawer: false, showBulkConfirmDrawer: false,
      showSongDrawer: false });
    feedback.showModal(this, { title: conflict.TITLE, content: conflict.MESSAGE,
      confirmText: '刷新歌单', cancelText: '稍后', success: result => { if (result.confirm) return this.refreshConflictedSchedule(); } });
  },
  handleScheduleError(error) {
    if (!conflict.isConflict(error)) return false;
    this.notifyScheduleConflict(); return true;
  },
  async refreshConflictedSchedule() {
    if (this.data.auditLoading) return;
    await this.loadPlaylist(false);
    if (!this.data.scheduleConflict) this.setData({ showModal: false, showNoteModal: false });
  },
  checkScheduleSnapshot(saved) {
    if (this.data.scheduleConflict || !conflict.matches(saved, this.data.schedule)) { this.notifyScheduleConflict(); return false; }
    return true;
  },

  // 写操作成功后：服务端必然把 revision +1，本地立即同步，避免紧接着的操作带着旧版本号提交。
  bumpRevision() {
    const schedule = this.data.schedule;
    if (!schedule) return;
    this.setData({ 'schedule.revision': (Number(schedule.revision) || 1) + 1 });
  },
  // 写成功后统一收尾：先本地校准版本号，再后台拉一次真实数据。
  async refreshAfterWrite() {
    this.bumpRevision();
    await this.loadPlaylist(false);
  },

  async loadPlaylist(showLoading = true) {
    this.setData({ auditLoading: true, auditError: '' });
    if (showLoading) feedback.showLoading(this, { title: '加载中' });
    try {
      const res = await cloudCall({
        name: 'adminAuditPlaylist',
        data: { action: 'getPending' }
      });
      if (res.result.success) {
        const schedule = res.result.data;
        if (!schedule) {
          this.setData({ schedule: null, scheduleConflict: false, scheduleWeekKey: '', activeSongCount: 0, pendingRemovalCount: 0, batchResultMessage: '', bulkDay: -1 });
          return;
        }
        const pendingRemovalCount = ['day1', 'day2', 'day3', 'day4', 'day5']
          .reduce((count, day) => count + (schedule[day] || [])
            .filter(item => item.audit_state === 'pending_remove').length, 0);
        const dayCounts = ['day1', 'day2', 'day3', 'day4', 'day5'].map(day => {
          const items = schedule[day] || [];
          const pending = items.filter(item => item.audit_state === 'pending_remove').length;
          return { active: items.length - pending, pending };
        });
        this.setData({
          schedule,
          scheduleConflict: false,
          pendingRemovalCount,
          batchResultMessage: '',
          dayCounts,
          batchMode: false,
          batchSelectedCount: 0,
          activeSongCount: dayCounts.reduce((total, day) => total + day.active, 0),
          bulkDay: -1,
          auditChecked: { day0: {}, day1: {}, day2: {}, day3: {}, day4: {} },
          // 显示周次并标出是否本周，避免把遗留的旧排期当成本周列表误发。
          scheduleWeekKey: schedule.week_key || '',
          scheduleIsCurrentWeek: (schedule.week_key || '') === currentWeekKey(),
          thisWeekKey: currentWeekKey(),
          auditSelections: { day0: [], day1: [], day2: [], day3: [], day4: [] }
        });
      } else {
        if (res.result.message === '暂无待审核排期') {
          this.setData({ schedule: null, scheduleConflict: false, scheduleWeekKey: '', activeSongCount: 0, pendingRemovalCount: 0, batchResultMessage: '', bulkDay: -1 });
          return;
        }
        this.setData({ auditError: res.result.message || '请稍后重试' });
        toastLater(this, { title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      this.setData({ auditError: '请检查网络后重新加载' });
      console.warn('加载排期失败');
    } finally {
      this.setData({ auditLoading: false });
      if (showLoading) feedback.hideLoading(this);
    }
  },

  onException(e) {
    if (this.data.scheduleConflict) { this.notifyScheduleConflict(); return; }
    this._exceptionSnapshot = conflict.snapshot(this.data.schedule);
    this.setData({
      showModal: true,
      modalSong: e.currentTarget.dataset.song,
      modalDay: e.currentTarget.dataset.day,
      modalSongIndex: e.currentTarget.dataset.songIndex,
      selectedReason: '',
      customReason: ''
    });
  },

  closeModal() { this.closeAdminDrawer('showModal'); },
  selectReason(e) { this.setData({ selectedReason: e.currentTarget.dataset.reason }); },
  onReasonInput(e) { this.setData({ customReason: e.detail.value }); },
  onNoteInput(e) { this.setData({ note: e.detail.value, publishNoteValid: !!e.detail.value.trim(), publishError: '' }); },
  onPublishNoteFocus() { this.setData({ publishNoteFocused: true }); },
  onPublishNoteBlur() { this.setData({ publishNoteFocused: false }); },
  async openExpireDate() {
    const result = await feedback.showDatePicker(this, { title: '选择到期日期', value: this.data.newExpireDate });
    if (result.confirm) this.onExpireDateChange({ detail: { value: result.value } });
  },

  onSkipDay(e) {
    if (this.data.scheduleConflict) { this.notifyScheduleConflict(); return; }
    const saved = conflict.snapshot(this.data.schedule);
    const dayIndex = e.currentTarget.dataset.day;
    const dayLabel = ['周一', '周二', '周三', '周四', '周五'][dayIndex];
    feedback.showModal(this, {
      title: '确认跳过',
      content: `「${dayLabel}」将不安排曲目，现有曲目转回候补。此操作没有一键撤销，确定继续吗？`,
      success: async (res) => {
        if (res.confirm) {
          if (!this.checkScheduleSnapshot(saved)) return;
          feedback.showLoading(this, { title: '处理中' });
          try {
            const ret = await cloudCall({
              name: 'adminAuditPlaylist',
              data: {
                action: 'skipDay',
                playlistId: this.data.schedule._id,
                dayIndex,
                revision: this.data.schedule.revision
              }
            });
            if (ret.result.success) {
              toastLater(this, { title: ret.result.message, icon: 'success' });
              await this.refreshAfterWrite();
            } else {
              if (!this.handleScheduleError(ret.result.message)) toastLater(this, { title: ret.result.message, icon: 'none' });
            }
          } catch (err) {
            if (!this.handleScheduleError(err)) toastLater(this, { title: '操作失败', icon: 'none' });
          } finally {
            feedback.hideLoading(this);
          }
        }
      }
    });
  },

  onAuditSelectionChange(e) {
    const dayIndex = Number(e.currentTarget.dataset.day);
    const selected = e.detail.value || [];
    this.setData({ [`auditSelections.day${dayIndex}`]: selected,
      [`auditChecked.day${dayIndex}`]: selected.reduce((flags, index) => { flags[index] = true; return flags; }, {}) });
    this.setData({ batchSelectedCount: Object.values(this.data.auditSelections).reduce((sum, list) => sum + list.length, 0) });
  },

  openBulkConfirm() {
    const schedule = this.data.schedule;
    if (!schedule || !this.data.batchSelectedCount || this.data.batchRemoving) return;
    const groups = [];
    for (let day = 0; day < 5; day++) {
      const songs = schedule[`day${day + 1}`] || [];
      const songIndexes = (this.data.auditSelections[`day${day}`] || []).map(Number)
        .filter(index => Number.isInteger(index) && songs[index] && songs[index].audit_state !== 'pending_remove');
      if (songIndexes.length) groups.push({ dayIndex: day, songIndexes });
    }
    if (!groups.length) return;
    this._bulkSnapshot = { id: schedule._id, revision: schedule.revision, groups };
    this.setData({ showBulkConfirmDrawer: true, bulkConfirmDays: groups.map(group => ({ day: ['周一','周二','周三','周四','周五'][group.dayIndex], count: group.songIndexes.length })) });
  },
  closeBulkConfirm() { if (!this.data.batchRemoving) this.closeAdminDrawer('showBulkConfirmDrawer'); },
  async confirmBulkRemoval(e) {
    const snapshot = this._bulkSnapshot, schedule = this.data.schedule;
    if (!snapshot || !schedule || !this.data.showBulkConfirmDrawer || this.data.batchRemoving) return;
    if (!this.checkScheduleSnapshot(snapshot)) return;
    const reason = e && e.detail && e.detail.value && e.detail.value.removalReason || '当天安排调整';
    let revision = schedule.revision, confirmed = 0, message = '', failed = false, conflicted = false;
    this.setData({ batchRemoving: true });
    try {
      for (const group of snapshot.groups) {
        const result = await cloudCall({ name: 'adminAuditPlaylist', data: {
          action: 'removeItems', playlistId: snapshot.id, revision, dayIndex: group.dayIndex,
          songIndexes: group.songIndexes, reason: String(reason).trim() || '当天安排调整'
        } });
        if (!result.result.success) throw new Error(result.result.message || '处理未确认');
        confirmed += group.songIndexes.length;
        revision = (Number(revision) || 1) + 1;
      }
      message = `已标记 ${confirmed} 首，发布前可撤销。`;
    } catch (err) {
      failed = true;
      conflicted = conflict.isConflict(err);
      message = `已确认标记 ${confirmed} 首；其余结果未确认，请刷新核对。${err.message || ''}`;
    } finally {
      this._bulkSnapshot = null;
      if (!conflicted) await this.loadPlaylist(false);
      this.setData({ batchRemoving: false, showBulkConfirmDrawer: false, batchMode: false, batchSelectedCount: 0,
        batchResultMessage: failed ? '部分操作未确认，请刷新核对排期。' : '', auditSelections: { day0: [], day1: [], day2: [], day3: [], day4: [] },
        auditChecked: { day0: {}, day1: {}, day2: {}, day3: {}, day4: {} } });
      if (conflicted) this.notifyScheduleConflict();
      else feedback.showToast(this, { title: message, icon: failed ? 'none' : 'success', duration: failed ? 5000 : 2800 });
    }
  },

  onRemoveSelectedFromDay(e) {
    if (this.data.scheduleConflict) { this.notifyScheduleConflict(); return; }
    const saved = conflict.snapshot(this.data.schedule);
    const dayIndex = Number(e.currentTarget.dataset.day);
    const selected = this.data.auditSelections[`day${dayIndex}`] || [];
    if (!selected.length) {
      toastLater(this, { title: '请先选择要删除的曲目', icon: 'none' });
      return;
    }
    const dayLabel = ['周一', '周二', '周三', '周四', '周五'][dayIndex];
    feedback.showModal(this, {
      title: `标记${dayLabel}所选曲目`,
      content: `只处理${dayLabel}的 ${selected.length} 首曲目，不补位，发布前可撤销。`,
      editable: true,
      placeholderText: '可填写调整原因（选填）',
      confirmText: '标记删除',
      confirmColor: theme.getNativeColors().danger,
      success: async res => {
        if (!res.confirm) return;
        if (!this.checkScheduleSnapshot(saved)) return;
        feedback.showLoading(this, { title: '处理中' });
        try {
          const ret = await cloudCall({
            name: 'adminAuditPlaylist',
            data: {
              action: 'removeItems',
              playlistId: this.data.schedule._id,
              dayIndex,
              songIndexes: selected.map(Number),
              revision: this.data.schedule.revision,
              reason: (res.content || '').trim() || '当天安排调整'
            }
          });
          if (!ret.result.success) throw new Error(ret.result.message || '删除失败');
          this.setData({ [`auditSelections.day${dayIndex}`]: [] });
          await this.refreshAfterWrite();
          toastLater(this, { title: ret.result.message, icon: 'success' });
        } catch (err) {
          if (!this.handleScheduleError(err)) toastLater(this, { title: err.message || '删除失败', icon: 'none' });
        } finally {
          feedback.hideLoading(this);
        }
      }
    });
  },

  onRestoreRemoval(e) {
    if (this.data.scheduleConflict) { this.notifyScheduleConflict(); return; }
    const dayIndex = Number(e.currentTarget.dataset.day);
    const songIndex = Number(e.currentTarget.dataset.songIndex);
    feedback.showLoading(this, { title: '撤销中' });
    return cloudCall({
      name: 'adminAuditPlaylist',
      data: {
        action: 'restoreItems',
        playlistId: this.data.schedule._id,
        dayIndex,
        songIndexes: [songIndex],
        revision: this.data.schedule.revision
      }
    }).then(async ret => {
      if (!ret.result.success) throw new Error(ret.result.message || '撤销失败');
      await this.refreshAfterWrite();
      toastLater(this, { title: ret.result.message, icon: 'success' });
    }).catch(err => {
      if (!this.handleScheduleError(err)) toastLater(this, { title: err.message || '撤销失败', icon: 'none' });
    }).finally(() => feedback.hideLoading(this));
  },

  async confirmException() {
    if (!this.checkScheduleSnapshot(this._exceptionSnapshot)) return;
    const { schedule, modalDay, modalSongIndex, selectedReason, customReason } = this.data;
    const reason = customReason || selectedReason || '管理员移除';

    if (modalSongIndex == null) return;

    feedback.showLoading(this, { title: '处理中' });
    try {
      const res = await cloudCall({
        name: 'adminAuditPlaylist',
        data: {
          action: 'markException',
          playlistId: schedule._id,
          dayIndex: modalDay,
          songIndex: modalSongIndex,
          reason,
          revision: schedule.revision
        }
      });

      if (res.result.success) {
        toastLater(this, { title: res.result.message, icon: 'success' });
        await this.refreshAfterWrite();
        this.closeModal();
      } else {
        if (!this.handleScheduleError(res.result.message)) toastLater(this, { title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      if (!this.handleScheduleError(err)) toastLater(this, { title: '操作失败', icon: 'none' });
    } finally {
      feedback.hideLoading(this);
    }
  },

  onPublish() {
    if (this.data.scheduleConflict) { this.notifyScheduleConflict(); return; }
    const { schedule, note, dayCounts } = this.data;
    if (!schedule || this.data.publishing) return;
    this._publishSnapshot = { id: schedule._id, revision: schedule.revision };
    this.setData({ showPublishDrawer: true, publishNoteValid: !!note.trim(), publishError: '',
      publishDayCount: dayCounts.filter(day => day.active > 0).length });
  },
  closePublishDrawer() { if (!this.data.publishing) this.closeAdminDrawer('showPublishDrawer'); },
  async confirmPublish(e) {
    const { schedule, publishing, activeSongCount } = this.data;
    if (!schedule || publishing || !this.data.showPublishDrawer || !this._publishSnapshot) return;
    const values = e && e.detail && e.detail.value;
    const note = values && typeof values.publishNote === 'string' ? values.publishNote : this.data.note;
    this.setData({ note, publishNoteValid: !!note.trim() });
    if (!activeSongCount && !note.trim()) { this.setData({ publishError: '没有曲目时，请填写本期说明。' }); return; }
    if (note.length > 100) { this.setData({ publishError: '发布说明最多100字。' }); return; }
    if (!this.checkScheduleSnapshot(this._publishSnapshot)) return;
    this.setData({ publishing: true, publishError: '' });
    try {
      const ret = await cloudCall({ name: 'adminAuditPlaylist', data: {
        action: 'publish', playlistId: schedule._id, note, revision: schedule.revision
      } });
      if (ret.result.success) {
        this.setData({ schedule: null, activeSongCount: 0, showPublishDrawer: false });
        toastLater(this, { title: '发布成功', icon: 'success' });
      } else {
        const message = ret.result.message || '发布失败，请重试';
        if (this.handleScheduleError(message)) return;
        this.setData({ publishError: message });
      }
    } catch (err) {
      if (!this.handleScheduleError(err)) this.setData({ publishError: '网络异常，发布未确认，请稍后重试。' });
    } finally { this.setData({ publishing: false }); }
  },

  // ========== 特殊备注弹窗 ==========

  onOpenNote(e) {
    if (this.data.scheduleConflict) { this.notifyScheduleConflict(); return; }
    this._noteSnapshot = conflict.snapshot(this.data.schedule);
    const { day, songIndex, song } = e.currentTarget.dataset;
    this.setData({
      showNoteModal: true,
      noteSong: song,
      noteDay: day,
      noteSongIndex: songIndex,
      noteText: song.special_note || '',
      noteSaving: false
    });
  },

  onNoteTextInput(e) {
    this.setData({ noteText: e.detail.value });
  },

  closeNoteModal() {
    if (this.data.noteSaving) return;
    this.closeAdminDrawer('showNoteModal', () => this.setData({ noteSong: null, noteText: '', noteSaving: false }));
  },

  async saveSpecialNote(noteValue, successMessage) {
    if (!this.checkScheduleSnapshot(this._noteSnapshot)) return;
    if (this.data.noteSaving) return;
    const dayIndex = Number(this.data.noteDay);
    const songIndex = Number(this.data.noteSongIndex);

    this.setData({ noteSaving: true });
    try {
      const res = await cloudCall({
        name: 'adminAuditPlaylist',
        data: {
          action: 'updateNote',
          playlistId: this.data.schedule._id,
          dayIndex,
          songIndex,
          note: noteValue,
          revision: this.data.schedule.revision
        }
      });
      if (res.result.success) {
        // 以服务端实际保存的值为准，整体替换当天数组，避免嵌套数组路径更新失效。
        const resultData = res.result.data || {};
        const savedNote = typeof resultData.special_note === 'string'
          ? resultData.special_note
          : noteValue;
        const dayKey = `day${dayIndex + 1}`;
        const currentDay = Array.isArray(this.data.schedule[dayKey])
          ? this.data.schedule[dayKey]
          : [];
        const updatedDay = currentDay.map((item, index) => index === songIndex
          ? Object.assign({}, item, { special_note: savedNote })
          : item);
        // 服务端保存备注后会 revision+1，但只返回 special_note；这里同步加一，
        // 否则后续「标记删除 / 撤销删除」会因本地版本号落后而必然报“页面数据已过期”。
        const nextRevision = Number.isInteger(resultData.revision) ? resultData.revision : (Number(this.data.schedule.revision) || 1) + 1;
        const updatedSchedule = Object.assign({}, this.data.schedule, { [dayKey]: updatedDay, revision: nextRevision });

        this.setData({
          schedule: updatedSchedule,
          showNoteModal: false,
          noteSong: null,
          noteText: '',
          noteSaving: false
        });
        toastLater(this, { title: successMessage, icon: 'success' });
      } else {
        if (!this.handleScheduleError(res.result.message)) toastLater(this, { title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      if (!this.handleScheduleError(err)) toastLater(this, { title: '保存失败', icon: 'none' });
    } finally {
      if (this.data.noteSaving) this.setData({ noteSaving: false });
    }
  },

  async confirmSaveNote(e) {
    const formValues = e && e.detail && e.detail.value;
    const submittedNote = formValues && typeof formValues.noteText === 'string'
      ? formValues.noteText
      : this.data.noteText;
    await this.saveSpecialNote(submittedNote, '备注已保存');
  },

  deleteNote() {
    if (this.data.noteSaving || !this.data.noteSong || !this.data.noteSong.special_note) return;

    feedback.showModal(this, {
      title: '删除备注',
      content: '确定删除这条特殊备注吗？发布后的列表将不再显示该备注。',
      confirmText: '删除',
      confirmColor: theme.getNativeColors().danger,
      success: async (res) => {
        if (res.confirm) await this.saveSpecialNote('', '备注已删除');
      }
    });
  },

  // ========== 复制相关方法 ==========

  onCopySong(e) {
    const { name = '', singer = '', note = '' } = e.currentTarget.dataset;
    const song = note
      ? `${name} - ${singer}\n备注：${note}`
      : `${name} - ${singer}`;
    wx.setClipboardData({
      data: song,
      success: () => feedback.showClipboardToast(this, { title: '已复制', icon: 'success' }),
      fail: err => {
        console.warn('复制失败:', err);
        toastLater(this, { title: '复制失败', icon: 'none' });
      }
    });
  },

  onCopyCode(e) {
    const code = e.currentTarget.dataset.code;
    if (code && code !== '******') {
      wx.setClipboardData({
        data: code,
        success: () => { feedback.showClipboardToast(this, { title: '已复制', icon: 'success' }); },
        fail: err => {
          console.warn('复制失败:', err);
          toastLater(this, { title: '复制失败', icon: 'none' });
        }
      });
    }
  },

  // 验证码列表：先用本地缓存秒开，再拉云端覆盖；30 秒内重复切换不重复请求。
  async loadCodeList(options = {}) {
    const { silent = false, force = false } = options;
    const cacheKey = storageKey('admin_code_list_v1');
    const now = Date.now();
    if (!force && this._codeListAt && now - this._codeListAt < 30000 && this.data.codeList.length > 0) return;
    if (!this.data.codeList.length) {
      try {
        const cached = wx.getStorageSync(cacheKey);
        const fresh = cached && Number(cached.at) && now - Number(cached.at) < 10 * 60 * 1000;
        if (fresh && Array.isArray(cached.list) && cached.list.length) {
          this.setData({ codeList: cached.list });
        }
      } catch (_) { /* 缓存不可用就当没有 */ }
    }
    try {
      const res = await cloudCall({
        name: 'manageWeeklyCode',
        data: { action: 'list' }
      });
      if (res.result.success) {
        this._codeListAt = now;
        this.setData({ codeList: res.result.data });
        try { wx.setStorageSync(cacheKey, { list: res.result.data, at: now }); } catch (_) { /* 忽略写缓存失败 */ }
      } else if (!silent) {
        toastLater(this, { title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      console.warn('加载验证码列表失败');
      if (!silent && this.data.codeList.length === 0) toastLater(this, { title: '验证码加载失败', icon: 'none' });
    }
  },

  async onGenerateCode() {
    feedback.showModal(this, {
      title: '自动生成',
      content: '将生成3个6位验证码（有效期48h），是否继续？',
      success: async (res) => {
        if (res.confirm) {
          feedback.showLoading(this, { title: '生成中...' });
          try {
            const ret = await cloudCall({
              name: 'autoGenerateWeeklyCode'
            });
            feedback.hideLoading(this);
            if (ret.result.success) {
              toastLater(this, { title: '生成成功', icon: 'success' });
              this.loadCodeList({ force: true });
            } else {
              toastLater(this, { title: ret.result.message, icon: 'none' });
            }
          } catch (err) {
            feedback.hideLoading(this);
            toastLater(this, { title: '生成失败', icon: 'none' });
          }
        }
      }
    });
  },

  onAddCode() {
    this.setData({
      showCodeModal: true,
      newCode: '',
      newExpireDate: '',
      editingCodeId: null
    });
  },

  onEditCode(e) {
    const { id, code } = e.currentTarget.dataset;
    this.setData({
      showCodeModal: true,
      newCode: code,
      newExpireDate: '',
      editingCodeId: id
    });
  },

  onNewCodeInput(e) {
    this.setData({ newCode: e.detail.value });
  },

  onExpireDateChange(e) {
    this.setData({ newExpireDate: e.detail.value });
  },

  closeCodeModal() {
    this.closeAdminDrawer('showCodeModal', () => this.setData({ editingCodeId: null }));
  },

  async confirmSaveCode() {
    const { newCode, newExpireDate, editingCodeId } = this.data;
    if (!newCode || newCode.length < 4) {
      toastLater(this, { title: '验证码至少4位', icon: 'none' });
      return;
    }
    if (!newExpireDate) {
      toastLater(this, { title: '请选择过期日期', icon: 'none' });
      return;
    }

    feedback.showLoading(this, { title: editingCodeId ? '保存中...' : '添加中...' });
    try {
      const ret = await cloudCall({
        name: 'manageWeeklyCode',
        data: {
          action: editingCodeId ? 'update' : 'add',
          codeId: editingCodeId,
          code: newCode,
          expireDate: newExpireDate
        }
      });
      feedback.hideLoading(this);
      if (ret.result.success) {
        toastLater(this, { title: editingCodeId ? '保存成功' : '添加成功', icon: 'success' });
        this.closeCodeModal();
        this.loadCodeList({ force: true });
      } else {
        toastLater(this, { title: ret.result.message, icon: 'none' });
      }
    } catch (err) {
      feedback.hideLoading(this);
      toastLater(this, { title: '操作失败', icon: 'none' });
    }
  },

  onPublishCode(e) {
    const codeId = e.currentTarget.dataset.id;
    feedback.showModal(this, {
      title: '确认发布',
      content: '发布后验证码将对用户可见，且不可修改。是否确认？',
      success: async (res) => {
        if (res.confirm) {
          feedback.showLoading(this, { title: '发布中...' });
          try {
            const ret = await cloudCall({
              name: 'manageWeeklyCode',
              data: { action: 'publish', codeId }
            });
            feedback.hideLoading(this);
            if (ret.result.success) {
              toastLater(this, { title: '发布成功', icon: 'success' });
              this.loadCodeList({ force: true });
            } else {
              toastLater(this, { title: ret.result.message, icon: 'none' });
            }
          } catch (err) {
            feedback.hideLoading(this);
            toastLater(this, { title: '发布失败', icon: 'none' });
          }
        }
      }
    });
  },

  onDeleteCode(e) {
    const codeId = e.currentTarget.dataset.id;
    feedback.showModal(this, {
      title: '确认删除',
      content: '确定删除该验证码吗？',
      success: async (res) => {
        if (res.confirm) {
          feedback.showLoading(this, { title: '删除中...' });
          try {
            const ret = await cloudCall({
              name: 'manageWeeklyCode',
              data: { action: 'delete', codeId }
            });
            feedback.hideLoading(this);
            if (ret.result.success) {
              toastLater(this, { title: '删除成功', icon: 'success' });
              this.loadCodeList({ force: true });
            } else {
              toastLater(this, { title: ret.result.message, icon: 'none' });
            }
          } catch (err) {
            feedback.hideLoading(this);
            toastLater(this, { title: '删除失败', icon: 'none' });
          }
        }
      }
    });
  },

  // ========== 测试工具相关方法 ==========

  async loadTestStats() {
    try {
      const res = await cloudCall({
        name: 'testTool',
        data: { action: 'stats' }
      });
      if (res.result.success) {
        this.setData({ testStats: res.result.data });
      }
    } catch (err) {
      console.warn('加载统计失败');
    }
  },

  // WXML 按钮绑定的事件处理方法（调用 loadTestStats）
  onTestStats() {
    this.loadTestStats();
  },

  goConsoleDetail(e) {
    if (!this.data.isSuperAdmin) {
      toastLater(this, { title: '仅超级管理员可查看', icon: 'none' });
      return;
    }
    const mode = e.currentTarget.dataset.mode;
    if (!['submissions', 'schedules', 'events', 'counters'].includes(mode)) return;
    wx.navigateTo({ url: `/pages/admin/console?mode=${mode}` });
  },

  // 加载通道状态（通过云函数读取，避免前端权限问题）
  async loadChannelStatus() {
    this.setData({ channelLoading: true });
    try {
      const ret = await cloudCall({
        name: 'testTool',
        data: { action: 'getChannelStatus' }
      });
      if (!ret.result || ret.result.success === false) throw new Error('读取失败');
      let mode = 'normal';
      if (ret.result.forceClose) mode = 'close';
      else if (ret.result.forceOpen) mode = 'open';
      this.setData({ channelMode: mode });
    } catch (e) {
      this.setData({ channelMode: '' });
    } finally {
      this.setData({ channelLoading: false });
    }
  },

  // 切换通道开关（三态：open / close / reset）
  async onToggleChannel(e) {
    const mode = e.currentTarget.dataset.mode;
    if (!['open', 'close', 'reset'].includes(mode) || !this.data.isTestEnv || this.data.channelBusy || this.data.channelLoading || !this.data.channelMode) return;
    if ((mode === 'reset' ? 'normal' : mode) === this.data.channelMode) return;
    this.setData({ channelBusy: true });
    try {
      const names = { open: '强制开放', close: '强制关闭', reset: '正常时间' };
      const confirmed = await feedback.showModal(this, {
        title: `切换为${names[mode]}？`,
        content: mode === 'open' ? '立即开放点歌，暂时忽略正常开放时段。' : mode === 'close' ? '立即暂停接收点歌，已有投稿不受影响。' : '恢复每周日 8:00–20:00 自动开放。',
        confirmText: '确认切换',
        confirmColor: mode === 'close' ? theme.getNativeColors().danger : theme.getNativeColors().accent
      });
      if (!confirmed.confirm) return;
      const ret = await cloudCall({
        name: 'testTool',
        data: { action: 'toggleChannel', mode }
      });
      if (ret.result.success) {
        toastLater(this, { title: ret.result.message, icon: 'success' });
        await this.loadChannelStatus();
      } else {
        toastLater(this, { title: ret.result.message || '操作失败', icon: 'none' });
      }
    } catch (err) {
      toastLater(this, { title: '调用失败：' + (err.message || '网络错误'), icon: 'none' });
    } finally {
      this.setData({ channelBusy: false });
    }
  },

  async onTestGenerate(e) {
    const count = parseInt(e.currentTarget.dataset.count);
    feedback.showModal(this, {
      title: '确认生成',
      content: `将生成 ${count} 条提交请求（清空本周已有数据），是否继续？`,
      success: async (res) => {
        if (res.confirm) {
          feedback.showLoading(this, { title: '生成中...' });
          try {
            const ret = await cloudCall({
              name: 'testTool',
              data: { action: 'generateRequests', count }
            });
            feedback.hideLoading(this);
            if (ret.result.success) {
              toastLater(this, { title: ret.result.message, icon: 'success' });
              this.loadTestStats();
            } else {
              toastLater(this, { title: ret.result.message, icon: 'none' });
            }
          } catch (err) {
            feedback.hideLoading(this);
            toastLater(this, { title: '生成失败', icon: 'none' });
          }
        }
      }
    });
  },

  async onTestGenCodes() {
    feedback.showModal(this, {
      title: '生成验证码',
      content: '将生成3个测试验证码（TEST01/02/03），是否继续？',
      success: async (res) => {
        if (res.confirm) {
          feedback.showLoading(this, { title: '生成中...' });
          try {
            const ret = await cloudCall({
              name: 'testTool',
              data: { action: 'generateCodes' }
            });
            feedback.hideLoading(this);
            if (ret.result.success) {
              toastLater(this, { title: ret.result.message, icon: 'success' });
              this.loadTestStats();
            } else {
              toastLater(this, { title: ret.result.message, icon: 'none' });
            }
          } catch (err) {
            feedback.hideLoading(this);
            toastLater(this, { title: '生成失败', icon: 'none' });
          }
        }
      }
    });
  },

  async onTestGenPublished() {
    feedback.showActionSheet(this, {
      itemList: ['本期排期', '上一期排期', '上上期排期', '全部3期排期'],
      success: async (res) => {
        const offsetMap = [0, 1, 2];
        let action, offset;
        if (res.tapIndex === 3) {
          action = 'generateAllPublished';
        } else {
          action = 'generatePublished';
          offset = offsetMap[res.tapIndex];
        }
        feedback.showLoading(this, { title: '生成中...' });
        try {
          const ret = await cloudCall({
            name: 'testTool',
            data: { action, offset }
          });
          feedback.hideLoading(this);
          if (ret.result.success) {
            toastLater(this, { title: ret.result.message, icon: 'success' });
            this.loadTestStats();
          } else {
            toastLater(this, { title: ret.result.message, icon: 'none' });
          }
        } catch (err) {
          feedback.hideLoading(this);
          toastLater(this, { title: '生成失败', icon: 'none' });
        }
      }
    });
  },

  async onTestDraw() {
    feedback.showModal(this, {
      title: '一键抽取',
      content: '将执行本周抽取任务，是否继续？',
      success: async (res) => {
        if (res.confirm) {
          feedback.showLoading(this, { title: '抽取中...' });
          try {
            const ret = await cloudCall({
              name: 'testTool',
              data: { action: 'runDraw' }
            });
            feedback.hideLoading(this);
            if (ret.result.success) {
              toastLater(this, { title: ret.result.message || '抽取完成', icon: 'success' });
              this.loadTestStats();
            } else {
              toastLater(this, { title: ret.result.message, icon: 'none' });
            }
          } catch (err) {
            feedback.hideLoading(this);
            toastLater(this, { title: '抽取失败', icon: 'none' });
          }
        }
      }
    });
  },

  async onTestSimulateSubmitted() {
    feedback.showLoading(this, { title: '处理中...' });
    try {
      const ret = await cloudCall({
        name: 'testTool',
        data: { action: 'simulateSubmitted' }
      });
      feedback.hideLoading(this);
      if (ret.result.success) {
        toastLater(this, { title: ret.result.message, icon: 'success' });
        this.loadTestStats();
      } else {
        toastLater(this, { title: ret.result.message, icon: 'none' });
      }
    } catch (err) {
      feedback.hideLoading(this);
      toastLater(this, { title: '操作失败', icon: 'none' });
    }
  },

  async requestCleanupConfirmation(scope) {
    feedback.showLoading(this, { title: '统计影响范围...' });
    let previewResult;
    try {
      const ret = await cloudCall({
        name: 'testTool',
        data: { action: 'previewCleanup', scope }
      });
      previewResult = ret.result;
    } catch (err) {
      feedback.hideLoading(this);
      toastLater(this, { title: '无法获取清理预览', icon: 'none' });
      return;
    }
    feedback.hideLoading(this);

    if (!previewResult || !previewResult.success) {
      feedback.showModal(this, {
        title: previewResult && previewResult.blocked ? '生产保护已开启' : '无法继续',
        content: (previewResult && previewResult.message) || '无法获取清理预览',
        showCancel: false
      });
      return;
    }

    const preview = previewResult.preview || {};
    const isWeek = scope === 'week';
    const isAll = scope === 'all';
    const detail = isWeek
      ? `提交 ${preview.submissions || 0}、排期 ${preview.schedules || 0}、验证码 ${preview.weekly_codes || 0}、异常 ${preview.schedule_exceptions || 0}、计数器 ${preview.submission_counters || 0}、订阅 ${preview.message_subscriptions || 0}`
      : (isAll
        ? `12 个 test_ 集合中的测试记录（当前测试超管身份会保留）`
        : `订阅记录 ${preview.message_subscriptions || 0}`);
    const confirmationText = previewResult.confirmationText;

    feedback.showModal(this, {
      title: isWeek ? '确认清空本周数据' : (isAll ? '确认清空全部测试数据' : '确认清空订阅记录'),
      content: `即将删除：${detail}，共 ${preview.total || 0} 条。\n请输入“${confirmationText}”确认，令牌两分钟内有效。`,
      editable: true,
      placeholderText: `输入“${confirmationText}”`,
      success: async (res) => {
        if (!res.confirm) return;
        if (res.content !== confirmationText) {
          toastLater(this, { title: '输入不匹配，已取消', icon: 'none' });
          return;
        }

        feedback.showLoading(this, { title: '清空中...' });
        try {
          const ret = await cloudCall({
            name: 'testTool',
            data: {
              action: isWeek ? 'clearWeek' : (isAll ? 'clearAll' : 'clearSubscriptions'),
              confirmationToken: previewResult.confirmationToken,
              confirmationText
            }
          });
          feedback.hideLoading(this);
          if (ret.result.success) {
            toastLater(this, { title: '清理完成', icon: 'success' });
            this.setData({ testStats: null });
            this.loadTestStats();
          } else {
            feedback.showModal(this, {
              title: '未执行清理',
              content: ret.result.message || '服务端拒绝了本次操作',
              showCancel: false
            });
          }
        } catch (err) {
          feedback.hideLoading(this);
          toastLater(this, { title: '清空失败', icon: 'none' });
        }
      }
    });
  },

  onTestClearWeek() {
    this.requestCleanupConfirmation('week');
  },

  onTestClearSubscriptions() {
    this.requestCleanupConfirmation('subscriptions');
  },

  onTestClearAll() {
    this.requestCleanupConfirmation('all');
  },

  // ========== 管理员管理相关方法 ==========

  async loadPasscodeList() {
    try {
      const res = await cloudCall({
        name: 'manageAdmins',
        data: { action: 'listPasscodes' }
      });
      if (res.result.success) {
        const list = res.result.data.map(pc => Object.assign({}, pc, {
          created_at: pc.created_at ? new Date(pc.created_at).toLocaleDateString() : '-'
        }));
        this.setData({ passcodeList: list });
      }
    } catch (err) {
      console.warn('加载通行码列表失败');
    }
  },

  async loadAdminList() {
    try {
      const res = await cloudCall({
        name: 'manageAdmins',
        data: { action: 'listAdmins' }
      });
      if (res.result.success) {
        const list = res.result.data.map(u => Object.assign({}, u, {
          admin_label: u.admin_label || (u.role === 'superadmin' ? '系统预设账号' : '未设置来源标签'),
          last_verify_date: u.last_admin_verify ? `最近验证：${new Date(u.last_admin_verify).toLocaleDateString()}` : '暂无验证记录'
        }));
        this.setData({ adminList: list });
      }
    } catch (err) {
      console.warn('加载管理员列表失败');
    }
  },

  onAddPasscode() {
    this.setData({
      showPasscodeModal: true,
      newPasscodeLabel: ''
    });
  },

  closePasscodeModal() {
    this.closeAdminDrawer('showPasscodeModal');
  },

  onPasscodeLabelInput(e) {
    this.setData({ newPasscodeLabel: e.detail.value });
  },

  async confirmAddPasscode() {
    const { newPasscodeLabel } = this.data;
    if (!newPasscodeLabel || !newPasscodeLabel.trim()) {
      toastLater(this, { title: '请输入描述标签', icon: 'none' });
      return;
    }

    feedback.showLoading(this, { title: '生成中...' });
    try {
      const ret = await cloudCall({
        name: 'manageAdmins',
        data: { action: 'addPasscode', label: newPasscodeLabel.trim() }
      });
      feedback.hideLoading(this);

      if (ret.result.success) {
        this.setData({
          showPasscodeModal: false,
          showPasscodeResultModal: true,
          generatedPasscode: ret.result.code
        });
        this.loadPasscodeList();
      } else {
        toastLater(this, { title: ret.result.message, icon: 'none' });
      }
    } catch (err) {
      feedback.hideLoading(this);
      toastLater(this, { title: '生成失败', icon: 'none' });
    }
  },

  closePasscodeResultModal() {
    this.closeAdminDrawer('showPasscodeResultModal', () => this.setData({ generatedPasscode: '' }));
  },

  onCopyPasscode() {
    const code = this.data.generatedPasscode;
    if (code) {
      wx.setClipboardData({
        data: code,
        success: () => { feedback.showClipboardToast(this, { title: '已复制', icon: 'success' }); },
        fail: err => {
          console.warn('复制失败:', err);
          toastLater(this, { title: '复制失败', icon: 'none' });
        }
      });
    }
  },

  onDeletePasscode(e) {
    const { id, label } = e.currentTarget.dataset;
    feedback.showModal(this, {
      title: '确认删除',
      content: `确定删除通行码「${label}」吗？删除后该码立即失效。`,
      success: async (res) => {
        if (res.confirm) {
          feedback.showLoading(this, { title: '删除中...' });
          try {
            const ret = await cloudCall({
              name: 'manageAdmins',
              data: { action: 'deletePasscode', passcodeId: id }
            });
            feedback.hideLoading(this);
            if (ret.result.success) {
              toastLater(this, { title: '已删除', icon: 'success' });
              this.loadPasscodeList();
            } else {
              toastLater(this, { title: ret.result.message, icon: 'none' });
            }
          } catch (err) {
            feedback.hideLoading(this);
            toastLater(this, { title: '删除失败', icon: 'none' });
          }
        }
      }
    });
  },

  onRevokeAdmin(e) {
    const openid = e.currentTarget.dataset.openid;
    const preview = openid.length > 8 ? openid.substring(0, 4) + '...' + openid.substring(openid.length - 4) : openid;
    feedback.showModal(this, {
      title: '确认撤销',
      content: `确定撤销管理员 ${preview} 的身份吗？该用户将失去管理权限。`,
      confirmColor: theme.getNativeColors().danger,
      success: async (res) => {
        if (res.confirm) {
          feedback.showLoading(this, { title: '处理中...' });
          try {
            const ret = await cloudCall({
              name: 'manageAdmins',
              data: { action: 'revokeAdmin', targetOpenid: openid }
            });
            feedback.hideLoading(this);
            if (ret.result.success) {
              toastLater(this, { title: '已撤销', icon: 'success' });
              this.loadAdminList();
            } else {
              toastLater(this, { title: ret.result.message, icon: 'none' });
            }
          } catch (err) {
            feedback.hideLoading(this);
            toastLater(this, { title: '撤销失败', icon: 'none' });
          }
        }
      }
    });
  },

  // ========== 使用说明管理 ==========

  async loadHelpArticles(showLoading = true) {
    if (!this.data.isSuperAdmin) return;
    if (showLoading) this.setData({ helpLoading: true });
    try {
      const res = await cloudCall({
        name: 'manageHelpContent',
        data: { action: 'listAll' }
      });
      if (res.result && res.result.success) {
        this.setData({ helpArticleList: res.result.data || [] });
      } else {
        toastLater(this, { title: (res.result && res.result.message) || '加载失败', icon: 'none' });
      }
    } catch (err) {
      toastLater(this, { title: '说明列表加载失败', icon: 'none' });
    } finally {
      this.setData({ helpLoading: false });
    }
  },

  onAddHelpArticle() {
    wx.navigateTo({ url: '/pages/admin/help-editor' });
  },

  onInitializeHelpArticles() {
    feedback.showModal(this, {
      title: '生成默认说明',
      content: '将生成一套可继续编辑的基础使用说明，是否继续？',
      confirmText: '生成',
      success: async modalRes => {
        if (!modalRes.confirm) return;
        feedback.showLoading(this, { title: '生成中...' });
        try {
          const res = await cloudCall({
            name: 'manageHelpContent',
            data: { action: 'initializeDefaults' }
          });
          if (res.result && res.result.success) {
            toastLater(this, { title: '已生成', icon: 'success' });
            this.loadHelpArticles(false);
          } else {
            toastLater(this, { title: (res.result && res.result.message) || '生成失败', icon: 'none' });
          }
        } catch (err) {
          toastLater(this, { title: '生成失败', icon: 'none' });
        } finally {
          feedback.hideLoading(this);
        }
      }
    });
  },

  onEditHelpArticle(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/admin/help-editor?id=${encodeURIComponent(id)}` });
  },

  async onMoveHelpArticle(e) {
    const { id, direction } = e.currentTarget.dataset;
    try {
      const res = await cloudCall({
        name: 'manageHelpContent',
        data: { action: 'reorder', articleId: id, direction }
      });
      if (res.result && res.result.success) {
        this.loadHelpArticles(false);
      } else {
        toastLater(this, { title: (res.result && res.result.message) || '排序失败', icon: 'none' });
      }
    } catch (err) {
      toastLater(this, { title: '排序失败', icon: 'none' });
    }
  },

  onToggleHelpArticle(e) {
    const { id, published } = e.currentTarget.dataset;
    const isPublished = published === true || published === 'true';
    const nextPublished = !isPublished;
    feedback.showModal(this, {
      title: nextPublished ? '发布说明' : '隐藏说明',
      content: nextPublished ? '发布后用户将立即看到这条说明。' : '隐藏后用户将暂时看不到这条说明。',
      confirmText: nextPublished ? '发布' : '隐藏',
      success: async modalRes => {
        if (!modalRes.confirm) return;
        try {
          const res = await cloudCall({
            name: 'manageHelpContent',
            data: { action: 'setPublished', articleId: id, isPublished: nextPublished }
          });
          if (res.result && res.result.success) {
            toastLater(this, { title: nextPublished ? '已发布' : '已隐藏', icon: 'success' });
            this.loadHelpArticles(false);
          } else {
            toastLater(this, { title: (res.result && res.result.message) || '操作失败', icon: 'none' });
          }
        } catch (err) {
          toastLater(this, { title: '操作失败', icon: 'none' });
        }
      }
    });
  },

  onDeleteHelpArticle(e) {
    const { id, title } = e.currentTarget.dataset;
    feedback.showModal(this, {
      title: '删除说明',
      content: `确定删除「${title}」吗？相关图片也会一并删除。`,
      confirmText: '删除',
      confirmColor: theme.getNativeColors().danger,
      success: async modalRes => {
        if (!modalRes.confirm) return;
        try {
          const res = await cloudCall({
            name: 'manageHelpContent',
            data: { action: 'delete', articleId: id }
          });
          if (res.result && res.result.success) {
            toastLater(this, { title: '已删除', icon: 'success' });
            this.loadHelpArticles(false);
          } else {
            toastLater(this, { title: (res.result && res.result.message) || '删除失败', icon: 'none' });
          }
        } catch (err) {
          toastLater(this, { title: '删除失败', icon: 'none' });
        }
      }
    });
  }
})));
