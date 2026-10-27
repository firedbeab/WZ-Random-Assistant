const feedback = require('../../utils/admin-feedback');
const theme = require('../../utils/theme');
const { cloudCall, collectionName, isTestMode, storageKey } = require('../../utils/runtime');

const LAST_SUBMISSION_KEY = storageKey('last_submission');
const { unlockTapCount } = require('../../utils/dice-easter-egg');
const eggPhotos = require('../../utils/easter-egg-photos');
const homePresentation = require('../../utils/home-presentation');

Page(theme.page(feedback.notifications({
  data: {
    isTestMode: isTestMode(),
    userInfo: null,
    diceShakeStyle: '',
    weeklyCode: '',
    title: '',
    remark: '',
    specialNote: '',
    loading: false,
    statusReady: false,
    statusError: false,
    focusedField: '',
    beforeOpening: false,
    channelForceClosed: false,
    scheduleLoadFailed: false,
    previewSongs: [],
    previewTotal: 0,
    previewWeekText: '',
    previewNote: '',
    canSubmit: true, // 是否允许提交
    nextOpenText: '', // 下次开放时间文案（关闭态展示）
    hoursLeftText: '', // 开放态剩余小时文案
    statusMsg: '',
    hasSubmitted: false,
    ...homePresentation.submissionView(null),
    schedulePublished: false,
    totalSubmissions: 0 // 本周总提交次数
  },

    // 获取用户信息并更新全局状态
    async checkUserStatus() {
      try {
        const res = await cloudCall({ name: 'getUserInfo' });
        if (res.result.success) {
          const userInfo = res.result.data;
          this.setData({ userInfo });
          getApp().globalData.userInfo = userInfo;
        }
      } catch (err) {
        console.warn('获取用户信息失败');
      }
    },

    // 获取本周日 YYYY-MM-DD（基于北京时间，与云函数一致）
    getWeekKey() {
      const now = new Date();
      const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      const day = bjTime.getUTCDay(); // 0=周日 ... 6=周六
      const diff = (7 - day) % 7;
      const sun = new Date(bjTime.getTime());
      sun.setUTCDate(bjTime.getUTCDate() + diff);
      return sun.toISOString().split('T')[0];
    },

    // 获取列表页“最新一期”对应的周日：周日取当天，周一至周六取上一个周日。
    getLatestScheduleWeekKey() {
      const now = new Date();
      const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      const day = bjTime.getUTCDay();
      const sun = new Date(bjTime.getTime());
      sun.setUTCDate(bjTime.getUTCDate() + (day === 0 ? 0 : -day));
      return sun.toISOString().split('T')[0];
    },

    // 关闭时展示的下次开放时间（北京时间，周日 8:00 起）
    computeNextOpenText(bjTime) {
      return homePresentation.nextOpenText(bjTime, !!(this.data.userInfo && this.data.userInfo.channelForceClose));
    },

    // 开放时展示的剩余小时数
    computeHoursLeft(bjTime) {
      return homePresentation.hoursLeftText(bjTime);
    },

    // 底部提交结果只作为本次操作的短暂反馈，不参与提交状态判断。
    showStatusMessage(message) {
      if (this._statusMsgTimer) clearTimeout(this._statusMsgTimer);
      this.setData({ statusMsg: message });
      this._statusMsgTimer = setTimeout(() => {
        this.setData({ statusMsg: '' });
        this._statusMsgTimer = null;
      }, 4000);
    },

    clearStatusMessage() {
      if (this._statusMsgTimer) {
        clearTimeout(this._statusMsgTimer);
        this._statusMsgTimer = null;
      }
      if (this.data.statusMsg) this.setData({ statusMsg: '' });
    },

    // 每次进入页面实时判断：时间窗口 + 通道开关 + 是否已提交
    async checkTimeAndSubmission() {
      // 并发令牌：只采纳最后一次状态检查的结果，迟到的旧响应直接丢弃。
      const token = (this._statusToken = (this._statusToken || 0) + 1);
      let hasCachedSubmission = false;
      try {
        this.clearStatusMessage();

        // 1. 计算北京时间
        const now = new Date();
        const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
        const isSunday = bjTime.getUTCDay() === 0;
        const isWithinHours = bjTime.getUTCHours() >= 8 && bjTime.getUTCHours() < 20;
        let channelOpen = isSunday && isWithinHours;

        // 2. 检查超管通道开关（强制关闭优先于强制开放）
        if (this.data.userInfo && this.data.userInfo.channelForceClose) {
          channelOpen = false; // 强制关闭，锁定通道
        } else if (!channelOpen && this.data.userInfo && this.data.userInfo.channelForceOpen) {
          channelOpen = true;  // 强制开放
        }

        this.setData({
          canSubmit: channelOpen,
          statusError: false,
          scheduleLoadFailed: false,
          beforeOpening: isSunday && bjTime.getUTCHours() < 8,
          channelForceClosed: !!(this.data.userInfo && this.data.userInfo.channelForceClose),
          nextOpenText: this.computeNextOpenText(bjTime),
          hoursLeftText: channelOpen ? this.computeHoursLeft(bjTime) : ''
        });

        const currentWeekKey = this.getWeekKey();
        // 通道开放时检查当前提交周期；关闭后检查列表页的“最新一期”，
        // 让发布提示从周日发布后持续到周六，下一周日自动进入新周期。
        const publishedWeekKey = channelOpen
          ? currentWeekKey
          : this.getLatestScheduleWeekKey();
        // 3. 检查本周是否已有已发布的排期
        //    如果已发布，说明本周流程已结束，重置为"通道已关闭"状态
        try {
          const pubRes = this.data.isTestMode
            ? await cloudCall({
              name: 'getUserInfo',
              data: { action: 'getPublishedSchedule', weekKey: publishedWeekKey }
            })
            : await wx.cloud.database().collection(collectionName('schedules'))
              .where({ week_key: publishedWeekKey, status: 'published' })
              .limit(1)
              .get();
          if (token !== this._statusToken) return;
          if (this.data.isTestMode && (!pubRes.result || !pubRes.result.success)) throw new Error('SCHEDULE_READ_FAILED');
          const publishedSchedule = this.data.isTestMode
            ? (pubRes.result && pubRes.result.success ? pubRes.result.data : null)
            : pubRes.data[0];
          if (publishedSchedule) {
            // 排期已发布 → 清除已提交状态和本地缓存
            wx.removeStorageSync(LAST_SUBMISSION_KEY);
            if (token !== this._statusToken) return;
            this.setData({
              hasSubmitted: false, ...homePresentation.submissionView(null), schedulePublished: true,
              ...homePresentation.schedulePreview(publishedSchedule)
            });
            return;
          }
        } catch (pubErr) {
          if (token !== this._statusToken) return;
          // 读取失败不伪装成“尚未发布”，也不展示上次留存的预览。
          this.setData({ scheduleLoadFailed: true });
        }

        // 本周排期尚未发布
        if (token !== this._statusToken) return;
        this.setData({ schedulePublished: false, ...homePresentation.schedulePreview(null) });

        // 4. 先查本地缓存（优先读缓存，避免重复查询数据库）
        const cached = wx.getStorageSync(LAST_SUBMISSION_KEY);
        if (cached && cached.week_key === currentWeekKey && cached.song_name) {
          if (token !== this._statusToken) return;
          hasCachedSubmission = true;
          this.setData({
            hasSubmitted: true,
            ...homePresentation.submissionView(cached)
          });
          // 新缓存包含明确的备注字段；旧缓存继续查本人投稿，补齐此前未保存的备注。
          if (Object.prototype.hasOwnProperty.call(cached, 'special_note')) return;
        }

        // 5. 缓存未命中，查数据库
        const app = getApp();
        const userInfo = app.globalData.userInfo;
        if (!userInfo || !userInfo.openid) return;

        const res = this.data.isTestMode
          ? await cloudCall({
            name: 'getUserInfo',
            data: { action: 'getMySubmission', weekKey: currentWeekKey }
          })
          : await wx.cloud.database().collection(collectionName('submissions'))
            .where({ user_id: userInfo.openid, week_key: currentWeekKey })
            .limit(1)
            .get();
        if (this.data.isTestMode && (!res.result || !res.result.success)) throw new Error('SUBMISSION_READ_FAILED');
        const song = this.data.isTestMode
          ? (res.result && res.result.success ? res.result.data : null)
          : res.data[0];

        if (song) {
          if (token !== this._statusToken) return;
          this.setData({
            hasSubmitted: true,
            ...homePresentation.submissionView(song)
          });
          wx.setStorageSync(LAST_SUBMISSION_KEY, {
            week_key: currentWeekKey, song_name: song.song_name,
            remark: song.singer || song.remark || '', special_note: song.special_note || ''
          });
        } else {
          if (token !== this._statusToken) return;
          this.setData({ hasSubmitted: false, ...homePresentation.submissionView(null) });
        }
      } catch (e) {
        console.warn('状态检查失败');
        if (token === this._statusToken) this.setData({ statusError: !hasCachedSubmission });
      } finally {
        if (token === this._statusToken) this.setData({ statusReady: true });
      }
    },

    async onLoad() {
      this._diceTapTarget = unlockTapCount(this.data.isTestMode);
      this._diceTapCount = 0;
      this._diceUnlocked = false;
      this._diceUnlocking = false;
      eggPhotos.warm();
      this._loading = true;
      await this.checkUserStatus(); // 先等用户信息加载完成（含通道状态）
      await Promise.all([
        this.checkTimeAndSubmission(), // 再检查已提交状态（依赖 userInfo）
        this.loadSubmitCount() // 加载本周提交总次数
      ]);
      this._loading = false;
    },

    async onShow() {
      if (this._loading) return; // onLoad 未完成时跳过，避免并发冲突
      await this.checkUserStatus(); // 重新拉取（含最新通道状态）
      await Promise.all([
        this.checkTimeAndSubmission(),
        this.loadSubmitCount()
      ]);
    },

    onHide() {
      this.setData({ focusedField: '' });
      this.clearStatusMessage();
      this.cancelDiceShake();
    },

    onUnload() {
      this.cancelDiceShake();
      if (this._statusMsgTimer) clearTimeout(this._statusMsgTimer);
      this._statusMsgTimer = null;
    },

    async onPullDownRefresh() {
      // 下拉刷新：清除本地缓存，重新从云端同步所有状态
      wx.removeStorageSync(LAST_SUBMISSION_KEY);
      try {
        await this.checkUserStatus();
        await Promise.all([
          this.checkTimeAndSubmission(),
          this.loadSubmitCount()
        ]);
      } finally {
        wx.stopPullDownRefresh();
      }
    },

  // 加载本周提交总次数
  async loadSubmitCount() {
    try {
      const weekKey = this.getWeekKey();
      if (this.data.isTestMode) {
        const res = await cloudCall({
          name: 'getUserInfo',
          data: { action: 'getSubmitCount', weekKey }
        });
        if (res.result && res.result.success) {
          this.setData({ totalSubmissions: res.result.data });
        }
      } else {
        const res = await wx.cloud.database()
          .collection(collectionName('submission_counters'))
          .doc(weekKey)
          .get();
        if (res.data && res.data.count !== undefined) {
          this.setData({ totalSubmissions: res.data.count });
        }
      }
    } catch (err) {
      // 文档不存在或查询失败，忽略（显示0）
    }
  },

  // 绑定输入事件
  onInput(e) {
    const { field } = e.currentTarget.dataset;
    this.setData({ [field]: e.detail.value });
  },

  onFieldFocus(e) {
    this.setData({ focusedField: e.currentTarget.dataset.field });
  },

  onFieldBlur(e) {
    if (this.data.focusedField === e.currentTarget.dataset.field) this.setData({ focusedField: '' });
  },

  // 提交内容
  async submitRequest() {
    if (this.data.loading) return;
    const { weeklyCode, title, remark, specialNote } = this.data;

    // 1. 前端基础校验
    if (!weeklyCode) return feedback.showToast(this, { title: '请输入本周验证码', icon: 'none' });
    if (!title) return feedback.showToast(this, { title: '请输入歌名', icon: 'none' });
    if (!remark) return feedback.showToast(this, { title: '请输入歌手或来源', icon: 'none' });

    this.setData({ loading: true });
    feedback.showLoading(this, { title: '提交中…', mask: true });
    try {
      // 2. 调用云函数
      const res = await cloudCall({
        name: 'checkWeeklyCode',
        data: {
          weeklyCode,
          title,
          remark,
          specialNote
        }
      });

      if (res.result.success) {
        const count = res.result.totalSubmissions;
        const countText = count ? `（本周第 ${count} 次提交）` : '';

        feedback.showToast(this, { title: '提交成功', icon: 'success' });
        // 缓存提交信息（含 week_key，防止跨周误显示）
        const weekKey = this.getWeekKey();
        wx.setStorageSync(LAST_SUBMISSION_KEY, {
          week_key: weekKey,
          song_name: title,
          remark: remark,
          special_note: specialNote
        });
        // 提交成功：作废可能还在途中的旧状态检查，避免把“已提交”又改回未提交。
        this._statusToken = (this._statusToken || 0) + 1;
        this.setData({
          weeklyCode: '',
          title: '',
          remark: '',
          specialNote: '',
          hasSubmitted: true,
          statusReady: true,
          focusedField: '',
          ...homePresentation.submissionView({ song_name: title, singer: remark, special_note: specialNote }),
          schedulePublished: false,
          ...(typeof count === 'number' ? { totalSubmissions: count } : {})
        });
        this.showStatusMessage(`已提交，请等待抽取 ${countText}`);
      } else {
        feedback.showToast(this, { title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      feedback.showToast(this, { title: '网络错误', icon: 'none' });
    } finally {
      this.setData({ loading: false });
      feedback.hideLoading(this);
    }
  },

  // 标题骰子的隐藏入口；本次首页实例解锁后可以反复打开。
  onSecretDiceTap() {
    if (this._diceUnlocking) return;
    const dice = this.selectComponent('#easterDice');
    if (this._diceUnlocked) { if (dice) dice.open(); return; }
    if (!this._diceTapTarget) this._diceTapTarget = unlockTapCount(this.data.isTestMode);
    this._diceTapCount = (this._diceTapCount || 0) + 1;
    const finalTap = this._diceTapCount >= this._diceTapTarget;
    const progress = Math.min(1, this._diceTapCount / this._diceTapTarget);
    const name = this._diceTapCount % 2 ? 'a' : 'b';
    this.setData({ diceShakeStyle: `--tilt:${4 + progress * 26}deg;--lift:${-1 - progress * 5}rpx;animation:secret-wiggle-${name} ${finalTap ? '.11s linear 14' : `${.3 - progress * .12}s ease-in-out 2`};` });
    if (!finalTap) return;
    this._diceUnlocking = true;
    this._diceUnlockTimer = setTimeout(() => {
      this._diceUnlockTimer = null; this._diceUnlocking = false; this._diceUnlocked = true;
      this.setData({ diceShakeStyle: '' });
      if (dice) dice.open();
    }, 1540);
  },

  cancelDiceShake() {
    if (this._diceUnlockTimer) clearTimeout(this._diceUnlockTimer);
    this._diceUnlockTimer = null;
    if (this._diceUnlocking) this._diceTapCount = Math.max(0, this._diceTapTarget - 1);
    this._diceUnlocking = false;
    this.setData({ diceShakeStyle: '' });
  },

  onResetDiceGate(e) {
    if (!this.data.isTestMode || !this.data.userInfo || this.data.userInfo.role !== 'superadmin') return;
    this.cancelDiceShake(); this._diceUnlocked = false; this._diceTapCount = 0;
    this._diceTapTarget = unlockTapCount(!e.detail.normal);
    feedback.showToast(this, { title: e.detail.normal ? '已重置随机5–20次入口' : '已重置5次入口', icon: 'none' });
  },

  // 跳转排期页
  goPlaylist() {
    wx.navigateTo({ url: '/pages/playlist/index' });
  },

  goHistory() {
    wx.navigateTo({ url: '/pages/playlist/index?tab=1' });
  },

  goHelp() {
    wx.navigateTo({ url: '/pages/help/index' });
  },

  // 跳转关于页
  goAbout() {
    wx.navigateTo({ url: '/pages/about/index' });
  },

  // 管理员入口跳转
  goAdmin() {
    // 管理员身份以 getUserInfo 返回的云端角色为准，避免换设备后因本地缓存缺失重复验证
    const role = this.data.userInfo && this.data.userInfo.role;
    const isAdmin = role === 'admin' || role === 'superadmin';
    const url = isAdmin ? '/pages/admin/admin' : '/pages/admin/login';
    wx.navigateTo({ url: url, fail: err => {
      console.warn('管理页面跳转失败:', err && err.errMsg || '未知原因');
      feedback.showToast(this, { title: '页面未能打开，请重新编译后重试', icon: 'none' });
    } });
  }
})));
