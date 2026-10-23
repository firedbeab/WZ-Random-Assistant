const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let openid = 'self', role = 'user', offline = false;
let rows = [], queries = [], writes = 0;
const db = { collection(name) {
  const query = { name };
  return {
    where(value) { query.where = value; return this; }, orderBy(field, direction) { query.sort = [field, direction]; return this; },
    field(value) { query.fields = value; return this; }, limit(value) { query.limit = value; return this; },
    async get() {
      queries.push(query); if (offline) throw new Error('offline');
      if (name === 'users') return { data: role ? [{ role }] : [] };
      const data = rows.filter(row => row.scope === name && row.user_id === query.where.user_id).sort((a, b) => b.submit_time - a.submit_time).slice(0, query.limit);
      return { data };
    }, add() { writes++; }, update() { writes++; }
  };
} };
const cloud = { init() {}, DYNAMIC_CURRENT_ENV: 'mock', database: () => db, getWXContext: () => ({ OPENID: openid }) };
const scope = require('../../cloudfunctions/getUserInfo/dataScope');
const context = { exports: {}, require: name => name === 'wx-server-sdk' ? cloud : scope, console: { warn() {} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../cloudfunctions/getUserInfo/index.js'), 'utf8'), context);
const main = context.exports.main;
(async () => {
  rows = [
    { scope: 'submissions', user_id: 'other', submit_time: 100, song_name: '别人的歌', singer: '别人的歌手' },
    { scope: 'submissions', user_id: 'self', submit_time: 1, song_name: '旧歌', singer: '旧歌手' },
    { scope: 'submissions', user_id: 'self', submit_time: 2, song_name: 'English', singer: 'Jay', special_note: 'not returned', status: 'pending' },
    { scope: 'test_submissions', user_id: 'self', submit_time: 3, song_name: '晴天', singer: '周杰伦' }
  ];
  const result = await main({ action: 'getLatestSubmission', user_id: 'other', openid: 'other' });
  assert.equal(result.success, true); assert.equal(result.data.song_name, 'English', 'do not search older eligible rows');
  assert.deepEqual(Object.keys(result.data).sort(), ['singer', 'song_name']);
  assert.equal(queries.at(-1).where.user_id, 'self'); assert.deepEqual(Array.from(queries.at(-1).sort), ['submit_time', 'desc']);
  assert.equal(queries.at(-1).limit, 1); assert.equal(queries.at(-1).fields._id, false);
  const before = queries.length;
  assert.equal((await main({ action: 'getLatestSubmission', _testMode: true })).success, false);
  assert.ok(queries.slice(before).every(query => query.name !== 'test_submissions'));
  role = 'superadmin';
  assert.equal((await main({ action: 'getLatestSubmission', _testMode: true })).data.song_name, '晴天');
  rows[2].status = 'removed'; assert.equal((await main({ action: 'getLatestSubmission' })).data, null);
  rows = []; assert.equal((await main({ action: 'getLatestSubmission' })).data, null);
  openid = ''; assert.equal((await main({ action: 'getLatestSubmission' })).success, false);
  openid = 'self'; offline = true; assert.equal((await main({ action: 'getLatestSubmission' })).success, false);
  assert.equal(writes, 0, 'latest-submission action is strictly read-only');
  console.log('PASS: server-context ownership, minimal latest-only read, deleted/empty rows, test-role isolation, missing identity, failures and no writes');
})().catch(error => { console.error(error); process.exitCode = 1; });
