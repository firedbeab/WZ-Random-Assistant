// 订阅消息模板 ID（学生：新活动发布提醒）
const STUDENT_TPL_ID = 'evJj_6Kl8CNKTf5C_j2PtJ6FPmMTbBESvuZ35DfOiGA';
const { cloudCall, collectionName, isTestMode, storageKey } = require('../../utils/runtime');

Page({
  data: {
    isTestMode: isTestMode(),
    schedule: null,
    loading: true,
    subscribed: false,
    // 周次标签：0=本周, 1=上周, 2=上上周
    activeTab: 0,
    tabs: [
      { label: '最新列表', value: 0 },
      { label: '上一期', value: 1 },
      { label: '上上期', value: 2 }
    ]
  },

  onLoad() {
    this.loadWeekPlaylist(0, false);
    this.checkSubStatus();
  },

  onPullDownRefresh() {
    this.loadWeekPlaylist(this.data.activeTab, true)
      .then(() => wx.stopPullDownRefresh());
  },

  // 计算指定周偏移的 week_key
  // "最新"对应最近一个已过去的周日（抽取发生的那天）
  // 周一~周六 → 上一个周日；周日当天 → 本周日
  getWeekKeyByOffset(offset) {
    const now = new Date();
    const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const day = bjTime.getUTCDay(); // 0=周日 ... 6=周六
    // 周日(0) → diff=0；其他天 → 回退到上一个周日
    const diff = day === 0 ? 0 : -day;
    const sun = new Date(bjTime.getTime());
    sun.setUTCDate(bjTime.getUTCDate() + diff - (offset * 7));
    return sun.toISOString().split('T')[0];
  },

  // 切换周次标签
  switchWeek(e) {
    const value = Number(e.currentTarget.dataset.value);
    if (value === this.data.activeTab) return;
    this.setData({ activeTab: value });
    this.loadWeekPlaylist(value, false);
  },

  // 按 week_key 加载指定周的排期
  // forceRefresh: true 时跳过缓存（下拉刷新）
  async loadWeekPlaylist(offset, forceRefresh) {
    const weekKey = this.getWeekKeyByOffset(offset);
    const cacheKey = storageKey(`schedule_cache_${weekKey}`);

    // 1. 优先读本地缓存，立即显示（不转圈）
    if (!forceRefresh) {
      const cached = wx.getStorageSync(cacheKey);
      if (cached) {
        this.setData({ schedule: cached, loading: false });
        // 已发布排期现在支持超管修改或撤回；所有周次命中缓存后都静默校验云端。
        // 缓存仍负责首屏秒开，云端 revision/状态变化会随后替换或清除本地内容。
        this.refreshFromCloud(offset, weekKey, cacheKey);
        return;
      }
    }

    // 2. 缓存未命中或强制刷新，请求云端
    this.setData({ loading: true, schedule: null });
    await this.refreshFromCloud(offset, weekKey, cacheKey);
  },

  // 从云端拉取排期并写入缓存
  async refreshFromCloud(offset, weekKey, cacheKey) {
    try {
      const res = this.data.isTestMode
        ? await cloudCall({
          name: 'getUserInfo',
          data: { action: 'getPublishedSchedule', weekKey }
        })
        : await wx.cloud.database().collection(collectionName('schedules'))
          .where({ week_key: weekKey, status: 'published' })
          .limit(1)
          .get();
      const schedule = this.data.isTestMode
        ? (res.result && res.result.success ? res.result.data : null)
        : res.data[0];

      if (schedule) {
        wx.setStorageSync(cacheKey, schedule);
        // 确保用户没切走标签，才更新显示
        if (this.data.activeTab === offset) {
          this.setData({ schedule });
        }
      } else {
        // 云端无数据，清除缓存
        wx.removeStorageSync(cacheKey);
        if (this.data.activeTab === offset) {
          this.setData({ schedule: null });
        }
      }
    } catch (err) {
      console.warn('加载排期失败');
      // 云端失败时，如果已有缓存则不提示（静默失败）
      if (!this.data.schedule) {
        wx.showToast({ title: '加载失败', icon: 'none' });
      }
    } finally {
      if (this.data.activeTab === offset) {
        this.setData({ loading: false });
      }
    }
  },

  // 长按复制内容信息
  copyItem(e) {
    const { name = '', singer = '', note = '' } = e.currentTarget.dataset;
    const item = note
      ? `${name} - ${singer}\n备注：${note}`
      : `${name} - ${singer}`;
    wx.setClipboardData({
      data: item,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
      fail(err) {
        console.warn('复制失败:', err);
        wx.showToast({ title: '复制失败，需同意隐私协议', icon: 'none' });
      }
    });
  },

  // 获取本周日 YYYY-MM-DD（与云函数一致，用于订阅）
  getWeekKey() {
    const now = new Date();
    const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const day = bjTime.getUTCDay();
    const diff = (7 - day) % 7;
    const sun = new Date(bjTime.getTime());
    sun.setUTCDate(bjTime.getUTCDate() + diff);
    return sun.toISOString().split('T')[0];
  },

  // 检查本周是否已开启发布通知
  async checkSubStatus() {
    if (this.data.isTestMode) {
      this.setData({ subscribed: false });
      return;
    }
    try {
      const db = wx.cloud.database();
      const weekKey = this.getWeekKey();
      const res = await db.collection(collectionName('message_subscriptions'))
        .where({ openid: '{openid}', template_id: STUDENT_TPL_ID, type: 'student', week_key: weekKey, consumed: false })
        .limit(1).get();
      this.setData({ subscribed: res.data.length > 0 });
    } catch (e) {
      // 检查失败不影响主流程
    }
  },

  // 按钮点击：开启发布通知
  async onEnableSub() {
    if (this.data.isTestMode) {
      this.setData({ subscribed: true });
      wx.showToast({ title: '测试环境已模拟订阅', icon: 'none' });
      return;
    }
    try {
      const db = wx.cloud.database();
      const openid = getApp().globalData.userInfo.openid;
      const weekKey = this.getWeekKey();

      const res = await wx.requestSubscribeMessage({ tmplIds: [STUDENT_TPL_ID] });
      if (res[STUDENT_TPL_ID] === 'accept') {
        // 再次检查避免重复创建
        const existing = await db.collection(collectionName('message_subscriptions'))
          .where({ openid: '{openid}', template_id: STUDENT_TPL_ID, type: 'student', week_key: weekKey, consumed: false })
          .limit(1).get();
        if (existing.data.length === 0) {
          await db.collection(collectionName('message_subscriptions')).add({
            data: {
              openid,
              template_id: STUDENT_TPL_ID,
              type: 'student',
              week_key: weekKey,
              consumed: false,
              created_at: db.serverDate()
            }
          });
        }
        this.setData({ subscribed: true });
        wx.showToast({ title: '已开启通知', icon: 'success' });
      }
    } catch (err) {
      console.warn('订阅失败:', err);
    }
  }
});
