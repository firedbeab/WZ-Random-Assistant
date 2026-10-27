const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function page(file) {
  const calls = [], timers = new Map(); let definition, nextTimer = 0;
  const api = { response: { success: true, data: {} }, confirm: true };
  const wx = {
    showModal: async options => { api.modal = options; return { confirm: api.confirm }; },
    showToast() {}, showLoading() {}, hideLoading() {}, stopPullDownRefresh() {},
    enableAlertBeforeUnload() { api.leaveGuard = true; }, disableAlertBeforeUnload() { api.leaveGuard = false; },
    navigateTo() {}, navigateBack() {}, setNavigationBarTitle() {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../pages/admin', file), 'utf8'), {
    Page(value) { definition = value; }, wx, console: { warn() {} },
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    require(name) {
      if (name.includes('theme')) return { page: value => value, getNativeColors: () => ({ accent: '#287e56', danger: '#a00' }) };
      if (name.includes('runtime')) return { isTestMode: () => true, collectionName: name => name, storageKey: name => name,
        cloudCall: async request => { calls.push(request); return { result: api.response }; } };
      throw new Error(name);
    }
  });
  const instance = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const keys = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let target = this.data;
      for (const part of keys.slice(0, -1)) target = target[part] || (target[part] = {});
      target[keys.at(-1)] = value;
    }
  } };
  return { instance, api, wx, calls, flush() { while (timers.size) { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); } } };
}
const event = dataset => ({ currentTarget: { dataset } });

test('后台切页同步响应，不等待动画定时器，角色保护与卸载保持', () => {
  const p = page('admin.js'), a = p.instance, loaded = [];
  a.loadTabData = tab => loaded.push(tab); a.setData({ isSuperAdmin: true, isTestEnv: true });
  a.switchTab(event({ tab: 'codes' })); assert.equal(a.data.currentTab, 'codes');
  a.switchTab(event({ tab: 'manage' })); assert.equal(a.data.currentTab, 'manage'); p.flush();
  assert.deepEqual(loaded, ['codes', 'manage']); assert.equal(a.data.panelVisible, true);
  a.switchTab(event({ tab: 'codes' })); a.switchTab(event({ tab: 'manage' })); p.flush();
  assert.equal(a.data.currentTab, 'manage'); assert.equal(loaded.length, 4);
  a.setData({ isSuperAdmin: false }); a.switchTab(event({ tab: 'data' })); p.flush(); assert.equal(a.data.currentTab, 'manage');
  a.switchTab(event({ tab: 'codes' })); a.onUnload(); p.flush(); assert.equal(a.data.currentTab, 'codes');
});

test('审核选择仅保留当前一天，索引0可选，换天/退出清除旧勾选', () => {
  const a = page('admin.js').instance;
  a.toggleAuditDay(event({ day: 0 }));
  a.onAuditSelectionChange({ ...event({ day: 0 }), detail: { value: ['0', '2'] } });
  assert.equal(a.data.auditChecked.day0[0], true);
  a.toggleAuditDay(event({ day: 1 })); assert.equal(a.data.bulkDay, 1); assert.equal(a.data.auditSelections.day0.length, 0);
  a.toggleAuditDay(event({ day: 1 })); assert.equal(a.data.bulkDay, -1);
});

test('通道切换取消不写入，确认后复用原参数，忙碌时拒绝重复请求', async () => {
  const p = page('admin.js'), a = p.instance;
  a.setData({ isTestEnv: true, channelMode: 'normal' }); p.api.confirm = false;
  await a.onToggleChannel(event({ mode: 'open' })); assert.equal(p.calls.length, 0); assert.equal(a.data.channelBusy, false);
  p.api.confirm = true; p.api.response = { success: true, forceOpen: true };
  const first = a.onToggleChannel(event({ mode: 'open' }));
  await a.onToggleChannel(event({ mode: 'close' })); await first;
  assert.equal(p.calls.length, 2); assert.equal(p.calls[0].name, 'testTool');
  assert.equal(p.calls[0].data.action, 'toggleChannel'); assert.equal(p.calls[0].data.mode, 'open');
  assert.equal(a.data.channelMode, 'open'); assert.equal(a.data.channelBusy, false);
  await a.onToggleChannel(event({ mode: 'invalid' })); assert.equal(p.calls.length, 2);
});

test('通道读取失败显示未知，不能伪装正常或继续调整', async () => {
  const p = page('admin.js'), a = p.instance;
  a.setData({ isTestEnv: true, channelMode: 'normal' }); p.api.response = { success: false };
  await a.loadChannelStatus(); assert.equal(a.data.channelMode, ''); assert.equal(a.data.channelLoading, false);
  await a.onToggleChannel(event({ mode: 'close' })); assert.equal(p.calls.length, 1);
});

test('审核区分暂无排期和读取失败，曲目数量排除待移除项', async () => {
  const p = page('admin.js'), a = p.instance;
  p.api.response = { success: false, message: '暂无待审核排期' }; await a.loadPlaylist(false);
  assert.equal(a.data.schedule, null); assert.equal(a.data.auditError, '');
  p.api.response = { success: false, message: '查询失败' }; await a.loadPlaylist(false); assert.equal(a.data.auditError, '查询失败');
  p.api.response = { success: true, data: { week_key: '2026-10-25', day1: [{ song_name: 'A' }, { audit_state: 'pending_remove' }] } };
  await a.loadPlaylist(false); assert.equal(a.data.activeSongCount, 1); assert.equal(a.data.pendingRemovalCount, 1); assert.equal(a.data.auditError, '');
});

test('排期默认只读，取消编辑需确认且恢复已保存副本，刷新不丢弃输入', async () => {
  const p = page('console.js'), a = p.instance;
  p.api.response = { success: true, data: { _id: 'schedule', revision: 3, day1: [{ song_name: '原曲', singer: '歌手' }] } };
  await a.openSchedule(event({ id: 'schedule' })); assert.equal(a.data.scheduleEditing, false);
  a.startScheduleEdit(); a.onScheduleField({ ...event({ day: 'day1', index: 0, field: 'song_name' }), detail: { value: '修改' } });
  assert.equal(p.api.leaveGuard, true); a.cancelScheduleEdit(); assert.equal(a.data.scheduleDraft.day1[0].song_name, '修改');
  p.api.modal.success({ confirm: false }); assert.equal(a.data.scheduleEditing, true);
  a.onPullDownRefresh(); assert.equal(p.calls.length, 1);
  a.cancelScheduleEdit(); p.api.modal.success({ confirm: true });
  assert.equal(a.data.scheduleDraft.day1[0].song_name, '原曲'); assert.equal(a.data.scheduleEditing, false); assert.equal(p.api.leaveGuard, false);
});

test('排期保存保留原revision/五日参数，失败保留草稿，成功才退出编辑', async () => {
  const p = page('console.js'), a = p.instance;
  a.setData({ scheduleDraft: { _id: 's1', revision: 7, day1: [{ song_name: '曲目', singer: '歌手' }], admin_note: '说明' }, scheduleEditing: true, scheduleDirty: true });
  p.api.response = { success: false, message: '版本过期' }; await a.saveSchedule();
  assert.equal(a.data.scheduleEditing, true); assert.equal(a.data.scheduleDirty, true); assert.equal(a.data.scheduleSaving, false);
  const request = p.calls[0]; assert.equal(request.name, 'superAdminConsole'); assert.equal(request.data.action, 'updateSchedule');
  assert.equal(request.data.revision, 7); assert.equal(request.data.adminNote, '说明'); assert.equal(Object.keys(request.data.days).length, 5);
  p.api.response = { success: true, revision: 8 }; await a.saveSchedule();
  assert.equal(a.data.scheduleDraft.revision, 8); assert.equal(a.data.scheduleEditing, false); assert.equal(a.data.scheduleDirty, false);
});
