const PROD_ENV_ID = 'cloud1-d4g1y0o4n24d45fe6';
const TEST_PREFIX = 'test_';

function getEnvVersion() {
  try {
    const info = wx.getAccountInfoSync();
    return info && info.miniProgram && info.miniProgram.envVersion
      ? info.miniProgram.envVersion
      : 'develop';
  } catch (err) {
    // 无法确认版本时采用测试模式，避免开发过程误写正式数据。
    return 'develop';
  }
}

function isTestMode() {
  return getEnvVersion() !== 'release';
}

function collectionName(baseName) {
  if (typeof baseName !== 'string' || !/^[a-z][a-z0-9_]*$/.test(baseName)) {
    throw new Error('集合名称无效');
  }
  return `${isTestMode() ? TEST_PREFIX : ''}${baseName}`;
}

function storageKey(baseName) {
  if (typeof baseName !== 'string' || !baseName) throw new Error('缓存名称无效');
  return `${isTestMode() ? 'test' : 'prod'}_${baseName}`;
}

function cloudCall(options) {
  const safeOptions = options || {};
  return wx.cloud.callFunction({
    ...safeOptions,
    data: {
      ...(safeOptions.data || {}),
      _testMode: isTestMode()
    }
  });
}

function runtimeInfo() {
  const envVersion = getEnvVersion();
  return {
    cloudEnvId: PROD_ENV_ID,
    envVersion,
    isTestMode: envVersion !== 'release',
    collectionPrefix: envVersion !== 'release' ? TEST_PREFIX : ''
  };
}

module.exports = {
  PROD_ENV_ID,
  TEST_PREFIX,
  getEnvVersion,
  isTestMode,
  collectionName,
  storageKey,
  cloudCall,
  runtimeInfo
};
