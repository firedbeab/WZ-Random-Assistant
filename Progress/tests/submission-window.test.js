const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const presentation = require('../../utils/home-presentation');

// Execute the real cloud entry point with a controlled clock and database.
// No production writes or client-supplied clock are involved.
function fixture(time, override = {}) {
  const clock = { now: Date.parse(time) };
  const state = { openid: 'owner', commits: 0, safety: 0, rows: new Map([
    ['configs', [{ _id: 'channel_override', ...override }]],
    ['weekly_codes', [{ _id: 'code', code: 'VALID1', is_published: true, expire_date: '2027-12-31' }]]
  ]) };
  const FixedDate = class extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  };
  const db = {
    command: { inc: n => ({ increment: n }) }, serverDate: () => new Date(clock.now),
    collection(name) {
      let filter = {}, cap = Infinity;
      const rows = () => (state.rows.get(name) || []).filter(row => Object.entries(filter).every(([k, v]) => row[k] === v)).slice(0, cap);
      const ref = {
        where(q) { filter = q; return ref; }, limit(n) { cap = n; return ref; },
        async get() { return { data: structuredClone(rows()) }; },
        async count() { return { total: rows().length }; },
        async add({ data }) { const all = state.rows.get(name) || []; const item = { _id: data._id || name + all.length, ...structuredClone(data) }; all.push(item); state.rows.set(name, all); return { _id: item._id }; },
        async update({ data }) { for (const row of rows()) for (const [k,v] of Object.entries(data)) row[k] = v && typeof v === 'object' && 'increment' in v ? (row[k] || 0) + v.increment : v; },
        doc(id) { filter = { _id: id }; return { update: ref.update, async get() { const item = rows()[0]; if (!item) throw Error('not found'); return { data: structuredClone(item) }; } }; }
      };
      return ref;
    },
    async startTransaction() { return { collection: db.collection, async commit() { state.commits++; }, async rollback() {} }; }
  };
  const cloud = { init() {}, database: () => db, getWXContext: () => ({ OPENID: state.openid }),
    openapi: { security: { async msgSecCheck() { state.safety++; return { result: { suggest: 'pass' } }; } } } };
  const context = { exports: {}, Date: FixedDate, console: { log() {}, warn() {} },
    require(name) {
      if (name === 'wx-server-sdk') return cloud;
      if (name === './dataScope') return { createDataScope: () => ({ testMode: false, collection: n => n }), canUseTestData: async () => true };
      throw Error(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../cloudfunctions/checkWeeklyCode/index.js'), 'utf8'), context);
  return { state, clock, main: context.exports.main };
}
const request = (extra = {}) => ({ weeklyCode: 'VALID1', title: '新歌', remark: '歌手', specialNote: '', ...extra });

test('真实提交入口按北京时间周五20点含起点、周日20点不含终点，跨年不依赖宿主时区', async () => {
  for (const [time, open] of [
    ['2026-11-05T20:00:00+08:00', false], ['2026-11-06T19:59:59.999+08:00', false],
    ['2026-11-06T20:00:00+08:00', true], ['2026-11-07T00:00:00+08:00', true],
    ['2026-11-08T00:00:00+08:00', true], ['2026-11-08T19:59:59.999+08:00', true],
    ['2026-11-08T20:00:00+08:00', false], ['2026-11-09T00:00:00+08:00', false],
    ['2027-01-01T20:00:00+08:00', true], ['2027-01-03T20:00:00+08:00', false]
  ]) {
    const f = fixture(time), r = await f.main(request());
    assert.equal(r.success, open, time);
    assert.equal(presentation.isRegularOpen(new Date(Date.parse(time) + 28800000)), open, time);
    assert.equal(f.state.commits, open ? 1 : 0);
    if (!open) { assert.match(r.message, /每周五 20:00 至周日 20:00/); assert.equal(f.state.safety, 0); }
    else assert.equal(f.state.rows.get('submissions')[0].week_key, time.startsWith('2027') ? '2027-01-03' : '2026-11-08');
  }
});

test('周五投稿到周日仍只允许一次，周计数共享；250候选和验证码要求不变', async () => {
  const f = fixture('2026-11-06T20:00:00+08:00');
  assert.equal((await f.main(request())).success, true);
  f.clock.now = Date.parse('2026-11-08T19:00:00+08:00');
  const duplicate = await f.main(request({ title: '第二首' })); assert.equal(duplicate.success, false); assert.match(duplicate.message, /本周已经提交/);
  assert.equal(f.state.rows.get('submission_counters')[0].count, 1);
  f.state.openid = 'another';
  assert.equal((await f.main(request({ title: '第二首' }))).success, true);
  assert.equal(f.state.rows.get('submission_counters')[0].count, 2);
  const full = fixture('2026-11-07T10:00:00+08:00');
  full.state.rows.set('submissions', Array.from({length:250},(_,i)=>({_id:'old'+i,user_id:'other'+i,week_key:'2026-11-08',status:'pending',song_name:'旧歌'+i,song_key:'old'+i})));
  assert.equal((await full.main(request())).success, true);
  assert.equal(full.state.rows.get('submissions').at(-1).status, 'overflow');
  const invalid = await fixture('2026-11-07T10:00:00+08:00').main(request({ weeklyCode: 'WRONG1' })); assert.equal(invalid.success, false); assert.match(invalid.message, /验证码错误/);
});

test('强制关闭仍优先，强制开放可越过正常窗口，客户端伪造时间不能越过服务端校验', async () => {
  const both = fixture('2026-11-07T10:00:00+08:00', { forceOpen: true, forceClose: true });
  assert.match((await both.main(request())).message, /假期模式/); assert.equal(both.state.commits, 0);
  assert.equal((await fixture('2026-11-05T10:00:00+08:00', { forceOpen: true }).main(request())).success, true);
  const closed = await fixture('2026-11-05T10:00:00+08:00').main(request({ now: '2026-11-07T10:00:00+08:00', canSubmit: true }));
  assert.equal(closed.success, false); assert.match(closed.message, /每周五/);
});
