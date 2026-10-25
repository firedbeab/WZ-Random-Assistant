// 审核/发布云函数的关键行为回归：跳过某日应转候补、空列表必须填备注、版本校验必须生效。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let checks = 0;
function check(actual, expected, label) { assert.equal(actual, expected, label); checks++; }

function loadAdminFn(seed) {
  const state = {
    schedules: seed.schedules || {},
    submissions: seed.submissions || {},
    exceptions: [],
    events: [],
    updates: []
  };
  const command = {
    in: value => ({ __op: 'in', value }),
    inc: value => ({ __op: 'inc', value }),
    gte: value => ({ __op: 'gte', value })
  };
  const matches = (row, query) => Object.entries(query || {}).every(([key, value]) => {
    if (value && value.__op === 'in') return value.value.includes(row[key]);
    if (value && value.__op === 'gte') return Number(row[key]) >= Number(value.value);
    return row[key] === value;
  });

  function collection(name) {
    const store = () => {
      if (name === 'schedules') return state.schedules;
      if (name === 'submissions') return state.submissions;
      if (name === 'schedule_exceptions') return state.exceptions;
      if (name === 'system_events') return state.events;
      if (name === 'users') return { __rows: [{ openid: 'mock-admin', role: 'admin' }] };
      return {};
    };
    const ref = {
      _docId: null, _query: {},
      doc(id) { ref._docId = id; return ref; },
      where(query) { ref._query = query; return ref; },
      limit() { return ref; }, orderBy() { return ref; }, field() { return ref; }, skip() { return ref; },
      async get() {
        if (name === 'users') return { data: [{ openid: 'mock-admin', role: 'admin' }] };
        const rows = store();
        if (ref._docId) {
          const row = rows[ref._docId];
          if (!row) throw new Error('not found');
          return { data: structuredClone(row) };
        }
        return { data: Object.values(rows).filter(row => matches(row, ref._query)).map(row => structuredClone(row)) };
      },
      async update(payload) {
        const data = payload && payload.data ? payload.data : {};
        let updated = 0;
        const apply = row => {
          Object.entries(data).forEach(([key, value]) => {
            row[key] = value && value.__op === 'inc' ? (Number(row[key]) || 0) + value.value : value;
          });
          updated++;
        };
        if (ref._docId) {
          const row = store()[ref._docId];
          if (row) apply(row);
        } else {
          Object.values(store()).filter(row => matches(row, ref._query)).forEach(apply);
        }
        state.updates.push({ name, ids: ref._docId, query: ref._query, data });
        return { stats: { updated } };
      },
      async add(payload) {
        if (name === 'system_events') state.events.push(payload.data);
        else state.exceptions.push(payload.data);
        return { _id: 'added' };
      },
      async count() { return { total: Object.values(store()).filter(row => matches(row, ref._query)).length }; }
    };
    return ref;
  }

  const db = {
    command,
    serverDate: () => new Date(),
    collection,
    async startTransaction() {
      // 事务桩：直接复用 collection()，rollback 记录状态便于断言“未提交”。
      const tx = {
        rolledBack: false, committed: false,
        collection,
        async commit() { tx.committed = true; },
        async rollback() { tx.rolledBack = true; }
      };
      return tx;
    }
  };

  const scope = { testMode: false, collection: n => n };
  // 云函数用 exports.main 导出，所以 exports 必须与 module.exports 指向同一个对象。
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
          openapi: { security: { msgSecCheck: async () => ({ errCode: 0 }) } }
        };
      }
      return {};
    },
    module: moduleObj, exports: moduleObj.exports, console, Date, JSON, Object, Array, Number, String, Set, Math, Promise
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../cloudfunctions/adminAuditPlaylist/index.js'), 'utf8'), context);
  return { main: moduleObj.exports.main, state };
}

(async () => {
  // 1) 跳过某日：当天曲目清空，被跳过的投稿转 carryover（不能打成 rejected）
  {
    const fn = loadAdminFn({
      schedules: { s1: { _id: 's1', status: 'pending', week_key: '2026-10-25', revision: 3,
        day1: [{ submission_id: 'a', song_name: 'A' }], day2: [], day3: [], day4: [], day5: [] } },
      submissions: { a: { _id: 'a', status: 'selected' } }
    });
    const res = await fn.main({ action: 'skipDay', playlistId: 's1', dayIndex: 0, revision: 3 });
    check(res.success, true, '跳过某日应成功');
    check(fn.state.submissions.a.status, 'carryover', '被跳过的投稿必须转回候补而不是作废');
    check(fn.state.schedules.s1.day1.length, 0, '当天列表应被清空');
    check(fn.state.schedules.s1.revision, 4, '排期版本号应加一');
  }

  // 2) 版本号不匹配时跳过某日必须被拒绝（防止按过期快照清空错误的日期）
  {
    const fn = loadAdminFn({
      schedules: { s1: { _id: 's1', status: 'pending', week_key: '2026-10-25', revision: 5,
        day1: [{ submission_id: 'a', song_name: 'A' }], day2: [], day3: [], day4: [], day5: [] } },
      submissions: { a: { _id: 'a', status: 'selected' } }
    });
    const res = await fn.main({ action: 'skipDay', playlistId: 's1', dayIndex: 0, revision: 4 });
    check(res.success, false, '版本号过期的跳过操作应失败');
    check(fn.state.schedules.s1.day1.length, 1, '版本号不匹配时不能改动排期');
    check(fn.state.submissions.a.status, 'selected', '版本号不匹配时不能改动投稿状态');
  }

  // 3) 空列表发布且没有备注：必须拒绝，且不写库
  {
    const fn = loadAdminFn({
      schedules: { s1: { _id: 's1', status: 'pending', week_key: '2026-10-25', revision: 1,
        day1: [], day2: [], day3: [], day4: [], day5: [] } },
      submissions: {}
    });
    const res = await fn.main({ action: 'publish', playlistId: 's1', note: '' });
    check(res.success, false, '空列表无备注应拒绝发布');
    check(res.code, 'EMPTY_NEEDS_NOTE', '应返回明确的错误码');
    check(fn.state.schedules.s1.status, 'pending', '被拒绝时排期状态不能变成已发布');
  }

  // 4) 空列表但填写了备注：允许发布
  {
    const fn = loadAdminFn({
      schedules: { s1: { _id: 's1', status: 'pending', week_key: '2026-10-25', revision: 1,
        day1: [], day2: [], day3: [], day4: [], day5: [] } },
      submissions: {}
    });
    const res = await fn.main({ action: 'publish', playlistId: 's1', note: '本周广播站检修，暂停一期' });
    check(res.success, true, '空列表填了备注应允许发布');
    check(fn.state.schedules.s1.status, 'published', '排期应变成已发布');
    check(fn.state.schedules.s1.total_count, 0, '总条数应为 0');
    check(fn.state.schedules.s1.admin_note, '本周广播站检修，暂停一期', '备注应写入排期');
  }

  // 5) 发布时版本号不匹配必须拒绝
  {
    const fn = loadAdminFn({
      schedules: { s1: { _id: 's1', status: 'pending', week_key: '2026-10-25', revision: 7,
        day1: [{ submission_id: 'a', song_name: 'A' }], day2: [], day3: [], day4: [], day5: [] } },
      submissions: { a: { _id: 'a', status: 'selected' } }
    });
    const res = await fn.main({ action: 'publish', playlistId: 's1', note: '', revision: 6 });
    check(res.success, false, '版本号过期的发布应失败');
    check(fn.state.schedules.s1.status, 'pending', '被拒绝时不能变成已发布');
  }

  // 6) 正常发布：待删除项被打成 rejected，其余保留
  {
    const fn = loadAdminFn({
      schedules: { s1: { _id: 's1', status: 'pending', week_key: '2026-10-25', revision: 2,
        day1: [
          { submission_id: 'a', song_name: 'A' },
          { submission_id: 'b', song_name: 'B', audit_state: 'pending_remove' }
        ], day2: [], day3: [], day4: [], day5: [] } },
      submissions: { a: { _id: 'a', status: 'selected' }, b: { _id: 'b', status: 'selected' } }
    });
    const res = await fn.main({ action: 'publish', playlistId: 's1', note: '', revision: 2 });
    check(res.success, true, '正常发布应成功');
    check(fn.state.schedules.s1.day1.length, 1, '待删除项应从列表移除');
    check(fn.state.submissions.b.status, 'rejected', '明确标为待删除的投稿应作废');
    check(fn.state.submissions.a.status, 'selected', '保留的投稿状态不应被改动');
  }

  console.log(`PASS: ${checks} admin operation assertions; skip-day to carryover, revision guard on skip/publish, empty list requires note, normal publish keeps其它项`);
})().catch(err => { console.error(err); process.exit(1); });
