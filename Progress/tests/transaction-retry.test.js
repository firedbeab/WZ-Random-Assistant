const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const files = ['checkWeeklyCode/index.js', 'manageFeedback/service.js', 'manageSongLikes/service.js'];
const helpers = files.map(file => fs.readFileSync(path.join(__dirname, '../../cloudfunctions', file), 'utf8').split('// END shared transaction retry.')[0]);
function fixture() {
  const delays = [], box = { setTimeout(fn, delay) { delays.push(delay); fn(); }, Math };
  vm.createContext(box); vm.runInContext(`${helpers[0]};this.retry=transactionWithRetry;this.conflict=isTransactionConflict`, box);
  return { ...box, delays };
}
test('三个部署包使用相同的有限重试策略，仅识别明确的数据库冲突', () => {
  assert(helpers.every(source => source === helpers[0]));
  const f = fixture();
  for (const error of [{ code: 'DATABASE_TRANSACTION_CONFLICT' }, { errCode: 'DATABASE_TRANSACTION_CONFLICT' }, { errMsg: 'database transaction conflict' }, Error('Write conflict')]) assert.equal(f.conflict(error), true);
  for (const error of [null, Error('network timeout'), { code: 'CONFLICT' }, { errCode: -502011 }, { code: 'DATABASE_PERMISSION_DENIED' }, { businessCode: 'CONFLICT', message: 'write conflict' }, { isBusiness: true, code: 'DATABASE_TRANSACTION_CONFLICT' }]) assert.equal(f.conflict(error), false);
});
test('重新启动事务并重读，最多三次，回滚发生在重试之前', async () => {
  const f = fixture(), events = [];
  let starts = 0;
  const db = { async startTransaction() { const n = ++starts; events.push(`start${n}`); return { async commit() { events.push(`commit${n}`); if (n < 3) throw { code: 'DATABASE_TRANSACTION_CONFLICT' }; }, async rollback() { events.push(`rollback${n}`); } }; } };
  const value = await f.retry(db, async () => { events.push(`read${starts}`); return starts; });
  assert.equal(value, 3); assert.equal(starts, 3);
  assert.deepEqual(events, ['start1','read1','commit1','rollback1','start2','read2','commit2','rollback2','start3','read3','commit3']);
  assert(f.delays[0] >= 40 && f.delays[0] < 70); assert(f.delays[1] >= 80 && f.delays[1] < 110);
  starts = 0;
  db.startTransaction = async () => { starts++; throw { code: 'DATABASE_TRANSACTION_CONFLICT' }; };
  await assert.rejects(f.retry(db, async () => {}), e => e.code === 'DATABASE_TRANSACTION_CONFLICT'); assert.equal(starts, 3);
});
test('未知提交结果、业务版本冲突、权限和超时均不自动重放写入', async () => {
  for (const error of [Error('network timeout'), { businessCode:'CONFLICT',message:'write conflict' }, { code:'DATABASE_PERMISSION_DENIED' }]) {
    const f = fixture(); let writes = 0, rollbacks = 0;
    const db = { async startTransaction() { return { async commit() { throw error; }, async rollback() { rollbacks++; throw Error('rollback offline'); } }; } };
    await assert.rejects(f.retry(db, async () => { writes++; }), e => e === error);
    assert.equal(writes, 1); assert.equal(rollbacks, 1); assert.equal(f.delays.length, 0);
  }
});
