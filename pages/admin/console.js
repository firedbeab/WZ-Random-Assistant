const { cloudCall } = require('../../utils/runtime');

const MODE_TITLES = {
  submissions: '投稿管理',
  schedules: '排期管理',
  events: '事件日志',
  counters: '计数器管理'
};

const MODE_SUBTITLES = {
  submissions: '仅超级管理员可维护，所有写操作均记录审计日志',
  schedules: '仅超级管理员可维护，所有写操作均记录审计日志',
  events: '仅超级管理员可查看，日志内容不可编辑或删除',
  counters: '仅超级管理员可校准，所有调整均记录审计日志'
};

const ACTION_LABELS = {
  'submission.update': '编辑投稿',
  'submission.remove': '移除投稿',
  'submission.restore': '恢复投稿',
  'schedule.update': '编辑排期',
  'schedule.publish': '发布排期',
  'schedule.withdraw': '撤回排期',
  'schedule.update_note': '修改特殊备注',
  'schedule.mark_exception': '标记排期异常',
  'schedule.skip_day': '跳过整日排期',
  'counter.set': '手动调整计数器',
  'counter.recalculate': '重新计算计数器',
  'admin_verify.failed': '管理员验证失败',
  'admin_verify.blocked': '管理员验证被锁定',
  'admin_verify.success': '管理员验证成功',
  'admin_verify.error': '管理员验证异常'
};

const STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: '待抽取' },
  { value: 'overflow', label: '超额' },
  { value: 'carryover', label: '历史候选' },
  { value: 'selected', label: '已入选' },
  { value: 'removed', label: '已移除' },
  { value: 'rejected', label: '已拒绝' }
];

const EVENT_CATEGORIES = [
  { value: 'all', label: '全部类别' },
  { value: 'security', label: '安全与验证' },
  { value: 'admin_action', label: '管理操作' },
  { value: 'schedule_exception', label: '排期异常' },
  { value: 'system_error', label: '系统错误' }
];

function getWeekKey() {
  const bj = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const sun = new Date(bj.getTime());
  sun.setUTCDate(bj.getUTCDate() + ((7 - bj.getUTCDay()) % 7));
  return sun.toISOString().split('T')[0];
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const bj = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')} ${String(bj.getUTCHours()).padStart(2, '0')}:${String(bj.getUTCMinutes()).padStart(2, '0')}`;
}

function displaySubmission(item) {
  const openid = item.user_id || '';
  return Object.assign({}, item, {
    user_mask: openid ? `${openid.slice(0, 5)}…${openid.slice(-4)}` : '未知用户',
    submit_time_text: formatTime(item.submit_time),
    status_text: (STATUS_OPTIONS.find(option => option.value === item.status) || {}).label || item.status
  });
}

function displayEvent(item) {
  const label = (EVENT_CATEGORIES.find(option => option.value === item.category) || {}).label || item.category || '其他';
  const operator = item.operator_openid || item.operator || '';
  const details = {
    操作: ACTION_LABELS[item.action] || item.action || '',
    操作人: operator ? `${operator.slice(0, 5)}…${operator.slice(-4)}` : '',
    目标: item.target_type ? `${item.target_type} / ${item.target_id || ''}` : '',
    周次: item.week_key || '',
    原因: item.reason || '',
    修改前: item.before === undefined ? undefined : item.before,
    修改后: item.after === undefined ? undefined : item.after,
    错误: item.error || ''
  };
  return Object.assign({}, item, {
    action_text: ACTION_LABELS[item.action] || item.action || '未命名事件',
    category_text: label,
    created_at_text: formatTime(item.created_at),
    detail_text: JSON.stringify(details, null, 2),
    expanded: false
  });
}

Page({
  data: {
    mode: 'submissions',
    title: '数据控制台',
    subtitle: MODE_SUBTITLES.submissions,
    loading: false,
    weekKey: getWeekKey(),
    keyword: '',
    statusOptions: STATUS_OPTIONS,
    statusIndex: 0,
    submissions: [],
    submissionTotal: 0,
    selectedIds: [],
    showSubmissionEditor: false,
    editSubmission: null,
    schedules: [],
    scheduleDraft: null,
    eventCategories: EVENT_CATEGORIES,
    eventCategoryIndex: 0,
    events: [],
    counters: [],
    dayKeys: ['day1', 'day2', 'day3', 'day4', 'day5'],
    counterDetail: null,
    counterCountInput: '',
    counterReason: ''
  },

  onLoad(options) {
    const mode = MODE_TITLES[options.mode] ? options.mode : 'submissions';
    this.setData({ mode, title: MODE_TITLES[mode], subtitle: MODE_SUBTITLES[mode] });
    wx.setNavigationBarTitle({ title: MODE_TITLES[mode] });
    this.loadData();
  },

  onPullDownRefresh() {
    Promise.resolve(this.loadData()).finally(() => wx.stopPullDownRefresh());
  },

  async call(action, data) {
    const res = await cloudCall({
      name: 'superAdminConsole',
      data: Object.assign({ action }, data || {})
    });
    if (!res.result || !res.result.success) {
      throw new Error((res.result && res.result.message) || '操作失败');
    }
    return res.result;
  },

  async loadData(showLoading = true) {
    if (showLoading) this.setData({ loading: true });
    try {
      if (this.data.mode === 'submissions') await this.loadSubmissions();
      if (this.data.mode === 'schedules') await this.loadSchedules();
      if (this.data.mode === 'events') await this.loadEvents();
      if (this.data.mode === 'counters') await this.loadCounters();
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onWeekInput(e) { this.setData({ weekKey: e.detail.value }); },
  onKeywordInput(e) { this.setData({ keyword: e.detail.value }); },
  onStatusChange(e) {
    this.setData({ statusIndex: Number(e.detail.value), selectedIds: [] });
    this.loadSubmissions();
  },

  async loadSubmissions() {
    const option = this.data.statusOptions[this.data.statusIndex];
    const result = await this.call('listSubmissions', {
      weekKey: this.data.weekKey,
      status: option.value,
      keyword: this.data.keyword,
      pageSize: 50
    });
    this.setData({
      submissions: (result.data || []).map(displaySubmission),
      submissionTotal: result.total || 0,
      selectedIds: []
    });
  },

  searchSubmissions() { this.loadSubmissions(); },
  onSelectionChange(e) { this.setData({ selectedIds: e.detail.value || [] }); },

  openSubmissionEditor(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.submissions.find(row => row._id === id);
    if (!item) return;
    this.setData({ showSubmissionEditor: true, editSubmission: Object.assign({}, item) });
  },
  closeSubmissionEditor() { this.setData({ showSubmissionEditor: false, editSubmission: null }); },
  onSubmissionField(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`editSubmission.${field}`]: e.detail.value });
  },
  async saveSubmission() {
    const item = this.data.editSubmission;
    if (!item) return;
    wx.showLoading({ title: '保存中' });
    try {
      await this.call('updateSubmission', {
        id: item._id, songName: item.song_name,
        singer: item.singer, specialNote: item.special_note || ''
      });
      this.closeSubmissionEditor();
      await this.loadSubmissions();
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' });
    } finally { wx.hideLoading(); }
  },

  removeSelected() {
    const ids = this.data.selectedIds;
    if (!ids.length) return wx.showToast({ title: '请先选择投稿', icon: 'none' });
    wx.showModal({
      title: `移除 ${ids.length} 条投稿`, editable: true,
      placeholderText: '必须填写移除原因', confirmText: '移除', confirmColor: '#e53e3e',
      success: async res => {
        if (!res.confirm) return;
        if (!res.content || !res.content.trim()) return wx.showToast({ title: '请填写原因', icon: 'none' });
        wx.showLoading({ title: '处理中' });
        try {
          const result = await this.call('removeSubmissions', { ids, reason: res.content });
          await this.loadSubmissions();
          wx.showToast({ title: result.message, icon: 'success' });
        } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
        finally { wx.hideLoading(); }
      }
    });
  },

  restoreSubmission(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({ title: '恢复投稿', content: '恢复后会同步增加该周计数，确定继续吗？', success: async res => {
      if (!res.confirm) return;
      try {
        await this.call('restoreSubmission', { id });
        await this.loadSubmissions();
        wx.showToast({ title: '已恢复', icon: 'success' });
      } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
    }});
  },

  async loadSchedules() {
    const result = await this.call('listSchedules');
    this.setData({ schedules: result.data || [], scheduleDraft: null });
  },
  async openSchedule(e) {
    try {
      const result = await this.call('getSchedule', { id: e.currentTarget.dataset.id });
      this.setData({ scheduleDraft: result.data });
    } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
  },
  closeSchedule() { this.setData({ scheduleDraft: null }); },
  onScheduleField(e) {
    const { day, index, field } = e.currentTarget.dataset;
    this.setData({ [`scheduleDraft.${day}[${index}].${field}`]: e.detail.value });
  },
  onAdminNoteInput(e) { this.setData({ 'scheduleDraft.admin_note': e.detail.value }); },
  addScheduleItem(e) {
    const day = e.currentTarget.dataset.day;
    const list = (this.data.scheduleDraft[day] || []).slice();
    list.push({ song_name: '', singer: '', special_note: '', is_repeat: false, source_week_key: '' });
    this.setData({ [`scheduleDraft.${day}`]: list });
  },
  removeScheduleItem(e) {
    const { day, index } = e.currentTarget.dataset;
    const list = (this.data.scheduleDraft[day] || []).slice();
    list.splice(Number(index), 1);
    this.setData({ [`scheduleDraft.${day}`]: list });
  },
  async saveSchedule() {
    const draft = this.data.scheduleDraft;
    if (!draft) return;
    const days = {};
    ['day1', 'day2', 'day3', 'day4', 'day5'].forEach(day => { days[day] = draft[day] || []; });
    wx.showLoading({ title: '保存中' });
    try {
      const result = await this.call('updateSchedule', {
        id: draft._id, revision: draft.revision, days, adminNote: draft.admin_note || ''
      });
      this.setData({ 'scheduleDraft.revision': result.revision });
      wx.showToast({ title: '排期已保存', icon: 'success' });
    } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
    finally { wx.hideLoading(); }
  },
  withdrawSchedule() {
    const draft = this.data.scheduleDraft;
    if (!draft || draft.status !== 'published') return;
    wx.showModal({
      title: '撤回已发布排期', editable: true, placeholderText: '必须填写撤回原因',
      confirmText: '撤回', confirmColor: '#e53e3e',
      success: async res => {
        if (!res.confirm) return;
        if (!res.content || !res.content.trim()) return wx.showToast({ title: '请填写原因', icon: 'none' });
        try {
          await this.call('withdrawSchedule', { id: draft._id, revision: draft.revision, reason: res.content });
          this.setData({ scheduleDraft: null });
          await this.loadSchedules();
          wx.showToast({ title: '已撤回', icon: 'success' });
        } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
      }
    });
  },

  onEventCategoryChange(e) {
    this.setData({ eventCategoryIndex: Number(e.detail.value) });
    this.loadEvents();
  },
  async loadEvents() {
    const category = this.data.eventCategories[this.data.eventCategoryIndex].value;
    const result = await this.call('listEvents', { category, pageSize: 50 });
    this.setData({ events: (result.data || []).map(displayEvent) });
  },
  toggleEvent(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ [`events[${index}].expanded`]: !this.data.events[index].expanded });
  },

  async loadCounters() {
    const result = await this.call('listCounters');
    this.setData({ counters: result.data || [], counterDetail: null });
  },
  async openCounter(e) {
    try {
      const result = await this.call('getCounterDetail', { weekKey: e.currentTarget.dataset.week });
      this.setData({
        counterDetail: result.data,
        counterCountInput: String(result.data.counter.count || 0),
        counterReason: ''
      });
    } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
  },
  closeCounter() { this.setData({ counterDetail: null }); },
  onCounterCountInput(e) { this.setData({ counterCountInput: e.detail.value }); },
  onCounterReasonInput(e) { this.setData({ counterReason: e.detail.value }); },
  async saveCounter() {
    const detail = this.data.counterDetail;
    if (!detail) return;
    try {
      await this.call('setCounter', {
        weekKey: detail.counter._id,
        count: Number(this.data.counterCountInput),
        reason: this.data.counterReason
      });
      await this.openCounter({ currentTarget: { dataset: { week: detail.counter._id } } });
      wx.showToast({ title: '计数已更新', icon: 'success' });
    } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
  },
  recalculateCounter() {
    const detail = this.data.counterDetail;
    if (!detail) return;
    wx.showModal({ title: '重新计算', content: '将按该周现存且非 removed 的投稿数量覆盖计数器，是否继续？', success: async res => {
      if (!res.confirm) return;
      try {
        await this.call('recalculateCounter', { weekKey: detail.counter._id });
        await this.openCounter({ currentTarget: { dataset: { week: detail.counter._id } } });
        wx.showToast({ title: '已重新计算', icon: 'success' });
      } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
    }});
  }
});
