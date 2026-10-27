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
      if (name.includes('admin-feedback')) return { ...require('../../utils/admin-feedback'),
        showModal: async (page, options) => { api.modal = options; return { confirm: api.confirm, content: api.content || '' }; } };
      if (name.includes('theme')) return { page: value => value, getNativeColors: () => ({ accent: '#287e56', danger: '#a00' }) };
      if (name.includes('easter-egg-photos')) return { DEFAULT_TOP: '默认上方', DEFAULT_BOTTOM: '默认下方' };
      if (name.includes('runtime')) return { isTestMode: () => true, collectionName: name => name, storageKey: name => name,
        cloudCall: async request => { calls.push(request); return { result: api.handler ? await api.handler(request) : api.response }; } };
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

test('发布按钮只打开真实摘要抽屉，确认前不发出请求', () => {
  const p = page('admin.js'), a = p.instance;
  a.setData({ schedule: { _id: 'schedule', revision: 6 }, note: '说明', dayCounts: [{ active: 4 }, { active: 0 }, { active: 2 }], activeSongCount: 6 });
  a.onPublish(); assert.equal(p.calls.length, 0); assert.equal(a.data.showPublishDrawer, true);
  assert.equal(a.data.publishDayCount, 2); assert.equal(a.data.publishNoteValid, true);
  a.closePublishDrawer(); p.flush(); assert.equal(a.data.showPublishDrawer, false); assert.equal(a.data.note, '说明');
});

test('发布表单用提交时的最新说明，复用原ID/revision并防重复', async () => {
  const p = page('admin.js'), a = p.instance;
  a.setData({ schedule: { _id: 's', revision: 8 }, dayCounts: [{ active: 2 }], activeSongCount: 2, note: '旧输入' });
  a.onPublish(); const pending = a.confirmPublish({ detail: { value: { publishNote: '最新表单说明' } } });
  await a.confirmPublish({ detail: { value: { publishNote: '重复点击' } } }); await pending;
  assert.equal(p.calls.length, 1); const request = p.calls[0];
  assert.equal(request.name, 'adminAuditPlaylist'); assert.equal(request.data.action, 'publish');
  assert.equal(request.data.playlistId, 's'); assert.equal(request.data.revision, 8); assert.equal(request.data.note, '最新表单说明');
  assert.equal(a.data.showPublishDrawer, false); assert.equal(a.data.publishing, false);
});

test('空歌单说明必填、过长说明和变化后的排期不能直接发布', async () => {
  const p = page('admin.js'), a = p.instance;
  a.setData({ schedule: { _id: 's', revision: 1 }, dayCounts: [], activeSongCount: 0 }); a.onPublish();
  await a.confirmPublish({ detail: { value: { publishNote: '  ' } } }); assert.match(a.data.publishError, /填写/);
  await a.confirmPublish({ detail: { value: { publishNote: '长'.repeat(101) } } }); assert.match(a.data.publishError, /100/);
  a.setData({ 'schedule.revision': 2 });
  await a.confirmPublish({ detail: { value: { publishNote: '空排期原因' } } }); assert.match(a.data.publishError, /变化/); assert.equal(p.calls.length, 0);
});

test('发布失败保持抽屉和说明，过期时刷新而不以旧版本重试', async () => {
  const p = page('admin.js'), a = p.instance;
  a.setData({ schedule: { _id: 's', revision: 2 }, dayCounts: [{ active: 1 }], activeSongCount: 1 }); a.onPublish();
  p.api.response = { success: false, message: '暂不可发布' }; await a.confirmPublish({ detail: { value: { publishNote: '保留说明' } } });
  assert.equal(a.data.showPublishDrawer, true); assert.equal(a.data.note, '保留说明'); assert.equal(a.data.publishing, false);
  p.api.response = { success: false, message: '版本已过期' }; await a.confirmPublish();
  assert.equal(a.data.showPublishDrawer, false); assert.equal(p.calls.at(-1).data.action, 'getPending');
});

test('底部批量入口直接进入跨日勾选，取消退出并清除选择', () => {
  const p = page('admin.js'), a = p.instance;
  a.setData({ schedule: { _id: 's', day1: [{ song_name: 'A' }], day2: [{ song_name: 'B' }] }, dayCounts: [{ active: 1 }, { active: 1 }] });
  a.openBatchRemoval(); assert.equal(a.data.batchMode, true); assert.equal(a.data.showBatchDrawer, false);
  a.toggleAuditSong(event({ day: 0, songIndex: 0 })); assert.equal(a.data.auditSelections.day0.length, 1);
  a.toggleAuditSong(event({ day: 1, songIndex: 0 })); assert.equal(a.data.auditChecked.day1[0], true);
  a.toggleAuditSong(event({ day: 1, songIndex: 0 })); assert.equal(a.data.auditSelections.day1.length, 0);
  assert.equal(a.data.batchSelectedCount, 1);
  a.openBatchRemoval(); assert.equal(a.data.batchMode, false); assert.equal(a.data.batchSelectedCount, 0);
});

test('曲目抽屉关闭后再调用原备注/异常方法，保留索引0', () => {
  for (const action of ['note', 'exception', 'remove']) {
    const p = page('admin.js'), a = p.instance, song = { song_name: '示例', special_note: '备注' }; let received;
    a.onOpenNote = a.onException = a.onRemoveSelectedFromDay = e => { received = e.currentTarget.dataset; };
    a.openSongActions(event({ song, day: 0, songIndex: 0 })); a.onSongDrawerAction(event({ action }));
    assert.equal(received, undefined); p.flush(); assert.equal(a.data.showSongDrawer, false);
    assert.equal(received.day, 0); assert.equal(received.songIndex, 0); assert.equal(received.song.song_name, '示例');
    if (action === 'remove') assert.equal(a.data.auditSelections.day0[0], '0');
  }
});

test('投稿自绘勾选保留状态限制与查询后的清除行为', async () => {
  const p = page('console.js'), a = p.instance;
  a.setData({ submissions: [{ _id: 'p', status: 'pending' }, { _id: 's', status: 'selected' }, { _id: 'r', status: 'rejected' }] });
  a.toggleSubmissionSelection(event({ id: 's' })); a.toggleSubmissionSelection(event({ id: 'r' })); assert.equal(a.data.selectedIds.length, 0);
  a.toggleSubmissionSelection(event({ id: 'p' })); assert.equal(a.data.selectedFlags.p, true);
  a.toggleSubmissionSelection(event({ id: 'p' })); assert.equal(a.data.selectedIds.length, 0);
  a.toggleSubmissionSelection(event({ id: 'p' })); p.api.response = { success: true, data: [] }; await a.loadSubmissions();
  assert.equal(a.data.selectedIds.length, 0); assert.equal(Object.keys(a.data.selectedFlags).length, 0);
});

test('跨日批量按原单日接口串行提交、推进revision并回读', async () => {
  const p = page('admin.js'), a = p.instance;
  const schedule = { _id: 's', revision: 3, day1: [{ song_name: 'A' }], day2: [{ song_name: 'B' }] };
  a.setData({ schedule }); a.openBatchRemoval();
  for (const day of [0,1]) a.toggleAuditSong(event({ day, songIndex: 0 }));
  a.openBulkConfirm(); assert.equal(p.calls.length, 0);
  p.api.handler = request => request.data.action === 'getPending' ? { success: true, data: { ...schedule, revision: 5 } } : { success: true };
  await a.confirmBulkRemoval({ detail: { value: { removalReason: '活动安排' } } });
  assert.equal(p.calls[0].data.dayIndex, 0); assert.equal(p.calls[0].data.revision, 3);
  assert.equal(p.calls[1].data.dayIndex, 1); assert.equal(p.calls[1].data.revision, 4);
  for (const call of p.calls.slice(0,2)) { assert.equal(call.data.action, 'removeItems'); assert.equal(call.data.songIndexes[0], 0); assert.equal(call.data.reason, '活动安排'); }
  assert.equal(p.calls.at(-1).data.action, 'getPending'); assert.equal(a.data.batchMode, false); assert.match(a.data.batchResultMessage, /2 首/);
});

test('批量部分失败立即停止，不跳过失败继续操作其它日期', async () => {
  const p = page('admin.js'), a = p.instance;
  const schedule = { _id: 's', revision: 1, day1: [{ song_name: 'A' }], day2: [{ song_name: 'B' }], day3: [{ song_name: 'C' }] };
  a.setData({ schedule }); a.openBatchRemoval(); for (const day of [0,1,2]) a.toggleAuditSong(event({ day, songIndex: 0 })); a.openBulkConfirm();
  p.api.handler = request => request.data.action === 'getPending' ? { success: true, data: schedule } : request.data.dayIndex === 1 ? { success: false, message: '版本过期' } : { success: true };
  await a.confirmBulkRemoval();
  assert.equal(p.calls.filter(call => call.data.action === 'removeItems').length, 2); assert.equal(a.data.batchRemoving, false);
  assert.match(a.data.batchResultMessage, /已确认标记 1 首/); assert.match(a.data.batchResultMessage, /未确认/);
});

function swipe(a, from, to, duration = 200) {
  a.onAdminTouchStart({ touches: [{ clientX: from[0], clientY: from[1] }], timeStamp: 0 });
  a.onAdminTouchEnd({ changedTouches: [{ clientX: to[0], clientY: to[1] }], timeStamp: duration });
}
test('后台主标签支持左右滑动，按权限选择可见标签且两端不循环', () => {
  const a = page('admin.js').instance; a.loadTabData = () => {};
  swipe(a, [200,200], [80,202]); assert.equal(a.data.currentTab, 'codes');
  swipe(a, [200,200], [80,202]); assert.equal(a.data.currentTab, 'codes');
  swipe(a, [80,200], [200,202]); assert.equal(a.data.currentTab, 'audit');
  a.setData({ isTestEnv: true, isSuperAdmin: true, currentTab: 'test' }); swipe(a, [200,200], [80,202]); assert.equal(a.data.currentTab, 'manage');
});
test('纵向、左缘返回、长按、多指及批量勾选不触发切页', () => {
  const a = page('admin.js').instance; a.loadTabData = () => {};
  for (const [from,to,time] of [[[10,100],[200,100],200], [[200,100],[190,200],200], [[200,100],[80,100],900]]) swipe(a,from,to,time);
  assert.equal(a.data.currentTab, 'audit');
  a.onAdminTouchStart({ touches: [{ clientX: 200, clientY: 100 }], timeStamp: 0 });
  a.onAdminTouchMove({ touches: [{ clientX: 190, clientY: 160 }] });
  a.onAdminTouchEnd({ changedTouches: [{ clientX: 80, clientY: 100 }], timeStamp: 200 }); assert.equal(a.data.currentTab, 'audit');
  a.onAdminTouchStart({ touches: [{ clientX: 200, clientY: 100 }, { clientX: 210, clientY: 100 }], timeStamp: 0 }); assert.equal(a._adminTouch, null);
  a.setData({ batchMode: true }); swipe(a,[200,100],[80,100]); assert.equal(a.data.currentTab, 'audit');
});

test('彩蛋管理并行读取身份与配置，身份通过前不展示配置', async () => {
  const p=page('easter-eggs.js'),a=p.instance;let userDone,configDone;
  p.api.handler=request=>new Promise(resolve=>{if(request.name==='getUserInfo')userDone=resolve;else configDone=resolve;});
  const pending=a.onLoad();assert.equal(p.calls.length,2);assert.equal(a.data.allowed,false);
  configDone({success:true,data:{revision:3,entries:[{id:'photo',topText:'照片文案',enabled:true}]}});
  await Promise.resolve();assert.equal(a.data.entries.length,0);
  userDone({success:true,data:{role:'superadmin'}});await pending;assert.equal(a.data.allowed,true);assert.equal(a.data.entries.length,1);assert.equal(a.data.loading,false);assert.equal(p.calls.length,2);
});

test('清理确认仍要求精确口令并传递原服务端一次性令牌', async () => {
  const p=page('admin.js'),a=p.instance;
  p.api.handler=request=>request.data.action==='previewCleanup'?{success:true,preview:{total:1,submissions:1},confirmationText:'清空本周',confirmationToken:'fixture-token'}:{success:true,data:{total:{}}};
  await a.requestCleanupConfirmation('week');const first=p.api.modal;await first.success({confirm:true,content:'错误口令'});
  assert.equal(p.calls.filter(call=>call.data.action==='clearWeek').length,0);
  await a.requestCleanupConfirmation('week');await p.api.modal.success({confirm:true,content:'清空本周'});
  const request=p.calls.find(call=>call.data.action==='clearWeek');assert.equal(request.name,'testTool');assert.equal(request.data.confirmationToken,'fixture-token');assert.equal(request.data.confirmationText,'清空本周');
});
