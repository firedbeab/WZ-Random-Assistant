'use strict';
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
async function canUseTestData(db, openid, scope) {
  return !scope.testMode || isProductionSuperadmin(db, openid);
}
module.exports = { createDataScope, isProductionSuperadmin, canUseTestData };
