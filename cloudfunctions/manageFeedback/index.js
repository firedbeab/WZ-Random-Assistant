// BEGIN shared text safety: only an explicit pass may be published.
async function checkTextSafety(cloud, openid, content, testMode = false) {
  if (testMode || !content.trim()) return { passed: true, unavailable: false };
  const unavailable = { passed: false, unavailable: true, code: 'SAFETY_UNAVAILABLE', message: '内容检查暂时不可用，请稍后重试；填写内容已保留' };
  try {
    const result = await cloud.openapi.security.msgSecCheck({ openid, scene: 2, version: 2, content });
    if (!result || (result.errCode !== undefined && result.errCode !== 0)) return unavailable;
    const suggest = result.result && result.result.suggest;
    if (suggest === 'pass') return { passed: true, unavailable: false };
    if (suggest === 'risky' || suggest === 'review') return { passed: false, unavailable: false, code: 'CONTENT_REJECTED', message: '内容未通过安全检查，请修改后重试' };
    return unavailable;
  } catch (error) {
    const sdkCode = error && Number.isInteger(error.errCode) ? error.errCode : 'UNKNOWN';
    console.warn('[内容安全] 检查未完成', { code: sdkCode });
    return { ...unavailable, sdkCode };
  }
}
// END shared text safety.

// Read-only health check: production superadmin only, never bypasses safety in test mode.
async function probeTextSafety(event, openid) {
  if (!event || event.action !== 'checkTextSafety') return null;
  if (!await isProductionSuperadmin(db, openid)) return { success: false, code: 'FORBIDDEN', message: '无权限访问' };
  if (typeof event.content !== 'string' || !event.content.trim() || event.content.length > 300) return { success: false, message: '请输入1至300字的检查内容' };
  return { success: true, data: await checkTextSafety(cloud, openid, event.content.trim(), false) };
}

const cloud = require('wx-server-sdk');
const { createDataScope, canUseTestData, isProductionSuperadmin } = require('./dataScope');
const { createService } = require('./service');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
// 官方 SDK 支持缺失文档返回 null；查询失败仍抛错，不能将故障当作空数据。
const db = cloud.database({ throwOnNotFound: false });
const service = createService({ db, createDataScope, canUseTestData, isProductionSuperadmin,
  async checkText(content, openid, scope) {
    // 测试域仍经过身份白名单；与现有投稿测试策略一致，不调用正式内容安全配额。
    if (scope.testMode) return;
    const safety = await checkTextSafety(cloud, openid, content, false);
    if (!safety.passed) { const e = new Error(safety.message); e.businessCode = safety.code; throw e; }
  }
});
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const probe = await probeTextSafety(event, OPENID); if (probe) return probe;
  return service(event, OPENID);
};
