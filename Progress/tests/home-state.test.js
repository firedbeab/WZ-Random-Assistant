const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const presentation = require('../../utils/home-presentation');
const root = path.resolve(__dirname, '../..');

// 展示方法接收已偏移到北京时间的 Date，使用 UTC getter。
const bj = value => new Date(`${value}Z`);
test('圆点行只表达通道状态，已提交与发布结果不混入通道提示', () => {
  const markup = fs.readFileSync(path.join(root, 'pages/index/index.wxml'), 'utf8');
  const statusRow = markup.match(/<view class="status-row">([\s\S]*?)<\/view>/)[1];
  const expression = statusRow.match(/<text>{{([\s\S]*?)}}<\/text>/)[1];
  const dotExpression = statusRow.match(/class="status-dot {{([\s\S]*?)}}"/)[1];
  for (const canSubmit of [false, true]) {
    for (const hasSubmitted of [false, true]) {
      for (const schedulePublished of [false, true]) {
        const context = { canSubmit, hasSubmitted, schedulePublished };
        const open = canSubmit && !schedulePublished;
        assert.equal(vm.runInNewContext(expression, context), open ? '点歌通道开放中' : '点歌通道已关闭');
        assert.equal(vm.runInNewContext(dotExpression, context), open ? 'is-active' : '');
      }
    }
  }
});
test('下次开放跨周、跨年、开放前及强制关闭文案', () => {
  assert.equal(presentation.nextOpenText(bj('2026-10-25T07:59:00')), '10 月 25 日 周日 8:00');
  assert.equal(presentation.nextOpenText(bj('2026-10-25T20:00:00')), '11 月 1 日 周日 8:00');
  assert.equal(presentation.nextOpenText(bj('2026-10-26T09:00:00')), '11 月 1 日 周日 8:00');
  assert.equal(presentation.nextOpenText(bj('2026-12-31T09:00:00')), '1 月 3 日 周日 8:00');
  assert.equal(presentation.nextOpenText(bj('2026-10-26T09:00:00'), true), '通道暂时关闭，恢复时间待定');
});
test('剩余时间在最后一分钟准确，不在窗口内伪造倒计时', () => {
  assert.equal(presentation.hoursLeftText(bj('2026-10-25T08:00:00')), '还剩 12 小时');
  assert.equal(presentation.hoursLeftText(bj('2026-10-25T19:59:00')), '还剩 1 分钟');
  assert.equal(presentation.hoursLeftText(bj('2026-10-25T20:00:00')), '');
  assert.equal(presentation.hoursLeftText(bj('2026-10-26T10:00:00')), '');
});
test('预览按播出日排序，最多三首，总数不硬编码，空排期保留说明', () => {
  const schedule = { week_key: '2026-10-25', day1: [{ song_name: '甲', singer: 'A' }, null], day2: [{ song_name: '乙' }, { song_name: '丙' }], day5: [{ song_name: '丁' }] };
  const preview = presentation.schedulePreview(schedule);
  assert.equal(preview.previewTotal, 4);
  assert.deepEqual(preview.previewSongs.map(s => s.title), ['甲', '乙', '丙']);
  assert.equal(preview.previewSongs[1].day, '周二');
  assert.equal(preview.previewWeekText, '2026.10.25');
  assert.equal(presentation.schedulePreview({ admin_note: '本周暂停播出' }).previewNote, '本周暂停播出');
  assert.equal(presentation.schedulePreview(null).previewTotal, 0);
});

function fixture(options = {}) {
  let page;
  const calls = [], routes = [], disk = new Map();
  const FixedDate = class extends Date { constructor(...args) { super(...(args.length ? args : [options.now || '2026-10-25T04:00:00Z'])); } };
  const runtime = {
    isTestMode: () => options.prod !== true, storageKey: key => `${options.prod ? 'prod' : 'test'}_${key}`,
    collectionName: key => key,
    async cloudCall(request) {
      calls.push(request);
      if (options.call) return options.call(request);
      if (request.data && request.data.action === 'getPublishedSchedule') {
        if (options.readFails) return { result: { success: false } };
        return { result: { success: true, data: options.schedule || null } };
      }
      if (request.name === 'checkWeeklyCode') return { result: { success: true, totalSubmissions: 12 } };
      return { result: { success: true, data: null } };
    }
  };
  const wx = {
    getStorageSync: key => disk.get(key), removeStorageSync: key => disk.delete(key), setStorageSync: (key, value) => disk.set(key, value),
    navigateTo: route => routes.push(route.url), showToast() {}, stopPullDownRefresh() {},
    cloud: { database() { return { collection() { const query = { where() { return query; }, limit() { return query; }, async get() { return { data: options.schedule ? [options.schedule] : [] }; } }; return query; } }; } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/index/index.js'), 'utf8'), {
    Page: value => { page = value; }, Date: FixedDate, wx, console,
    getApp: () => ({ globalData: { userInfo: { openid: 'fixture-user' } } }),
    setTimeout: () => 1, clearTimeout() {},
    require: name => name.endsWith('/runtime') ? runtime : name.endsWith('/home-presentation') ? presentation : {}
  });
  page.data = structuredClone(page.data);
  page.data.userInfo = { openid: 'fixture-user', ...options.userInfo };
  page.setData = patch => Object.assign(page.data, patch);
  return { page, calls, routes, disk };
}
test('开放、已提交缓存及发布预览均能完成状态检查', async () => {
  const open = fixture();
  await open.page.checkTimeAndSubmission();
  assert.equal(open.page.data.canSubmit, true);
  assert.equal(open.page.data.statusReady, true);
  const cached = fixture();
  cached.disk.set('test_last_submission', { week_key: '2026-10-25', song_name: '稻香', remark: '周杰伦' });
  await cached.page.checkTimeAndSubmission();
  assert.equal(cached.page.data.hasSubmitted, true);
  assert.equal(cached.page.data.submittedInfo, '《稻香》- 周杰伦');
  for (const prod of [false, true]) {
    const published = fixture({ prod, schedule: { week_key: '2026-10-25', day1: [{ song_name: '稻香', singer: '周杰伦' }] } });
    await published.page.checkTimeAndSubmission();
    assert.equal(published.page.data.schedulePublished, true);
    assert.equal(published.page.data.previewSongs[0].title, '稻香');
    assert.equal(published.page.data.hasSubmitted, false);
  }
});
test('强制开关优先级不变，关闭文案不承诺管理员恢复日期', async () => {
  const closed = fixture({ userInfo: { channelForceClose: true, channelForceOpen: true } });
  await closed.page.checkTimeAndSubmission();
  assert.equal(closed.page.data.canSubmit, false);
  assert.equal(closed.page.data.channelForceClosed, true);
  assert.match(closed.page.data.nextOpenText, /恢复时间待定/);
  const opened = fixture({ now: '2026-10-26T04:00:00Z', userInfo: { channelForceOpen: true } });
  await opened.page.checkTimeAndSubmission();
  assert.equal(opened.page.data.canSubmit, true);
  assert.equal(opened.page.data.hoursLeftText, '');
});
test('排期读取失败与未发布区分，清除旧预览', async () => {
  const { page } = fixture({ readFails: true });
  page.setData({ schedulePublished: true, previewSongs: [{ title: '旧歌' }] });
  await page.checkTimeAndSubmission();
  assert.equal(page.data.scheduleLoadFailed, true);
  assert.equal(page.data.schedulePublished, false);
  assert.equal(page.data.previewSongs.length, 0);
  assert.equal(page.data.statusReady, true);
});
test('迟到的状态响应不能清除新状态或本地投稿缓存', async () => {
  let resolve;
  const { page, disk } = fixture({ call: () => new Promise(done => { resolve = done; }) });
  const pending = page.checkTimeAndSubmission();
  disk.set('test_last_submission', { song_name: '新投稿' });
  page._statusToken++;
  page.setData({ hasSubmitted: true, submittedInfo: '新投稿' });
  resolve({ result: { success: true, data: { day1: [] } } });
  await pending;
  assert.equal(page.data.hasSubmitted, true);
  assert.ok(disk.has('test_last_submission'));
});
test('输入焦点竞争、说明/往期入口及原提交字段契约', async () => {
  const { page, routes, calls, disk } = fixture();
  page.onFieldFocus({ currentTarget: { dataset: { field: 'title' } } });
  page.onFieldBlur({ currentTarget: { dataset: { field: 'weeklyCode' } } });
  assert.equal(page.data.focusedField, 'title');
  page.onFieldBlur({ currentTarget: { dataset: { field: 'title' } } });
  assert.equal(page.data.focusedField, '');
  page.goHelp(); page.goAbout(); page.goHistory(); page.goPlaylist();
  assert.deepEqual(routes, ['/pages/help/index', '/pages/about/index', '/pages/playlist/index?tab=1', '/pages/playlist/index']);
  page.setData({ weeklyCode: 'fixture-code', title: '稻香', remark: '周杰伦', specialNote: '现场版' });
  await page.submitRequest();
  const sent = calls.find(c => c.name === 'checkWeeklyCode').data;
  assert.equal(sent.title, '稻香'); assert.equal(sent.remark, '周杰伦'); assert.equal(sent.specialNote, '现场版');
  assert.equal(page.data.hasSubmitted, true); assert.equal(page.data.loading, false);
  assert.equal(disk.get('test_last_submission').song_name, '稻香');
});
test('往期入口参数有边界，默认仍展示最新一期', () => {
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/playlist/index.js'), 'utf8'), { Page: value => { definition = value; }, require: name => name.endsWith('/playlist-presentation') ? require('../../utils/playlist-presentation') : ({ isTestMode: () => true }) });
  for (const [tab, expected] of [[undefined, 0], ['1', 1], ['2', 2], ['-1', 0], ['100', 0]]) {
    const page = { data: {}, setData(patch) { Object.assign(this.data, patch); }, loadWeekPlaylist(offset) { this.loaded = offset; }, checkSubStatus() {} };
    definition.onLoad.call(page, { tab });
    assert.equal(page.loaded, expected); assert.equal(page.data.activeTab, expected);
  }
});
