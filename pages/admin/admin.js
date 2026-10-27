const theme = require('../../utils/theme');
// pages/admin/admin.js
const { cloudCall, collectionName, isTestMode, storageKey } = require('../../utils/runtime');

// 订阅消息模板 ID（管理员：参与活动提醒）
const ADMIN_TPL_ID = 'G9y63KY2Q0mPOS-ML_PtxVu9wqE5xKqVnnNgEFtPC_8';

// showToast 与 showLoading 共用同一层：在 finally 里关掉 loading 会把刚弹出的提示一起抹掉。
// 统一延后一帧再弹，保证提示一定看得见；用户无感知（0ms）。
function toastLater(options) {
  setTimeout(() => {
    try { wx.showToast(options); } catch (_) { /* 页面已卸载时忽略 */ }
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

Page(theme.page({
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
    await this.loadPlaylist(false);
    if (this.data.currentTab === 'codes') await this.loadCodeList({ force: true });
    if (this.data.currentTab === 'admins') await Promise.all([this.loadPasscodeList(), this.loadAdminList()]);
    wx.stopPullDownRefresh();
  },

  onShow() {
    if (this.data.currentTab === 'help' && this.data.isSuperAdmin) {
      this.loadHelpArticles(false);
    }
  },

  goEasterEggs() {
    if (this.data.isSuperAdmin) wx.navigateTo({ url: '/pages/admin/easter-eggs' });
  },

  async checkPermissionFromCloud() {
    wx.showLoading({ title: '验证身份...' });
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
      toastLater({ title: '网络异常', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
    } finally {
      wx.hideLoading();
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
    toastLater({ title: '无权限访问', icon: 'none' });
    setTimeout(() => wx.navigateBack(), 1500);
  },

  // 管理员身份绑定微信账号，返回首页不会清除云端角色
  onBackHome() {
    wx.navigateBack();
  },

  // 切换选项卡
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.currentTab) return;
    this.setData({ currentTab: tab });
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

  // 按钮点击：开启通知（首次订阅，会弹窗）
  async onEnableNotification() {
    if (this.data.isTestMode) {
      this.setData({ subscribed: true });
      toastLater({ title: '测试环境已模拟订阅', icon: 'none' });
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
        toastLater({ title: '已开启通知', icon: 'success' });
      }
    } catch (err) {
      console.warn('订阅失败:', err);
    }
  },

  // ========== 审核相关方法 ==========

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
    if (showLoading) wx.showLoading({ title: '加载中' });
    try {
      const res = await cloudCall({
        name: 'adminAuditPlaylist',
        data: { action: 'getPending' }
      });
      if (res.result.success) {
        const schedule = res.result.data;
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
          pendingRemovalCount,
          dayCounts,
          // 显示周次并标出是否本周，避免把遗留的旧排期当成本周列表误发。
          scheduleWeekKey: schedule.week_key || '',
          scheduleIsCurrentWeek: (schedule.week_key || '') === currentWeekKey(),
          thisWeekKey: currentWeekKey(),
          auditSelections: { day0: [], day1: [], day2: [], day3: [], day4: [] }
        });
      } else {
        toastLater({ title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      console.warn('加载排期失败');
    } finally {
      if (showLoading) wx.hideLoading();
    }
  },

  onException(e) {
    this.setData({
      showModal: true,
      modalSong: e.currentTarget.dataset.song,
      modalDay: e.currentTarget.dataset.day,
      modalSongIndex: e.currentTarget.dataset.songIndex,
      selectedReason: '',
      customReason: ''
    });
  },

  closeModal() { this.setData({ showModal: false }); },
  selectReason(e) { this.setData({ selectedReason: e.currentTarget.dataset.reason }); },
  onReasonInput(e) { this.setData({ customReason: e.detail.value }); },
  onNoteInput(e) { this.setData({ note: e.detail.value }); },

  onSkipDay(e) {
    const dayIndex = e.currentTarget.dataset.day;
    const dayLabel = ['周一', '周二', '周三', '周四', '周五'][dayIndex];
    wx.showModal({
      title: '确认跳过',
      content: `确定跳过「${dayLabel}」吗？该日将不安排任何项目。`,
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '处理中' });
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
              toastLater({ title: ret.result.message, icon: 'success' });
              await this.refreshAfterWrite();
            } else {
              toastLater({ title: ret.result.message, icon: 'none' });
            }
          } catch (err) {
            toastLater({ title: '操作失败', icon: 'none' });
          } finally {
            wx.hideLoading();
          }
        }
      }
    });
  },

  onAuditSelectionChange(e) {
    const dayIndex = Number(e.currentTarget.dataset.day);
    this.setData({ [`auditSelections.day${dayIndex}`]: e.detail.value || [] });
  },

  onRemoveSelectedFromDay(e) {
    const dayIndex = Number(e.currentTarget.dataset.day);
    const selected = this.data.auditSelections[`day${dayIndex}`] || [];
    if (!selected.length) {
      toastLater({ title: '请先选择要删除的曲目', icon: 'none' });
      return;
    }
    const dayLabel = ['周一', '周二', '周三', '周四', '周五'][dayIndex];
    wx.showModal({
      title: `标记${dayLabel}所选曲目`,
      content: ``,
      editable: true,
      placeholderText: '可填写调整原因（选填）',
      confirmText: '标记删除',
      confirmColor: theme.getNativeColors().danger,
      success: async res => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中' });
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
          toastLater({ title: ret.result.message, icon: 'success' });
        } catch (err) {
          toastLater({ title: err.message || '删除失败', icon: 'none' });
        } finally {
          wx.hideLoading();
        }
      }
    });
  },

  onRestoreRemoval(e) {
    const dayIndex = Number(e.currentTarget.dataset.day);
    const songIndex = Number(e.currentTarget.dataset.songIndex);
    wx.showLoading({ title: '撤销中' });
    cloudCall({
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
      toastLater({ title: ret.result.message, icon: 'success' });
    }).catch(err => {
      toastLater({ title: err.message || '撤销失败', icon: 'none' });
    }).finally(() => wx.hideLoading());
  },

  async confirmException() {
    const { schedule, modalDay, modalSongIndex, selectedReason, customReason } = this.data;
    const reason = customReason || selectedReason || '管理员移除';

    if (modalSongIndex == null) return;

    wx.showLoading({ title: '处理中' });
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
        toastLater({ title: res.result.message, icon: 'success' });
        await this.refreshAfterWrite();
        this.closeModal();
      } else {
        toastLater({ title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      toastLater({ title: '操作失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  async onPublish() {
    const { schedule, note, pendingRemovalCount } = this.data;
    if (!schedule) return;

    wx.showModal({
      title: '确认发布',
      content: pendingRemovalCount > 0
        ? `发布后列表将对用户可见，并最终移除 ${pendingRemovalCount} 首待删除曲目。是否确认？`
        : '发布后列表将对用户可见，且不可修改。是否确认？',
      success: async (res) => {
        if (res.confirm) {
          this.setData({ publishing: true });
          try {
            const ret = await cloudCall({
              name: 'adminAuditPlaylist',
              data: {
                action: 'publish',
                playlistId: schedule._id,
                note,
                revision: schedule.revision
              }
            });
            if (ret.result.success) {
              toastLater({ title: '发布成功', icon: 'success' });
              this.setData({ schedule: null });
            } else {
              const message = ret.result.message || '';
              toastLater({ title: message, icon: 'none' });
              // 版本号过期时自动拉一次最新排期，省得管理员退出重进页面。
              if (/过期/.test(message)) await this.loadPlaylist(false);
            }
          } catch (err) {
            toastLater({ title: '发布失败', icon: 'none' });
          } finally {
            this.setData({ publishing: false });
          }
        }
      }
    });
  },

  // ========== 特殊备注弹窗 ==========

  onOpenNote(e) {
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
    this.setData({ showNoteModal: false, noteSong: null, noteText: '', noteSaving: false });
  },

  async saveSpecialNote(noteValue, successMessage) {
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
        const nextRevision = (Number(this.data.schedule.revision) || 1) + 1;
        const updatedSchedule = Object.assign({}, this.data.schedule, { [dayKey]: updatedDay, revision: nextRevision });

        this.setData({
          schedule: updatedSchedule,
          showNoteModal: false,
          noteSong: null,
          noteText: '',
          noteSaving: false
        });
        toastLater({ title: successMessage, icon: 'success' });
      } else {
        toastLater({ title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      toastLater({ title: '保存失败', icon: 'none' });
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

    wx.showModal({
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
      success: () => toastLater({ title: '已复制', icon: 'success' }),
      fail(err) {
        console.warn('复制失败:', err);
        toastLater({ title: '复制失败', icon: 'none' });
      }
    });
  },

  onCopyCode(e) {
    const code = e.currentTarget.dataset.code;
    if (code && code !== '******') {
      wx.setClipboardData({
        data: code,
        success() { toastLater({ title: '已复制', icon: 'success' }); },
        fail(err) {
          console.warn('复制失败:', err);
          toastLater({ title: '复制失败', icon: 'none' });
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
        toastLater({ title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      console.warn('加载验证码列表失败');
      if (!silent && this.data.codeList.length === 0) toastLater({ title: '验证码加载失败', icon: 'none' });
    }
  },

  async onGenerateCode() {
    wx.showModal({
      title: '自动生成',
      content: '将生成3个6位验证码（有效期48h），是否继续？',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '生成中...' });
          try {
            const ret = await cloudCall({
              name: 'autoGenerateWeeklyCode'
            });
            wx.hideLoading();
            if (ret.result.success) {
              toastLater({ title: '生成成功', icon: 'success' });
              this.loadCodeList({ force: true });
            } else {
              toastLater({ title: ret.result.message, icon: 'none' });
            }
          } catch (err) {
            wx.hideLoading();
            toastLater({ title: '生成失败', icon: 'none' });
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
    this.setData({ showCodeModal: false, editingCodeId: null });
  },

  async confirmSaveCode() {
    const { newCode, newExpireDate, editingCodeId } = this.data;
    if (!newCode || newCode.length < 4) {
      toastLater({ title: '验证码至少4位', icon: 'none' });
      return;
    }
    if (!newExpireDate) {
      toastLater({ title: '请选择过期日期', icon: 'none' });
      return;
    }

    wx.showLoading({ title: editingCodeId ? '保存中...' : '添加中...' });
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
      wx.hideLoading();
      if (ret.result.success) {
        toastLater({ title: editingCodeId ? '保存成功' : '添加成功', icon: 'success' });
        this.closeCodeModal();
        this.loadCodeList({ force: true });
      } else {
        toastLater({ title: ret.result.message, icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      toastLater({ title: '操作失败', icon: 'none' });
    }
  },

  onPublishCode(e) {
    const codeId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '确认发布',
      content: '发布后验证码将对用户可见，且不可修改。是否确认？',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '发布中...' });
          try {
            const ret = await cloudCall({
              name: 'manageWeeklyCode',
              data: { action: 'publish', codeId }
            });
            wx.hideLoading();
            if (ret.result.success) {
              toastLater({ title: '发布成功', icon: 'success' });
              this.loadCodeList({ force: true });
            } else {
              toastLater({ title: ret.result.message, icon: 'none' });
            }
          } catch (err) {
            wx.hideLoading();
            toastLater({ title: '发布失败', icon: 'none' });
          }
        }
      }
    });
  },

  onDeleteCode(e) {
    const codeId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '确认删除',
      content: '确定删除该验证码吗？',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '删除中...' });
          try {
            const ret = await cloudCall({
              name: 'manageWeeklyCode',
              data: { action: 'delete', codeId }
            });
            wx.hideLoading();
            if (ret.result.success) {
              toastLater({ title: '删除成功', icon: 'success' });
              this.loadCodeList({ force: true });
            } else {
              toastLater({ title: ret.result.message, icon: 'none' });
            }
          } catch (err) {
            wx.hideLoading();
            toastLater({ title: '删除失败', icon: 'none' });
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
      toastLater({ title: '仅超级管理员可查看', icon: 'none' });
      return;
    }
    const mode = e.currentTarget.dataset.mode;
    if (!['submissions', 'schedules', 'events', 'counters'].includes(mode)) return;
    wx.navigateTo({ url: `/pages/admin/console?mode=${mode}` });
  },

  // 加载通道状态（通过云函数读取，避免前端权限问题）
  async loadChannelStatus() {
    try {
      const ret = await cloudCall({
        name: 'testTool',
        data: { action: 'getChannelStatus' }
      });
      let mode = 'normal';
      if (ret.result.forceClose) mode = 'close';
      else if (ret.result.forceOpen) mode = 'open';
      this.setData({ channelMode: mode });
    } catch (e) {
      this.setData({ channelMode: 'normal' });
    }
  },

  // 切换通道开关（三态：open / close / reset）
  async onToggleChannel(e) {
    const mode = e.currentTarget.dataset.mode;
    try {
      const ret = await cloudCall({
        name: 'testTool',
        data: { action: 'toggleChannel', mode }
      });
      if (ret.result.success) {
        toastLater({ title: ret.result.message, icon: 'success' });
        this.loadChannelStatus();
      } else {
        toastLater({ title: ret.result.message || '操作失败', icon: 'none' });
      }
    } catch (err) {
      toastLater({ title: '调用失败：' + (err.message || '网络错误'), icon: 'none' });
    }
  },

  async onTestGenerate(e) {
    const count = parseInt(e.currentTarget.dataset.count);
    wx.showModal({
      title: '确认生成',
      content: `将生成 ${count} 条提交请求（清空本周已有数据），是否继续？`,
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '生成中...' });
          try {
            const ret = await cloudCall({
              name: 'testTool',
              data: { action: 'generateRequests', count }
            });
            wx.hideLoading();
            if (ret.result.success) {
              toastLater({ title: ret.result.message, icon: 'success' });
              this.loadTestStats();
            } else {
              toastLater({ title: ret.result.message, icon: 'none' });
            }
          } catch (err) {
            wx.hideLoading();
            toastLater({ title: '生成失败', icon: 'none' });
          }
        }
      }
    });
  },

  async onTestGenCodes() {
    wx.showModal({
      title: '生成验证码',
      content: '将生成3个测试验证码（TEST01/02/03），是否继续？',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '生成中...' });
          try {
            const ret = await cloudCall({
              name: 'testTool',
              data: { action: 'generateCodes' }
            });
            wx.hideLoading();
            if (ret.result.success) {
              toastLater({ title: ret.result.message, icon: 'success' });
              this.loadTestStats();
            } else {
              toastLater({ title: ret.result.message, icon: 'none' });
            }
          } catch (err) {
            wx.hideLoading();
            toastLater({ title: '生成失败', icon: 'none' });
          }
        }
      }
    });
  },

  async onTestGenPublished() {
    wx.showActionSheet({
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
        wx.showLoading({ title: '生成中...' });
        try {
          const ret = await cloudCall({
            name: 'testTool',
            data: { action, offset }
          });
          wx.hideLoading();
          if (ret.result.success) {
            toastLater({ title: ret.result.message, icon: 'success' });
            this.loadTestStats();
          } else {
            toastLater({ title: ret.result.message, icon: 'none' });
          }
        } catch (err) {
          wx.hideLoading();
          toastLater({ title: '生成失败', icon: 'none' });
        }
      }
    });
  },

  async onTestDraw() {
    wx.showModal({
      title: '一键抽取',
      content: '将执行本周抽取任务，是否继续？',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '抽取中...' });
          try {
            const ret = await cloudCall({
              name: 'testTool',
              data: { action: 'runDraw' }
            });
            wx.hideLoading();
            if (ret.result.success) {
              toastLater({ title: ret.result.message || '抽取完成', icon: 'success' });
              this.loadTestStats();
            } else {
              toastLater({ title: ret.result.message, icon: 'none' });
            }
          } catch (err) {
            wx.hideLoading();
            toastLater({ title: '抽取失败', icon: 'none' });
          }
        }
      }
    });
  },

  async onTestSimulateSubmitted() {
    wx.showLoading({ title: '处理中...' });
    try {
      const ret = await cloudCall({
        name: 'testTool',
        data: { action: 'simulateSubmitted' }
      });
      wx.hideLoading();
      if (ret.result.success) {
        toastLater({ title: ret.result.message, icon: 'success' });
        this.loadTestStats();
      } else {
        toastLater({ title: ret.result.message, icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      toastLater({ title: '操作失败', icon: 'none' });
    }
  },

  async requestCleanupConfirmation(scope) {
    wx.showLoading({ title: '统计影响范围...' });
    let previewResult;
    try {
      const ret = await cloudCall({
        name: 'testTool',
        data: { action: 'previewCleanup', scope }
      });
      previewResult = ret.result;
    } catch (err) {
      wx.hideLoading();
      toastLater({ title: '无法获取清理预览', icon: 'none' });
      return;
    }
    wx.hideLoading();

    if (!previewResult || !previewResult.success) {
      wx.showModal({
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

    wx.showModal({
      title: isWeek ? '确认清空本周数据' : (isAll ? '确认清空全部测试数据' : '确认清空订阅记录'),
      content: `即将删除：${detail}，共 ${preview.total || 0} 条。\n请输入“${confirmationText}”确认，令牌两分钟内有效。`,
      editable: true,
      placeholderText: `输入“${confirmationText}”`,
      success: async (res) => {
        if (!res.confirm) return;
        if (res.content !== confirmationText) {
          toastLater({ title: '输入不匹配，已取消', icon: 'none' });
          return;
        }

        wx.showLoading({ title: '清空中...' });
        try {
          const ret = await cloudCall({
            name: 'testTool',
            data: {
              action: isWeek ? 'clearWeek' : (isAll ? 'clearAll' : 'clearSubscriptions'),
              confirmationToken: previewResult.confirmationToken,
              confirmationText
            }
          });
          wx.hideLoading();
          if (ret.result.success) {
            toastLater({ title: '清理完成', icon: 'success' });
            this.setData({ testStats: null });
            this.loadTestStats();
          } else {
            wx.showModal({
              title: '未执行清理',
              content: ret.result.message || '服务端拒绝了本次操作',
              showCancel: false
            });
          }
        } catch (err) {
          wx.hideLoading();
          toastLater({ title: '清空失败', icon: 'none' });
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
    this.setData({ showPasscodeModal: false });
  },

  onPasscodeLabelInput(e) {
    this.setData({ newPasscodeLabel: e.detail.value });
  },

  async confirmAddPasscode() {
    const { newPasscodeLabel } = this.data;
    if (!newPasscodeLabel || !newPasscodeLabel.trim()) {
      toastLater({ title: '请输入描述标签', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '生成中...' });
    try {
      const ret = await cloudCall({
        name: 'manageAdmins',
        data: { action: 'addPasscode', label: newPasscodeLabel.trim() }
      });
      wx.hideLoading();

      if (ret.result.success) {
        this.closePasscodeModal();
        this.setData({
          showPasscodeResultModal: true,
          generatedPasscode: ret.result.code
        });
        this.loadPasscodeList();
      } else {
        toastLater({ title: ret.result.message, icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      toastLater({ title: '生成失败', icon: 'none' });
    }
  },

  closePasscodeResultModal() {
    this.setData({ showPasscodeResultModal: false, generatedPasscode: '' });
  },

  onCopyPasscode() {
    const code = this.data.generatedPasscode;
    if (code) {
      wx.setClipboardData({
        data: code,
        success() { toastLater({ title: '已复制', icon: 'success' }); },
        fail(err) {
          console.warn('复制失败:', err);
          toastLater({ title: '复制失败', icon: 'none' });
        }
      });
    }
  },

  onDeletePasscode(e) {
    const { id, label } = e.currentTarget.dataset;
    wx.showModal({
      title: '确认删除',
      content: `确定删除通行码「${label}」吗？删除后该码立即失效。`,
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '删除中...' });
          try {
            const ret = await cloudCall({
              name: 'manageAdmins',
              data: { action: 'deletePasscode', passcodeId: id }
            });
            wx.hideLoading();
            if (ret.result.success) {
              toastLater({ title: '已删除', icon: 'success' });
              this.loadPasscodeList();
            } else {
              toastLater({ title: ret.result.message, icon: 'none' });
            }
          } catch (err) {
            wx.hideLoading();
            toastLater({ title: '删除失败', icon: 'none' });
          }
        }
      }
    });
  },

  onRevokeAdmin(e) {
    const openid = e.currentTarget.dataset.openid;
    const preview = openid.length > 8 ? openid.substring(0, 4) + '...' + openid.substring(openid.length - 4) : openid;
    wx.showModal({
      title: '确认撤销',
      content: `确定撤销管理员 ${preview} 的身份吗？该用户将失去管理权限。`,
      confirmColor: theme.getNativeColors().danger,
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '处理中...' });
          try {
            const ret = await cloudCall({
              name: 'manageAdmins',
              data: { action: 'revokeAdmin', targetOpenid: openid }
            });
            wx.hideLoading();
            if (ret.result.success) {
              toastLater({ title: '已撤销', icon: 'success' });
              this.loadAdminList();
            } else {
              toastLater({ title: ret.result.message, icon: 'none' });
            }
          } catch (err) {
            wx.hideLoading();
            toastLater({ title: '撤销失败', icon: 'none' });
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
        toastLater({ title: (res.result && res.result.message) || '加载失败', icon: 'none' });
      }
    } catch (err) {
      toastLater({ title: '说明列表加载失败', icon: 'none' });
    } finally {
      this.setData({ helpLoading: false });
    }
  },

  onAddHelpArticle() {
    wx.navigateTo({ url: '/pages/admin/help-editor' });
  },

  onInitializeHelpArticles() {
    wx.showModal({
      title: '生成默认说明',
      content: '将生成一套可继续编辑的基础使用说明，是否继续？',
      confirmText: '生成',
      success: async modalRes => {
        if (!modalRes.confirm) return;
        wx.showLoading({ title: '生成中...' });
        try {
          const res = await cloudCall({
            name: 'manageHelpContent',
            data: { action: 'initializeDefaults' }
          });
          if (res.result && res.result.success) {
            toastLater({ title: '已生成', icon: 'success' });
            this.loadHelpArticles(false);
          } else {
            toastLater({ title: (res.result && res.result.message) || '生成失败', icon: 'none' });
          }
        } catch (err) {
          toastLater({ title: '生成失败', icon: 'none' });
        } finally {
          wx.hideLoading();
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
        toastLater({ title: (res.result && res.result.message) || '排序失败', icon: 'none' });
      }
    } catch (err) {
      toastLater({ title: '排序失败', icon: 'none' });
    }
  },

  onToggleHelpArticle(e) {
    const { id, published } = e.currentTarget.dataset;
    const isPublished = published === true || published === 'true';
    const nextPublished = !isPublished;
    wx.showModal({
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
            toastLater({ title: nextPublished ? '已发布' : '已隐藏', icon: 'success' });
            this.loadHelpArticles(false);
          } else {
            toastLater({ title: (res.result && res.result.message) || '操作失败', icon: 'none' });
          }
        } catch (err) {
          toastLater({ title: '操作失败', icon: 'none' });
        }
      }
    });
  },

  onDeleteHelpArticle(e) {
    const { id, title } = e.currentTarget.dataset;
    wx.showModal({
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
            toastLater({ title: '已删除', icon: 'success' });
            this.loadHelpArticles(false);
          } else {
            toastLater({ title: (res.result && res.result.message) || '删除失败', icon: 'none' });
          }
        } catch (err) {
          toastLater({ title: '删除失败', icon: 'none' });
        }
      }
    });
  }
}));