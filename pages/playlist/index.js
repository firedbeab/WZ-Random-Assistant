const theme = require('../../utils/theme');
// 订阅消息模板 ID（学生：新活动发布提醒）
const STUDENT_TPL_ID = 'evJj_6Kl8CNKTf5C_j2PtJ6FPmMTbBESvuZ35DfOiGA';
const { cloudCall, collectionName, isTestMode, storageKey } = require('../../utils/runtime');
const { playlistPresentation } = require('../../utils/playlist-presentation');

Page(theme.page({
  data: {
    isTestMode: isTestMode(),
    schedule: null,
    loading: true,
    loadError: false,
    showingCached: false,
    revalidating: false,
    subscribing: false,
    ...playlistPresentation(null, ''),
    subscribed: false,
    // 周次标签：0=本周, 1=上周, 2=上上周
    activeTab: 0,
    renderedWeeks: [0],
    tabIndicatorReady: false,
    tabIndicatorStyle: '',
    tabs: [
      { label: '最新一期', value: 0 },
      { label: '上一期', value: 1 },
      { label: '上上期', value: 2 }
    ]
  },

  onLoad(options = {}) {
    const activeTab = ['1', '2'].includes(options.tab) ? Number(options.tab) : 0;
    this._prefetchEnabled = true;
    this._prefetchStarted = false;
    this._playlistUnloaded = false;
    this.setData({ activeTab, renderedWeeks: [activeTab] });
    this.loadWeekPlaylist(activeTab, false);
    this.checkSubStatus();
  },

  onReady() {
    this.measureWeekTabs();
  },

  onResize() {
    if (typeof wx.nextTick === 'function') wx.nextTick(() => this.measureWeekTabs());
    else this.measureWeekTabs();
  },

  // 按实际标签宽度定位同一根滑条，不写死汉字宽度或机型尺寸。
  measureWeekTabs() {
    if (this._playlistUnloaded || typeof wx.createSelectorQuery !== 'function') return;
    const measureId = this._tabMeasureId = (this._tabMeasureId || 0) + 1;
    const query = wx.createSelectorQuery().in(this);
    query.select('.week-tabs').boundingClientRect();
    query.selectAll('.tab-item').boundingClientRect();
    query.exec(result => {
      if (this._playlistUnloaded || measureId !== this._tabMeasureId) return;
      const [container, items] = result || [];
      if (!container || !Number.isFinite(container.left) || !Array.isArray(items) || items.length !== this.data.tabs.length || items.some(item => !item || !Number.isFinite(item.left) || !Number.isFinite(item.width) || item.width <= 0)) {
        this._tabLayout = null;
        this.setData({ tabIndicatorReady: false });
        return;
      }
      this._tabLayout = items.map(item => ({ left: item.left - container.left, width: item.width }));
      this.setData(this.tabIndicatorPatch(this.data.activeTab));
    });
  },

  tabIndicatorPatch(value) {
    const item = this._tabLayout && this._tabLayout[value];
    return item ? { tabIndicatorReady: true, tabIndicatorStyle: `width:${item.width}px;transform:translateX(${item.left}px);` } : {};
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
    return this.selectWeek(Number(e.currentTarget.dataset.value));
  },

  // 点击和滑动复用同一读取路径，保留缓存校验及迟到响应保护。
  selectWeek(value) {
    if (!Number.isInteger(value) || value < 0 || value >= this.data.tabs.length || value === this.data.activeTab) return;
    // 只渲染选中期次；换 key 重启单段淡入，避免原生多步动画停在透明状态。
    this.setData({ activeTab: value, renderedWeeks: [value], ...this.tabIndicatorPatch(value) });
    return this.loadWeekPlaylist(value, false);
  },

  onPlaylistTouchStart(e) {
    this.onPlaylistTouchCancel();
    const touch = e.touches && e.touches.length === 1 && e.touches[0];
    // 留出左缘系统返回手势，不拦截页面原生纵向滚动。
    if (!touch || !Number.isFinite(touch.clientX) || !Number.isFinite(touch.clientY) || touch.clientX < 24) return;
    this._playlistTouch = { x: touch.clientX, y: touch.clientY, time: e.timeStamp };
  },

  onPlaylistTouchMove(e) {
    const start = this._playlistTouch;
    if (!start) return;
    const touch = e.touches && e.touches.length === 1 && e.touches[0];
    if (!touch || !Number.isFinite(touch.clientX) || !Number.isFinite(touch.clientY)) return this.onPlaylistTouchCancel();
    const dx = Math.abs(touch.clientX - start.x), dy = Math.abs(touch.clientY - start.y);
    // 一旦开始纵向滚动，本次触摸就不再切期。
    if (dy > 12 && dy >= dx) this.onPlaylistTouchCancel();
  },

  onPlaylistTouchEnd(e) {
    const start = this._playlistTouch;
    this.onPlaylistTouchCancel();
    const touch = e.changedTouches && e.changedTouches.length === 1 && e.changedTouches[0];
    if (!start || !touch || !Number.isFinite(touch.clientX) || !Number.isFinite(touch.clientY)) return;
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    const duration = e.timeStamp - start.time;
    if (!Number.isFinite(duration) || duration < 0 || duration > 600 || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
    return this.selectWeek(this.data.activeTab + (dx < 0 ? 1 : -1));
  },

  onPlaylistTouchCancel() {
    this._playlistTouch = null;
  },

  onHide() {
    this.onPlaylistTouchCancel();
  },

  onUnload() {
    this._prefetchEnabled = false;
    this._playlistUnloaded = true;
    this._tabMeasureId = (this._tabMeasureId || 0) + 1;
    this.onPlaylistTouchCancel();
  },

  // 按 week_key 加载指定周的排期
  // forceRefresh: true 时跳过缓存（下拉刷新）
  async loadWeekPlaylist(offset, forceRefresh) {
    const weekKey = this.getWeekKeyByOffset(offset);
    const cacheKey = storageKey(`schedule_cache_${weekKey}`);
    const requestId = this._playlistRequestId = this._scheduleRequestSequence = (this._scheduleRequestSequence || 0) + 1;
    this._weekRequests = this._weekRequests || {};
    this._weekRequests[weekKey] = requestId;

    // 1. 优先读本地缓存，立即显示（不转圈）
    if (!forceRefresh) {
      let cached;
      try { cached = wx.getStorageSync(cacheKey); } catch (_) {}
      if (cached) {
        this.setData({ schedule: cached, loading: false, loadError: false, showingCached: false, revalidating: true, ...playlistPresentation(cached, weekKey) });
        // 已发布排期现在支持超管修改或撤回；所有周次命中缓存后都静默校验云端。
        // 缓存仍负责首屏秒开，云端 revision/状态变化会随后替换或清除本地内容。
        this.refreshFromCloud(offset, weekKey, cacheKey, requestId);
        return;
      }
    }

    // 2. 缓存未命中或强制刷新，请求云端
    this.setData({ loading: true, schedule: null, loadError: false, showingCached: false, revalidating: true, ...playlistPresentation(null, weekKey) });
    await this.refreshFromCloud(offset, weekKey, cacheKey, requestId);
  },

  retryLoad() {
    return this.loadWeekPlaylist(this.data.activeTab, true);
  },

  async fetchPublishedSchedule(weekKey) {
    const res = this.data.isTestMode
      ? await cloudCall({ name: 'getUserInfo', data: { action: 'getPublishedSchedule', weekKey } })
      : await wx.cloud.database().collection(collectionName('schedules'))
        .where({ week_key: weekKey, status: 'published' }).limit(1).get();
    if (this.data.isTestMode && (!res.result || !res.result.success)) throw new Error('SCHEDULE_READ_FAILED');
    return this.data.isTestMode ? res.result.data : res.data[0];
  },

  // 当前期次完成后，每次进入页面只预取另外两期一次，不改变当前展示/加载状态。
  prefetchOtherWeeks(currentOffset) {
    if (!this._prefetchEnabled || this._prefetchStarted) return;
    this._prefetchStarted = true;
    return Promise.all(this.data.tabs.filter(tab => tab.value !== currentOffset).map(async tab => {
      const weekKey = this.getWeekKeyByOffset(tab.value);
      // 已被用户主动访问的期次由其前台请求负责，后台不再发起竞争请求。
      if (this._weekRequests[weekKey]) return;
      const cacheKey = storageKey(`schedule_cache_${weekKey}`);
      const requestId = this._scheduleRequestSequence = (this._scheduleRequestSequence || 0) + 1;
      this._weekRequests[weekKey] = requestId;
      try {
        const schedule = await this.fetchPublishedSchedule(weekKey);
        if (!this._prefetchEnabled || this._weekRequests[weekKey] !== requestId) return;
        if (schedule) wx.setStorageSync(cacheKey, schedule);
        else wx.removeStorageSync(cacheKey);
      } catch (_) { /* 静默保留已有缓存；切到该期时仍会正常读取并校验。 */ }
    }));
  },

  // 从云端拉取排期并写入缓存
  async refreshFromCloud(offset, weekKey, cacheKey, requestId) {
    try {
      const schedule = await this.fetchPublishedSchedule(weekKey);
      // 同一期更晚的请求优先；旧期可更新自己的缓存，但不能覆盖当前标签。
      if (this._weekRequests[weekKey] !== requestId) return;
      const isCurrent = this.data.activeTab === offset && this._playlistRequestId === requestId;

      if (schedule) {
        try { wx.setStorageSync(cacheKey, schedule); } catch (_) {}
        // 确保用户没切走标签，才更新显示
        if (isCurrent) {
          this.setData({ schedule, loadError: false, showingCached: false, ...playlistPresentation(schedule, weekKey) });
        }
      } else {
        // 云端无数据，清除缓存
        try { wx.removeStorageSync(cacheKey); } catch (_) {}
        if (isCurrent) {
          this.setData({ schedule: null, loadError: false, showingCached: false, ...playlistPresentation(null, weekKey) });
        }
      }
    } catch (err) {
      console.warn('加载排期失败');
      if (this.data.activeTab === offset && this._playlistRequestId === requestId) {
        this.setData({ loadError: true, showingCached: !!this.data.schedule });
      }
    } finally {
      if (this.data.activeTab === offset && this._playlistRequestId === requestId) {
        this.setData({ loading: false, revalidating: false });
        if (!this.data.loadError) this._prefetchTask = this.prefetchOtherWeeks(offset);
      }
    }
  },

  // 长按复制内容信息
  copyItem(e) {
    this.onPlaylistTouchCancel();
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
    if (this.data.subscribed || this.data.subscribing) return;
    if (this.data.isTestMode) {
      this.setData({ subscribed: true });
      wx.showToast({ title: '测试环境已模拟订阅', icon: 'none' });
      return;
    }
    this.setData({ subscribing: true });
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
    } finally {
      this.setData({ subscribing: false });
    }
  }
}));
