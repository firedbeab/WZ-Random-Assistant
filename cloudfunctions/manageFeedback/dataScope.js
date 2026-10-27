'use strict';

const TEST_PREFIX = 'test_';
const TEST_ACCOUNTS_DOC = 'test_accounts_v1';
let allowlistCache = { at: 0, set: null };

function createDataScope(event) {
  const testMode = Boolean(event && event._testMode === true);
  return {
    testMode,
    prefix: testMode ? TEST_PREFIX : '',
    collection(baseName) {
      if (typeof baseName !== 'string' || !/^[a-z][a-z0-9_]*$/.test(baseName)) {
        throw new Error('Invalid collection name');
      }
      return `${testMode ? TEST_PREFIX : ''}${baseName}`;
    }
  };
}

async function isProductionSuperadmin(db, openid) {
  if (!openid) return false;
  const res = await db.collection('users').where({ openid }).limit(1).get();
  return res.data.length > 0 && res.data[0].role === 'superadmin';
}

// 白名单只决定“能否进入测试域”，不代表任何管理角色；读取失败一律保守拒绝。
// 白名单固定存放在测试域集合，不能经 scope.collection('configs') 读取，否则正式域也会命中。
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
    // 集合不存在、权限或网络错误：保守拒绝，且不缓存失败结果，下一次重新读取。
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

module.exports = { TEST_PREFIX, createDataScope, isProductionSuperadmin, isAllowlistedTestAccount, canUseTestData };
