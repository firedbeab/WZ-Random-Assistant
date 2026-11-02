// cloudfunctions/autoGenerateWeeklyCode/index.js
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const { createDataScope, canUseTestData } = require('./dataScope');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(chars.length)];
  }
  return code;
}

exports.main = async (event = {}, context) => {
  const scope = createDataScope(event);
  const codesCollection = scope.collection('weekly_codes');
  const configsCollection = scope.collection('configs');
  // ===== 权限校验：仅管理员或定时任务可调用 =====
  const { OPENID, SOURCE } = cloud.getWXContext();
  if (OPENID) {
    if (!await canUseTestData(db, OPENID, scope)) return { success: false, code: 'TEST_ACCESS_DENIED', message: '无权限使用测试数据' };
    const userRes = await db.collection(scope.collection('users'))
      .where({ openid: OPENID }).limit(1).get();
    if (userRes.data.length === 0 ||
        !['admin', 'superadmin'].includes(userRes.data[0].role)) {
      return { success: false, message: '无权限访问' };
    }
  }
  else if (SOURCE !== 'wx_trigger' || scope.testMode) return { success: false, code: 'FORBIDDEN', message: '无权限访问' };
  // Only a platform timer may generate production codes without a user.

  // 计算本周日日期（用于 week_key 标识，与其他云函数保持一致）
  const now = new Date();
  const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const dayOfWeek = bjTime.getUTCDay(); // 0=周日 ... 6=周六
  const diff = (7 - dayOfWeek) % 7; // 距本周日的天数
  const sun = new Date(bjTime.getTime());
  sun.setUTCDate(bjTime.getUTCDate() + diff);
  const weekKey = sun.toISOString().split('T')[0];

  console.log(`[自动生成周验证码] 本周标识(周日): ${weekKey}`);

  let tx;
  try {
    tx = await db.startTransaction();
    const guardId = 'code_guard_' + weekKey;
    const guard = (await tx.collection(configsCollection).where({ _id: guardId }).limit(1).get()).data[0];
    // 检查本周是否已有验证码
    const existRes = await tx.collection(codesCollection).where({ week_key: weekKey }).limit(1).get();

    if (existRes.data.length > 0) {
      await tx.rollback();
      return { success: false, message: '本周验证码已存在，跳过生成' };
    }

    // 生成3个验证码
    const codes = [];
    for (let i = 0; i < 3; i++) {
      let code = generateCode();
      // 确保不重复
      while (codes.includes(code)) {
        code = generateCode();
      }
      codes.push(code);
    }

    // 计算过期时间：有效期至周日 24:00 北京时间 = 周一 0:00 UTC
    // 先将 sun 归零到周日 0:00 UTC，再加 24h 得到周一 0:00 UTC
    const sunMidnight = new Date(sun.getTime());
    sunMidnight.setUTCHours(0, 0, 0, 0);
    const expireTime = new Date(sunMidnight.getTime() + 24 * 60 * 60 * 1000);
    const expireDate = expireTime.toISOString().split('T')[0];

    // 写入数据库
    const addPromises = codes.map(code =>
      tx.collection(codesCollection).add({
        data: {
          code,
          week_key: weekKey,
          expire_date: expireDate,
          is_published: true, // 自动生成的直接可用
          is_used: false,
          type: 'weekly',
          description: '系统自动生成',
          created_at: db.serverDate()
        }
      })
    );
    await Promise.all(addPromises);
    await tx.collection(configsCollection).doc(guardId).set({ data: { revision: (Number(guard && guard.revision) || 0) + 1, updated_at: db.serverDate() } });
    await tx.commit();

    console.log('[自动生成周验证码] 已生成3个', { testMode: scope.testMode, weekKey });
    return { success: true, message: '自动生成3个周验证码', codes: codes.map(c => c.substring(0, 2) + '****') };

  } catch (err) {
    if (tx) { try { await tx.rollback(); } catch (_) {} }
    console.warn('[自动生成周验证码] 生成结果未确认');
    return { success: false, message: '生成结果暂未确认，请刷新验证码列表后再操作' };
  }
};
