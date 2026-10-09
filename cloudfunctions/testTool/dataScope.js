'use strict';

const TEST_PREFIX = 'test_';

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

async function canUseTestData(db, openid, scope) {
  return !scope.testMode || isProductionSuperadmin(db, openid);
}

module.exports = { TEST_PREFIX, createDataScope, isProductionSuperadmin, canUseTestData };
