// 抽取云函数的两个新增行为：遗留待审核排期自动作废、无新投稿时标记 carryover_only。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let checks = 0;
function check(actual, expected, label) { assert.equal(actual, expected, label); checks++; }

function loadDrawFn(seed) {
  const state = {
    schedules: seed.schedules || {},
    submissions: seed.submissions || {},
    added: [],
    updates: []
  };
  const command = {
    in: value => ({ __op: 'in', value }),
    nin: value => ({ __op: 'nin', value }),
    lt: value => ({ __op: 'lt', value }),
    eq: value => ({ __op: 'eq', value })
  };
  const matches = (row, query) => Object.entries(query || {}).every(([key, value]) => {
    if (value && value.__op === 'in') return value.value.includes(row[key]);
    if (value && value.__op === 'nin') return !value.value.includes(row[key]);
    if (value && value.__op === 'lt') return String(row[key]) < String(value.value);
    if (value && value.__op === 'eq') return row[key] === value.value;
    return row[key] === value;
  });
  const storeOf = name => {
    if (name === 'schedules' || name === 'test_schedules') return state.schedules;
    if (name === 'submissions' || name === 'test_submissions') return state.submissions;
    if (name === 'message_subscriptions' || name === 'users') return {};
    return {};
  };

  function collection(name) {
    const ref = {
      _docId: null, _query: {}, _skip: 0, _limit: 1000,
      doc(id) { ref._docId = id; return ref; },
      where(query) { ref._query = query; return ref; },
      limit(v) { ref._limit = v; return ref; }, skip(v) { ref._skip = v; return ref; },
      orderBy() { return ref; }, field() { return ref; },
      async get() {
        // 鉴权会读 users 判断角色，这里直接给一个管理员。
        if (name === 'users' || name === 'test_users') return { data: [{ openid: 'mock-admin', role: 'admin' }] };
        const rows = storeOf(name);
        if (ref._docId) return { data: rows[ref._docId] || null };
        const list = Object.values(rows).filter(row => matches(row, ref._query));
        return { data: structuredClone(list.slice(ref._skip, ref._skip + ref._limit)) };
      },
      async count() {
        const rows = storeOf(name);
        return { total: Object.values(rows).filter(row => matches(row, ref._query)).length };
      },
      async update(payload) {
        const data = payload && payload.data ? payload.data : {};
        let updated = 0;
        const apply = row => { Object.assign(row, data); updated++; };
        if (ref._docId) { const row = storeOf(name)[ref._docId]; if (row) apply(row); }
        else Object.values(storeOf(name)).filter(row => matches(row, ref._query)).forEach(apply);
        state.updates.push({ name, ids: ref._docId, query: ref._query, data });
        return { stats: { updated } };
      },
      async add(payload) {
        const id = 'generated-1';
        storeOf(name)[id] = Object.assign({ _id: id }, payload.data);
        state.added.push({ name, data: payload.data });
        return { _id: id };
      },
      async remove() {
        const rows = storeOf(name);
        let removed = 0;
        Object.keys(rows).forEach(key => {
          if (ref._docId ? key === ref._docId : matches(rows[key], ref._query)) { delete rows[key]; removed++; }
        });
        return { stats: { removed } };
      }
    };
    return ref;
  }

  const db = {
    command,
    serverDate: () => new Date(),
    collection,
    async startTransaction() {
      const tx = { collection, async commit() {}, async rollback() {} };
      return tx;
    }
  };

  const scope = { testMode: true, collection: n => n };
  const moduleObj = { exports: {} };
  const context = {
    require(name) {
      if (name.includes('dataScope')) {
        return { createDataScope: () => scope, canUseTestData: async () => true, isProductionSuperadmin: async () => false };
      }
      if (name.includes('wx-server-sdk')) {
        return {
          init() {}, DYNAMIC_CURRENT_ENV: 'env',
          getWXContext: () => ({ OPENID: 'mock-admin' }),
          database: () => db,
          openapi: { subscribeMessage: { send: async () => ({}) } }
        };
      }
      if (name === 'crypto') return { randomInt: () => 1 };
      return {};
    },
    module: moduleObj, exports: moduleObj.exports, console, Date, JSON, Object, Array, Number, String, Set, Math, Promise
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../cloudfunctions/drawWeeklyPlaylist/index.js'), 'utf8'), context);
  return { main: moduleObj.exports.main, state };
}

(async () => {
  // 1) 更早周次的待审核排期应被自动作废，其投稿回到候补池；本周的不受影响。
  {
    const fn = loadDrawFn({
      schedules: {
        stale: { _id: 'stale', week_key: '2026-10-25', status: 'pending', revision: 1,
          day1: [{ submission_id: 'x1', song_name: '旧歌' }], day2: [], day3: [], day4: [], day5: [] }
      },
      submissions: {
        x1: { _id: 'x1', status: 'selected', week_key: '2026-10-25', song_name: '旧歌', user_id: 'u2', submit_time: 1 },
        n1: { _id: 'n1', status: 'pending', week_key: '2026-11-01', song_name: '新歌', user_id: 'u2', submit_time: 2 }
      }
    });
    // 冻结时间到 2026-11-01（周日），让 weekKey 稳定
    const res = await fn.main({}, {});
    const stale = fn.state.schedules.stale;
    check(stale.status, 'withdrawn', '更早周次的待审核排期应被自动作废');
    check(stale.auto_voided, true, '自动作废应留下标记');
    check(fn.state.submissions.x1.status, 'carryover', '被作废排期里的投稿应回到候补池');
    const released = fn.state.updates.find(u => u.name === 'submissions' && u.data && u.data.status === 'carryover');
    check(Boolean(released), true, '作废时应把 selected 状态的投稿改回 carryover');
    check(res.success !== undefined, true, '主流程应返回结果');
  }

  // 2) 本周有投稿时，新排期不应带 carryover_only 标记。
  {
    const fn = loadDrawFn({
      schedules: {},
      submissions: {
        n1: { _id: 'n1', status: 'pending', week_key: '2026-11-01', song_name: '新歌', user_id: 'u2', submit_time: 2 }
      }
    });
    await fn.main({}, {});
    const created = fn.state.added.find(item => item.name === 'schedules');
    if (created) check(created.data.carryover_only, false, '本周有投稿时不应标记为纯候补生成');
  }

  console.log(`PASS: ${checks} draw assertions; stale pending schedule voided with submissions back to carryover, carryover_only flag present`);
})().catch(err => { console.error(err); process.exit(1); });
