// cloudfunctions/autoGenerateWeeklyCode/index.js
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
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

exports.main = async (event, context) => {
  // ===== 权限校验：仅管理员或定时任务可调用 =====
  const { OPENID } = cloud.getWXContext();
  if (OPENID) {
    const userRes = await db.collection('users')
      .where({ openid: OPENID }).limit(1).get();
    if (userRes.data.length === 0 ||
        !['admin', 'superadmin'].includes(userRes.data[0].role)) {
      return { success: false, message: '无权限访问' };
    }
  }
  // OPENID 为空 → 定时任务触发，放行

  // 计算本周日日期（用于 week_key 标识，与其他云函数保持一致）
  const now = new Date();
  const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const dayOfWeek = bjTime.getUTCDay(); // 0=周日 ... 6=周六
  const diff = (7 - dayOfWeek) % 7; // 距本周日的天数
  const sun = new Date(bjTime.getTime());
  sun.setUTCDate(bjTime.getUTCDate() + diff);
  const weekKey = sun.toISOString().split('T')[0];

  console.log(`[自动生成周验证码] 本周标识(周日): ${weekKey}`);

  try {
    // 检查本周是否已有验证码
    const existRes = await db.collection('weekly_codes')
      .where({ week_key: weekKey })
      .count();

    if (existRes.total > 0) {
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
      db.collection('weekly_codes').add({
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

    console.log(`[自动生成周验证码] 成功生成3个: ${codes.join(', ')}`);
    return { success: true, message: '自动生成3个周验证码', codes: codes.map(c => c.substring(0, 2) + '****') };

  } catch (err) {
    console.warn('[自动生成周验证码] 异常:', err.message || '未知错误');
    return { success: false, message: '生成失败，请稍后重试' };
  }
};
