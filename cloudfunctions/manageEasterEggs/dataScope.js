'use strict';
const TEST_ACCOUNTS_DOC = 'test_accounts_v1';
let allowlistCache = { at: 0, set: null };
function createDataScope(event) {
  const testMode = Boolean(event && event._testMode === true);
  return { testMode, collection(name) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('Invalid collection name');
    return `${testMode ? 'test_' : ''}${name}`;
  } };
}
async function isProductionSuperadmin(db, openid) {
  if (!openid) return false;
  const res = await db.collection('users').where({ openid }).limit(1).get();
  return res.data.length > 0 && res.data[0].role === 'superadmin';
}
// 白名单只决定能否进入测试域，不代表管理角色；固定读测试域集合，读取失败保守拒绝且不缓存失败。
async function isAllowlistedTestAccount(db, openid) {
  if (!openid) return false;
  const now = Date.now();
  if (allowlistCache.set && now - allowlistCache.at < 60000) return allowlistCache.set.has(openid);
  try {
    const res = await db.collection('test_configs').where({ _id: TEST_ACCOUNTS_DOC }).limit(1).get();
    const doc = res.data[0];
    const openids = doc && Array.isArray(doc.openids) ? doc.openids.filter(x => typeof x === 'string' && x) : [];
    allowlistCache = { at: now, set: new Set(openids) };
  } catch (err) {
    allowlistCache = { at: 0, set: null };
    return false;
  }
  return allowlistCache.set.has(openid);
}
async function canUseTestData(db, openid, scope) {
  if (!scope.testMode) return true;
  if (await isProductionSuperadmin(db, openid)) return true;
  return isAllowlistedTestAccount(db, openid);
}
module.exports = { createDataScope, isProductionSuperadmin, isAllowlistedTestAccount, canUseTestData };
