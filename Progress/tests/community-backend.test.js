const test = require('node:test');
const assert = require('node:assert/strict');
const { createService, hash } = require('../../cloudfunctions/manageFeedback/service');
const { createDataScope } = require('../../cloudfunctions/manageFeedback/dataScope');
function fixture() {
  let time = Date.UTC(2026, 9, 27), safetyReject = false, unavailable = false;
  const records = new Map(), versions = new Map(), safety = [], reads = [];
  const key = (collection, id) => collection + '/' + id;
  const db = { collection: collection => reference(collection), async startTransaction() {
    const observed = new Map(), writes = new Map();
    return { collection: name => reference(name, observed, writes), async rollback() {}, async commit() {
      for (const [k, version] of observed) if ((versions.get(k) || 0) !== version) throw Error('CONCURRENT_MODIFICATION');
      for (const [k, value] of writes) { records.set(k, structuredClone(value)); versions.set(k, (versions.get(k) || 0) + 1); }
    } };
  } };
  function reference(collection, observed, writes) {
    let where = {}, offset = 0, limit = 100;
    const ref = { where(value) { where = value; return ref; }, orderBy() { return ref; }, limit(value) { limit = value; return ref; }, skip(value) { offset = value; return ref; },
      async get() { if (unavailable) throw Error('DATABASE_OFFLINE'); reads.push(collection); return { data: [...records.entries()].filter(([k, value]) => k.startsWith(collection + '/') && Object.entries(where).every(([f, v]) => value[f] === v)).map(([, value]) => structuredClone(value)).sort((a,b) => b.created_at-a.created_at).slice(offset, offset+limit) }; },
      doc(id) { const k = key(collection, id); return {
        async get() { if (unavailable) throw Error('DATABASE_OFFLINE'); reads.push(collection); if (observed) observed.set(k, versions.get(k) || 0); return { data: records.has(k) ? structuredClone(records.get(k)) : null }; },
        async set({ data }) { const value = { ...data, _id: id }; if (writes) writes.set(k, value); else { records.set(k, value); versions.set(k, (versions.get(k)||0)+1); } },
        async update({ data }) { const old = writes && writes.get(k) || records.get(k); if (!old) throw Error('NOT_FOUND'); await this.set({ data: { ...old, ...data } }); }
      }; }
    }; return ref;
  }
  function seed(collection, id, data) { records.set(key(collection, id), { _id: id, ...data }); }
  seed('users', 'u1', { openid: 'alice', role: 'user', points: 42 }); seed('users', 'u2', { openid: 'admin', role: 'superadmin' });
  const service = createService({ db, createDataScope, now: () => time,
    canUseTestData: async (_, openid, scope) => !scope.testMode || ['admin', 'tester'].includes(openid),
    isProductionSuperadmin: async (_, openid) => openid === 'admin',
    checkText: async (value, openid) => { safety.push({value,openid}); if (safetyReject) { const e = Error('内容未通过检查'); e.businessCode = 'CONTENT_REJECTED'; throw e; } }
  });
  return { call: (action, data = {}, openid = 'alice') => service({ ...data, action }, openid), records, reads, safety, seed,
    advance(ms) { time += ms; }, rejectSafety() { safetyReject = true; }, offline() { unavailable = true; } };
}
const form = (requestId = 'request_test_0001') => ({ content: '希望支持更清楚的反馈说明', category: '功能建议', version: '1.9', requestId });
test('显示称呼只修改旧 users 字段，不改变角色、积分或账号；内容安全失败不写入', async () => {
  const f = fixture(); assert.equal((await f.call('getProfile')).data.alias, '点歌同学');
  assert.equal((await f.call('setAlias', { alias: '新称呼', role: 'superadmin' })).success, true);
  const user = f.records.get('users/u1'); assert.equal(user.role, 'user'); assert.equal(user.points, 42); assert.equal(user.openid, 'alice');
  assert.equal(f.records.size, 2); assert.equal((await f.call('setAlias', { alias: 'x' })).success, false);
  f.rejectSafety(); assert.equal((await f.call('setAlias', { alias: '另一个称呼' })).code, 'CONTENT_REJECTED'); assert.equal(user.name_alias, '新称呼');
});
test('本人反馈读写、脱敏、每日频控和请求幂等；旧账号不需要迁移', async () => {
  const f = fixture(), submitted = await f.call('submitFeedback', form()); assert.equal(submitted.success, true);
  const id = submitted.data._id; assert(!JSON.stringify(submitted).includes('alice')); assert.equal(submitted.data.status, 'received');
  assert.equal((await f.call('submitFeedback', form())).data._id, id);
  assert.equal((await f.call('submitFeedback', form('request_test_0002'))).code, 'RATE_LIMIT');
  assert.equal((await f.call('getFeedback', {id}, 'stranger')).code, 'NOT_FOUND');
  assert.equal((await f.call('listMine', {}, 'stranger')).data.items.length, 0);
  for (let i=2;i<=3;i++) { f.advance(60001); assert.equal((await f.call('submitFeedback', form('request_test_000'+i))).success,true); }
  f.advance(60001); assert.equal((await f.call('submitFeedback',form('request_test_0004'))).code,'RATE_LIMIT');
});
test('超管权限与测试域隔离；客户端角色和 owner 均不能越权', async () => {
  const f=fixture(); assert.equal((await f.call('adminList',{role:'superadmin'})).code,'FORBIDDEN');
  assert.equal((await f.call('listMine',{_testMode:true})).code,'TEST_ACCESS_DENIED');
  assert.equal((await f.call('adminList',{_testMode:true},'tester')).code,'FORBIDDEN');
  await f.call('submitFeedback',{...form(),_testMode:true},'tester'); assert.equal((await f.call('listMine',{},'tester')).data.items.length,0);
  assert.equal((await f.call('adminList',{_testMode:true},'admin')).data.items.length,1);
  assert.equal((await f.call('getProfile',{},'')).code,'UNAUTHENTICATED');
});
test('反馈回复检查 revision，已读只推进已展示版本，重命名不改变关联编号', async () => {
  const f=fixture(), entry=(await f.call('submitFeedback',form())).data;
  const first=await f.call('adminUpdate',{id:entry._id,revision:1,status:'handling',reply:'正在安排'},'admin'); assert.equal(first.success,true);
  assert.equal((await f.call('adminUpdate',{id:entry._id,revision:1,status:'done',reply:'旧页面'},'admin')).code,'CONFLICT');
  const second=await f.call('adminUpdate',{id:entry._id,revision:2,status:'done',reply:'已经完成'},'admin'); assert.equal(second.data.replyVersion,2);
  const read=await f.call('markRead',{id:entry._id,replyVersion:1}); assert.equal(read.data.unread,true);
  assert.equal((await f.call('markRead',{id:entry._id,replyVersion:3})).success,false);
  await f.call('setAlias',{alias:'新的称呼'}); const profile=(await f.call('getProfile')).data;
  assert.equal(profile.userKey,entry.userKey); assert.equal((await f.call('adminList',{userKey:profile.userKey},'admin')).data.items.length,1);
  assert.equal((await f.call('markRead',{id:entry._id,replyVersion:2})).data.unread,false);
});
const pollForm = {title:'优先更新哪项功能',description:'请选择一项',options:['界面优化','使用反馈'],days:3,requestId:'create_poll_0001'};
test('单选投票可改票且不重复累计；投前隐藏汇总、结束后公开结果并拒绝写入', async () => {
  const f=fixture(), created=await f.call('createPoll',pollForm,'admin'), id=created.data.id;
  assert.equal((await f.call('createPoll',pollForm,'admin')).data.id,id);
  assert.equal((await f.call('listPolls')).data.items[0].options[0].count,null);
  assert.equal((await f.call('vote',{id,choice:0})).success,true); await f.call('vote',{id,choice:0}); await f.call('vote',{id,choice:1});
  const view=(await f.call('listPolls')).data.items[0]; assert.equal(view.total,1); assert.deepEqual(view.options.map(v=>v.count),[0,1]); assert.equal(view.choice,1);
  assert.equal((await f.call('listPolls',{},'stranger')).data.items[0].resultsVisible,false);
  assert.equal((await f.call('adminListPolls',{},'admin')).data.items[0].options[1].count,1);
  await f.call('endPoll',{id},'admin'); assert.equal((await f.call('vote',{id,choice:0})).code,'POLL_CLOSED');
  assert.equal((await f.call('listPolls',{},'stranger')).data.items[0].resultsVisible,true);
});
test('两个并发投票争用同一汇总时不能覆盖计数，失败后重试按最新数据记票', async () => {
  const f=fixture(), id=(await f.call('createPoll',pollForm,'admin')).data.id;
  const results=await Promise.all([f.call('vote',{id,choice:0},'alice'),f.call('vote',{id,choice:1},'stranger')]);
  assert.equal(results.filter(v=>v.success).length,1);
  for(let i=0;i<results.length;i++)if(!results[i].success)await f.call('vote',{id,choice:i},i===0?'alice':'stranger');
  const view=(await f.call('adminListPolls',{},'admin')).data.items[0];assert.equal(view.total,2);assert.deepEqual(view.options.map(v=>v.count),[1,1]);
  f.advance(4*86400000);assert.equal((await f.call('vote',{id,choice:1})).code,'POLL_CLOSED');
});
test('分页只返回规定条数，异常不伪装空列表；新模块没有旧投稿/排期写入', async () => {
  const f=fixture();for(let i=0;i<25;i++)f.seed('user_feedback',hash(i),{owner:'alice',created_at:i,content:'测试',status:'received'});
  const a=await f.call('listMine'),b=await f.call('listMine',{offset:a.data.offset});assert.equal(a.data.items.length,20);assert.equal(a.data.hasMore,true);assert.equal(b.data.items.length,5);assert.equal(b.data.hasMore,false);
  assert(!f.reads.some(name=>/schedules|submissions|weekly_codes/.test(name)));
  f.offline();assert.equal((await f.call('listMine')).code,'BACKEND_UNAVAILABLE');
});
