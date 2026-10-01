Page({
  data: {
    userInfo: null,
    weeklyCode: '',
    title: '',
    remark: '',
    specialNote: '',
    loading: false,
    canSubmit: true, // 是否允许提交
    statusMsg: '',
    hasSubmitted: false,
    submittedInfo: '',
    schedulePublished: false,
    totalSubmissions: 0 // 本周总提交次数
  },

    // 获取用户信息并更新全局状态
    async checkUserStatus() {
      try {
        const res = await wx.cloud.callFunction({ name: 'getUserInfo' });
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

        this.setData({ canSubmit: channelOpen });

        const currentWeekKey = this.getWeekKey();
        // 通道开放时检查当前提交周期；关闭后检查列表页的“最新一期”，
        // 让发布提示从周日发布后持续到周六，下一周日自动进入新周期。
        const publishedWeekKey = channelOpen
          ? currentWeekKey
          : this.getLatestScheduleWeekKey();
        const db = wx.cloud.database();

        // 3. 检查本周是否已有已发布的排期
        //    如果已发布，说明本周流程已结束，重置为"通道已关闭"状态
        try {
        const pubRes = await db.collection('schedules')
            .where({ week_key: publishedWeekKey, status: 'published' })
            .limit(1)
            .get();
          if (pubRes.data.length > 0) {
            // 排期已发布 → 清除已提交状态和本地缓存
            wx.removeStorageSync('last_submission');
            this.setData({ hasSubmitted: false, submittedInfo: '', schedulePublished: true });
            return;
          }
        } catch (pubErr) {
          // 查询失败不阻塞后续逻辑
        }

        // 本周排期尚未发布
        this.setData({ schedulePublished: false });

        // 4. 先查本地缓存（优先读缓存，避免重复查询数据库）
        const cached = wx.getStorageSync('last_submission');
        if (cached && cached.week_key === currentWeekKey && cached.song_name) {
          this.setData({
            hasSubmitted: true,
            submittedInfo: `《${cached.song_name}》- ${cached.remark}`
          });
          return; // 缓存命中，无需查库
        }

        // 5. 缓存未命中，查数据库
        const app = getApp();
        const userInfo = app.globalData.userInfo;
        if (!userInfo || !userInfo.openid) return;

        const res = await db.collection('submissions')
          .where({ user_id: userInfo.openid, week_key: currentWeekKey })
          .limit(1)
          .get();

        if (res.data.length > 0) {
          const song = res.data[0];
          this.setData({
            hasSubmitted: true,
            submittedInfo: `《${song.song_name}》- ${song.singer}`
          });
        } else {
          this.setData({ hasSubmitted: false });
        }
      } catch (e) {
        console.warn('状态检查失败');
      }
    },

    async onLoad() {
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
      this.clearStatusMessage();
    },

    onUnload() {
      if (this._statusMsgTimer) clearTimeout(this._statusMsgTimer);
      this._statusMsgTimer = null;
    },

    async onPullDownRefresh() {
      // 下拉刷新：清除本地缓存，重新从云端同步所有状态
      wx.removeStorageSync('last_submission');
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
      const db = wx.cloud.database();
      const weekKey = this.getWeekKey();
      const res = await db.collection('submission_counters').doc(weekKey).get();
      if (res.data && res.data.count !== undefined) {
        this.setData({ totalSubmissions: res.data.count });
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

  // 提交内容
  async submitRequest() {
    const { weeklyCode, title, remark, specialNote } = this.data;

    // 1. 前端基础校验
    if (!weeklyCode) return wx.showToast({ title: '请输入本周验证码', icon: 'none' });
    if (!title) return wx.showToast({ title: '请输入内容名称', icon: 'none' });
    if (!remark) return wx.showToast({ title: '请输入补充说明', icon: 'none' });

    this.setData({ loading: true });

    try {
      // 2. 调用云函数
      const res = await wx.cloud.callFunction({
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

        wx.showToast({ title: '提交成功', icon: 'success' });
        // 缓存提交信息（含 week_key，防止跨周误显示）
        const weekKey = this.getWeekKey();
        wx.setStorageSync('last_submission', {
          week_key: weekKey,
          song_name: title,
          remark: remark
        });
        this.setData({
          weeklyCode: '',
          title: '',
          remark: '',
          specialNote: '',
          hasSubmitted: true,
          submittedInfo: `《${title}》- ${remark}`,
          schedulePublished: false,
          ...(typeof count === 'number' ? { totalSubmissions: count } : {})
        });
        this.showStatusMessage(`已提交，请等待抽取 ${countText}`);
      } else {
        wx.showToast({ title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      wx.showToast({ title: '网络错误', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 跳转排期页
  goPlaylist() {
    wx.navigateTo({ url: '/pages/playlist/index' });
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
    wx.navigateTo({ url: url });
  }
});
