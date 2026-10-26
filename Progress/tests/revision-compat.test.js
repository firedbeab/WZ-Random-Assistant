// 版本号兼容回归：历史排期/配置文档缺少 revision 字段时，条件更新必须仍能匹配，
// 不能因为"字段不存在 ≠ 1"而误报"页面数据已过期"。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let checks = 0;
function check(actual, expected, label) { assert.equal(actual, expected, label); checks++; }

function loadConsoleFn(seed) {
  const state = { schedules: seed.schedules || {}, submissions: seed.submissions || {}, events: [] };
  const command = {
    in: value => ({ __op: 'in', value }),
    inc: value => ({ __op: 'inc', value }),
    gte: value => ({ __op: 'gte', value }),
    nin: value => ({ __op: 'nin', value }),
    lt: value => ({ __op: 'lt', value }),
    exists: value => ({ __op: 'exists', value }),
    remove: () => ({ __op: 'remove' })
  };
  const has = (row, key) => row[key] !== undefined && row[key] !== null;
  const matches = (row, query) => Object.entries(query || {}).every(([key, value]) => {
    if (value && value.__op === 'exists') {
      const present = has(row, key);
      return value.value === false ? !present : present;
    }
    if (value && value.__op === 'in') return value.value.includes(row[key]);
    if (value && value.__op === 'nin') return !value.value.includes(row[key]);
    if (value && value.__op === 'gte') return Number(row[key]) >= Number(value.value);
    if (value && value.__op === 'lt') return Number(row[key]) < Number(value.value);
    return row[key] === value;
  });
  const storeOf = name => {
    if (name.includes('schedules')) return state.schedules;
    if (name.includes('submissions')) return state.submissions;
    if (name.includes('system_events')) return state.events;
    return {};
  };
  function collection(name) {
    const ref = {
      _docId: null, _query: {},
      doc(id) { ref._docId = id; return ref; },
      where(q) { ref._query = q; return ref; },
      limit() { return ref; }, skip() { return ref; }, orderBy() { return ref; }, field() { return ref; },
      async get() {
        const rows = storeOf(name);
        if (Array.isArray(rows)) return { data: rows.filter(r => matches(r, ref._query)) };
        if (ref._docId) return { data: rows[ref._docId] || null };
        return { data: Object.values(rows).filter(r => matches(r, ref._query)).map(r => structuredClone(r)) };
      },
      async count() {
        const rows = storeOf(name);
        const list = Array.isArray(rows) ? rows : Object.values(rows);
        return { total: list.filter(r => matches(r, ref._query)).length };
      },
      async update(payload) {
        const data = payload && payload.data ? payload.data : {};
        let updated = 0;
        const targets = [];
        const rows = storeOf(name);
        if (ref._docId) { if (rows[ref._docId]) targets.push(rows[ref._docId]); }
        else if (Array.isArray(rows)) { rows.forEach(r => { if (matches(r, ref._query)) targets.push(r); }); }
        else { Object.values(rows).forEach(r => { if (matches(r, ref._query)) targets.push(r); }); }
        targets.forEach(row => {
          Object.entries(data).forEach(([k, v]) => {
            if (v && v.__op === 'remove') delete row[k];
            else if (v && v.__op === 'inc') row[k] = (Number(row[k]) || 0) + v.value;
            else row[k] = v;
          });
          updated++;
        });
        return { stats: { updated } };
      },
      async add(payload) {
        const rows = storeOf(name);
        if (Array.isArray(rows)) rows.push(payload.data);
        else rows[payload.data._id || 'new'] = payload.data;
        return { _id: payload.data._id || 'new' };
      },
      async set(payload) { return { stats: { updated: 1 } }; }
    };
    return ref;
  }
  const db = { command, serverDate: () => new Date(), collection };
  const scope = { testMode: false, collection: n => n };
  const moduleObj = { exports: {} };
  const context = {
    require(name) {
      if (name.includes('dataScope')) {
        return { createDataScope: () => scope, canUseTestData: async () => true, isProductionSuperadmin: async () => true };
      }
      if (name.includes('wx-server-sdk')) {
        return {
          init() {}, DYNAMIC_CURRENT_ENV: 'env',
          getWXContext: () => ({ OPENID: 'mock-super' }),
          database: () => db,
          openapi: { security: { msgSecCheck: async () => ({ errCode: 0 }) } }
        };
      }
      return {};
    },
    module: moduleObj, exports: moduleObj.exports,
    console, Date, JSON, Object, Array, Number, String, Set, Math, Promise
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../cloudfunctions/superAdminConsole/index.js'), 'utf8'), context);
  return { main: moduleObj.exports.main, state };
}

// 云函数可能抛错，也可能返回 { success:false }，这里归一成结果对象。
async function call(fn, payload) {
  try { return await fn.main(payload); }
  catch (e) { return { success: false, message: (e && e.message) || String(e) }; }
}

(async () => {
  // 1) 文档完全没有 revision 字段时，撤回必须成功（旧数据兼容）
  {
    const fn = loadConsoleFn({ schedules: { s1: {
      _id: 's1', week_key: '2026-10-25', status: 'published',
      day1: [{ submission_id: 'a', song_name: 'A' }], day2: [], day3: [], day4: [], day5: []
    } } });
    const res = await call(fn, { action: 'withdrawSchedule', id: 's1', revision: 1, reason: '测试撤回' });
    check(res.success, true, '缺 revision 字段的旧排期应能撤回');
    check(fn.state.schedules.s1.status, 'withdrawn', '撤回后状态应为已撤回');
    check(fn.state.schedules.s1.revision, 2, '撤回后应写入 revision=2');
  }

  // 2) 有 revision 字段时，版本不一致必须拒绝（并发保护不能失效）
  {
    const fn = loadConsoleFn({ schedules: { s1: {
      _id: 's1', week_key: '2026-10-25', status: 'published', revision: 5,
      day1: [], day2: [], day3: [], day4: [], day5: []
    } } });
    const res = await call(fn, { action: 'withdrawSchedule', id: 's1', revision: 4, reason: '测试' });
    check(res.success, false, '版本号不一致时撤回应失败');
    check(fn.state.schedules.s1.status, 'published', '失败时状态不能改变');
  }

  // 3) 有 revision 字段且一致时撤回成功
  {
    const fn = loadConsoleFn({ schedules: { s1: {
      _id: 's1', week_key: '2026-10-25', status: 'published', revision: 5,
      day1: [], day2: [], day3: [], day4: [], day5: []
    } } });
    const res = await call(fn, { action: 'withdrawSchedule', id: 's1', revision: 5, reason: '正常撤回' });
    check(res.success, true, '版本一致时撤回成功');
    check(fn.state.schedules.s1.revision, 6, '撤回后版本号 +1');
  }

  // 4) 保存排期：缺 revision 字段的旧排期同样应能保存
  {
    const fn = loadConsoleFn({ schedules: { s1: {
      _id: 's1', week_key: '2026-10-25', status: 'pending',
      day1: [{ song_name: '晴天', singer: '周杰伦', special_note: '' }],
      day2: [], day3: [], day4: [], day5: []
    } } });
    const days = { day1: [{ song_name: '晴天', singer: '周杰伦', special_note: '' }], day2: [], day3: [], day4: [], day5: [] };
    const res = await call(fn, { action: 'updateSchedule', id: 's1', revision: 1, days, adminNote: '' });
    check(res.success, true, '缺 revision 字段的旧排期应能保存');
    check(fn.state.schedules.s1.revision, 2, '保存后版本号应为 2');
  }

  console.log(`PASS: ${checks} revision-compat assertions; 历史文档缺 revision 仍可撤回/保存，有 revision 时并发保护仍然生效`);
})().catch(err => { console.error(err); process.exit(1); });
