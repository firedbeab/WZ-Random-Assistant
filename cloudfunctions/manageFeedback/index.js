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
    let res;
    try { res = await cloud.openapi.security.msgSecCheck({ openid, scene: 2, version: 2, content }); }
    catch (_) { const e = new Error('内容检查暂不可用，请稍后再试'); e.businessCode = 'SAFETY_UNAVAILABLE'; throw e; }
    if (!res.result || res.result.suggest !== 'pass') { const e = new Error('文字未通过安全检查，请修改后再试'); e.businessCode = 'CONTENT_REJECTED'; throw e; }
  }
});
exports.main = async (event = {}) => service(event, cloud.getWXContext().OPENID);
