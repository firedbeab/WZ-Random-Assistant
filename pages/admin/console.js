const feedback = require('../../utils/admin-feedback');
const theme = require('../../utils/theme');
const { cloudCall, isTestMode } = require('../../utils/runtime');

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
  'schedule.remove_items': '删除排期曲目（不补位）',
  'schedule.mark_items_for_removal': '标记待删除曲目',
  'schedule.restore_items': '撤销待删除曲目',
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

function getWeekOptions(centerWeekKey, pastCount = 16, futureCount = 8) {
  const center = new Date(`${centerWeekKey}T00:00:00.000Z`);
  const options = [];
  for (let offset = -futureCount; offset <= pastCount; offset += 1) {
    const sunday = new Date(center.getTime());
    sunday.setUTCDate(center.getUTCDate() - offset * 7);
    const monday = new Date(sunday.getTime());
    monday.setUTCDate(sunday.getUTCDate() - 6);
    const thursday = new Date(monday.getTime());
    thursday.setUTCDate(monday.getUTCDate() + 3);
    const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
    const weekNumber = Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
    const format = date => `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`;
    options.push({
      value: sunday.toISOString().split('T')[0],
      label: `${thursday.getUTCFullYear()} 年第 ${weekNumber} 周（${format(monday)}–${format(sunday)}）`
    });
  }
  return options;
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

Page(theme.page(feedback.page({
  data: {
    isTestMode: isTestMode(),
    mode: 'submissions',
    title: '数据控制台',
    subtitle: MODE_SUBTITLES.submissions,
    loading: false,
    weekKey: getWeekKey(),
    weekOptions: getWeekOptions(getWeekKey()),
    weekIndex: 8,
    keyword: '',
    statusOptions: STATUS_OPTIONS,
    statusIndex: 0,
    submissions: [],
    submissionTotal: 0,
    selectedIds: [],
    selectedFlags: {},
    showSubmissionEditor: false,
    editSubmission: null,
    schedules: [],
    scheduleDraft: null,
    scheduleEditing: false,
    scheduleDirty: false,
    scheduleSaving: false,
    submissionClosing: false,
    dayNames: ['周一', '周二', '周三', '周四', '周五'],
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
    if (this.data.scheduleDirty) {
      wx.stopPullDownRefresh();
      feedback.showToast(this, { title: '请先保存或取消编辑', icon: 'none' });
      return;
    }
    Promise.resolve(this.loadData()).finally(() => wx.stopPullDownRefresh());
  },

  onUnload() { feedback.clear(this); clearTimeout(this._submissionCloseTimer); },
  backToManagement() { this.confirmDiscardSchedule(() => wx.navigateBack()); },
  async openWeekFilter() {
    const result = await feedback.showChoice(this, { title: '选择投稿周次', choices: this.data.weekOptions, selectedIndex: this.data.weekIndex });
    if (result.confirm) this.onWeekChange({ detail: { value: result.index } });
  },
  async openStatusFilter() {
    const result = await feedback.showChoice(this, { title: '选择投稿状态', choices: this.data.statusOptions, selectedIndex: this.data.statusIndex });
    if (result.confirm) this.onStatusChange({ detail: { value: result.index } });
  },
  async openEventFilter() {
    const result = await feedback.showChoice(this, { title: '筛选事件类别', choices: this.data.eventCategories, selectedIndex: this.data.eventCategoryIndex });
    if (result.confirm) this.onEventCategoryChange({ detail: { value: result.index } });
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
      feedback.showToast(this, { title: err.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onWeekChange(e) {
    const weekIndex = Number(e.detail.value);
    const option = this.data.weekOptions[weekIndex];
    if (!option) return;
    this.setData({ weekIndex, weekKey: option.value, selectedIds: [] });
    this.loadSubmissions();
  },
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
      selectedIds: [],
      selectedFlags: {}
    });
  },

  searchSubmissions() { this.loadSubmissions(); },
  onSelectionChange(e) {
    const selectedIds = e.detail.value || [];
    this.setData({ selectedIds, selectedFlags: selectedIds.reduce((flags, id) => { flags[id] = true; return flags; }, {}) });
  },
  toggleSubmissionSelection(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.submissions.find(row => row._id === id);
    if (!item || item.status === 'selected' || item.status === 'rejected') return;
    const selected = this.data.selectedIds.slice(), index = selected.indexOf(id);
    if (index < 0) selected.push(id); else selected.splice(index, 1);
    this.onSelectionChange({ detail: { value: selected } });
  },

  openSubmissionEditor(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.submissions.find(row => row._id === id);
    if (!item) return;
    this.setData({ showSubmissionEditor: true, editSubmission: Object.assign({}, item) });
  },
  closeSubmissionEditor() {
    if (this.data.submissionClosing) return;
    this.setData({ submissionClosing: true });
    this._submissionCloseTimer = setTimeout(() => this.setData({ showSubmissionEditor: false, editSubmission: null, submissionClosing: false }), feedback.DRAWER_CLOSE_MS);
  },
  onSubmissionField(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`editSubmission.${field}`]: e.detail.value });
  },
  async saveSubmission() {
    const item = this.data.editSubmission;
    if (!item) return;
    feedback.showLoading(this, { title: '保存中' });
    try {
      await this.call('updateSubmission', {
        id: item._id, songName: item.song_name,
        singer: item.singer, specialNote: item.special_note || ''
      });
      this.closeSubmissionEditor();
      await this.loadSubmissions();
      feedback.showToast(this, { title: '已保存', icon: 'success' });
    } catch (err) {
      feedback.showToast(this, { title: err.message, icon: 'none' });
    } finally { feedback.hideLoading(this); }
  },

  removeSelected() {
    const ids = this.data.selectedIds;
    if (!ids.length) return feedback.showToast(this, { title: '请先选择投稿', icon: 'none' });
    feedback.showModal(this, {
      title: `移除 ${ids.length} 条投稿`, editable: true,
      placeholderText: '必须填写移除原因', confirmText: '移除', confirmColor: theme.getNativeColors().danger,
      success: async res => {
        if (!res.confirm) return;
        if (!res.content || !res.content.trim()) return feedback.showToast(this, { title: '请填写原因', icon: 'none' });
        feedback.showLoading(this, { title: '处理中' });
        try {
          const result = await this.call('removeSubmissions', { ids, reason: res.content });
          await this.loadSubmissions();
          feedback.showToast(this, { title: result.message, icon: 'success' });
        } catch (err) { feedback.showToast(this, { title: err.message, icon: 'none' }); }
        finally { feedback.hideLoading(this); }
      }
    });
  },

  restoreSubmission(e) {
    const id = e.currentTarget.dataset.id;
    feedback.showModal(this, { title: '恢复投稿', content: '恢复后会同步增加该周计数，确定继续吗？', success: async res => {
      if (!res.confirm) return;
      try {
        await this.call('restoreSubmission', { id });
        await this.loadSubmissions();
        feedback.showToast(this, { title: '已恢复', icon: 'success' });
      } catch (err) { feedback.showToast(this, { title: err.message, icon: 'none' }); }
    }});
  },

  async loadSchedules() {
    const result = await this.call('listSchedules');
    this.setData({ schedules: result.data || [], scheduleDraft: null, scheduleEditing: false, scheduleDirty: false });
  },
  async openSchedule(e) {
    try {
      const result = await this.call('getSchedule', { id: e.currentTarget.dataset.id });
      this._savedSchedule = JSON.parse(JSON.stringify(result.data));
      this.setData({ scheduleDraft: result.data, scheduleEditing: false, scheduleDirty: false });
    } catch (err) { feedback.showToast(this, { title: err.message, icon: 'none' }); }
  },
  confirmDiscardSchedule(continueAction) {
    if (this.data.scheduleSaving) return;
    const discard = () => {
      this.setData({ scheduleDirty: false });
      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
      continueAction();
    };
    if (!this.data.scheduleDirty) return discard();
    feedback.showModal(this, { title: '放弃未保存修改？', content: '本次修改尚未保存。', confirmText: '放弃修改', success: result => { if (result.confirm) discard(); } });
  },
  closeSchedule() { this.confirmDiscardSchedule(() => this.setData({ scheduleDraft: null, scheduleEditing: false })); },
  startScheduleEdit() {
    this.setData({ scheduleEditing: true });
  },
  cancelScheduleEdit() {
    this.confirmDiscardSchedule(() => this.setData({ scheduleDraft: JSON.parse(JSON.stringify(this._savedSchedule)), scheduleEditing: false }));
  },
  markScheduleDirty() {
    if (!this.data.scheduleDirty && wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({ message: '排期修改尚未保存，确定离开吗？' });
    this.setData({ scheduleDirty: true });
  },
  onScheduleField(e) {
    if (this.data.scheduleSaving) return;
    this.markScheduleDirty();
    const { day, index, field } = e.currentTarget.dataset;
    this.setData({ [`scheduleDraft.${day}[${index}].${field}`]: e.detail.value });
  },
  onAdminNoteInput(e) { if (this.data.scheduleSaving) return; this.markScheduleDirty(); this.setData({ 'scheduleDraft.admin_note': e.detail.value }); },
  addScheduleItem(e) {
    if (this.data.scheduleSaving) return;
    this.markScheduleDirty();
    const day = e.currentTarget.dataset.day;
    const list = (this.data.scheduleDraft[day] || []).slice();
    list.push({ song_name: '', singer: '', special_note: '', is_repeat: false, source_week_key: '' });
    this.setData({ [`scheduleDraft.${day}`]: list });
  },
  removeScheduleItem(e) {
    if (this.data.scheduleSaving) return;
    this.markScheduleDirty();
    const { day, index } = e.currentTarget.dataset;
    const list = (this.data.scheduleDraft[day] || []).slice();
    list.splice(Number(index), 1);
    this.setData({ [`scheduleDraft.${day}`]: list });
  },
  async saveSchedule() {
    const draft = this.data.scheduleDraft;
    if (!draft || this.data.scheduleSaving) return;
    const days = {};
    ['day1', 'day2', 'day3', 'day4', 'day5'].forEach(day => { days[day] = draft[day] || []; });
    this.setData({ scheduleSaving: true });
    feedback.showLoading(this, { title: '保存中' });
    try {
      const result = await this.call('updateSchedule', {
        id: draft._id, revision: draft.revision, days, adminNote: draft.admin_note || ''
      });
      this.setData({ 'scheduleDraft.revision': result.revision, scheduleEditing: false, scheduleDirty: false });
      this._savedSchedule = JSON.parse(JSON.stringify(this.data.scheduleDraft));
      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
      feedback.showToast(this, { title: '排期已保存', icon: 'success' });
    } catch (err) { feedback.showToast(this, { title: err.message, icon: 'none' }); }
    finally { this.setData({ scheduleSaving: false }); feedback.hideLoading(this); }
  },
  withdrawSchedule() {
    const draft = this.data.scheduleDraft;
    if (!draft || draft.status !== 'published') return;
    feedback.showModal(this, {
      title: '撤回已发布排期', editable: true, placeholderText: '必须填写撤回原因',
      confirmText: '撤回', confirmColor: theme.getNativeColors().danger,
      success: async res => {
        if (!res.confirm) return;
        if (!res.content || !res.content.trim()) return feedback.showToast(this, { title: '请填写原因', icon: 'none' });
        try {
          await this.call('withdrawSchedule', { id: draft._id, revision: draft.revision, reason: res.content });
          this.setData({ scheduleDraft: null });
          await this.loadSchedules();
          feedback.showToast(this, { title: '已撤回', icon: 'success' });
        } catch (err) { feedback.showToast(this, { title: err.message, icon: 'none' }); }
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
    } catch (err) { feedback.showToast(this, { title: err.message, icon: 'none' }); }
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
      feedback.showToast(this, { title: '计数已更新', icon: 'success' });
    } catch (err) { feedback.showToast(this, { title: err.message, icon: 'none' }); }
  },
  recalculateCounter() {
    const detail = this.data.counterDetail;
    if (!detail) return;
    feedback.showModal(this, { title: '重新计算', content: '将按该周现存且非 removed 的投稿数量覆盖计数器，是否继续？', success: async res => {
      if (!res.confirm) return;
      try {
        await this.call('recalculateCounter', { weekKey: detail.counter._id });
        await this.openCounter({ currentTarget: { dataset: { week: detail.counter._id } } });
        feedback.showToast(this, { title: '已重新计算', icon: 'success' });
      } catch (err) { feedback.showToast(this, { title: err.message, icon: 'none' }); }
    }});
  }
})));
