// cloudfunctions/checkWeeklyCode/index.js
//用于提交内容时的验证
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

// 辅助函数：计算本周日的日期 (YYYY-MM-DD)，基于北京时间
function getWeekKey(bjTime) {
  const day = bjTime.getUTCDay(); // 0=周日 ... 6=周六
  const diff = (7 - day) % 7;
  const sun = new Date(bjTime.getTime());
  sun.setUTCDate(bjTime.getUTCDate() + diff);
  return sun.toISOString().split('T')[0];
}

// 辅助函数：递增提交计数器
async function incrementSubmitCount(weekKey) {
  try {
    await db.collection('submission_counters').doc(weekKey).update({
      data: { count: _.inc(1) }
    });
    const res = await db.collection('submission_counters').doc(weekKey).get();
    return res.data.count;
  } catch (err) {
    // 文档不存在，创建并初始化为1
    try {
      await db.collection('submission_counters').add({
        data: { _id: weekKey, count: 1 }
      });
      return 1;
    } catch (e) {
      return null;
    }
  }
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { weeklyCode, title: rawTitle, remark: rawRemark, specialNote: rawSpecialNote } = event;

  // 云函数可被绕过前端直接调用，先校验类型，避免非字符串触发运行异常。
  if (typeof weeklyCode !== 'string' ||
      typeof rawTitle !== 'string' ||
      typeof rawRemark !== 'string' ||
      (rawSpecialNote !== undefined && typeof rawSpecialNote !== 'string')) {
    return { success: false, message: '参数格式错误' };
  }

  // 输入过滤：去除尖括号
  const sanitize = (str) => {
    if (!str) return '';
    return str.replace(/[<>]/g, '').trim();
  };

  // 长度校验：拒绝超长输入（前端 maxlength=50，这里二次校验）
  if (rawTitle && rawTitle.length > 50) {
    return { success: false, message: '内容名称不能超过50个字符' };
  }
  if (rawRemark && rawRemark.length > 50) {
    return { success: false, message: '补充说明不能超过50个字符' };
  }
  if (rawSpecialNote && rawSpecialNote.length > 50) {
    return { success: false, message: '特殊备注不能超过50个字符' };
  }

  const title = sanitize(rawTitle);
  const remark = sanitize(rawRemark);
  const specialNote = sanitize(rawSpecialNote || '');

  // 1. 基础参数校验
  if (!weeklyCode || !title || !remark) {
    return { success: false, message: '参数不完整，请检查网络和输入' };
  }

  // 2. 时间窗口校验 (周日 8:00 - 20:00)
  const now = new Date();
  const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);

  // 检查超管通道开关
  let channelForceOpen = false;
  let channelForceClose = false;
  try {
    const overrideRes = await db.collection('configs').doc('channel_override').get();
    channelForceOpen = overrideRes.data.forceOpen === true;
    channelForceClose = overrideRes.data.forceClose === true;
  } catch (e) {
    // 文档不存在，忽略
  }

  // 强制关闭优先于一切：完全锁定通道
  if (channelForceClose) {
    return { success: false, message: '提交通道已关闭（假期模式），暂不接受提交' };
  }

  if (!channelForceOpen) {
    const isSunday = bjTime.getUTCDay() === 0;
    const isWithinHours = bjTime.getUTCHours() >= 8 && bjTime.getUTCHours() < 20;
    if (!(isSunday && isWithinHours)) {
      return { success: false, message: '提交通道仅在周日 8:00-20:00 开放' };
    }
  }

  // 3. 文本内容安全检查（调用微信 msgSecCheck 接口）
  // 将 title 和 remark 合并检查，不通过则拒绝提交
  try {
    const checkContent = specialNote ? `${title} ${remark} ${specialNote}` : `${title} ${remark}`;
    const secResult = await cloud.openapi.security.msgSecCheck({
      openid: OPENID,
      scene: 2,       // 评论场景
      version: 2,
      content: checkContent
    });

    if (secResult && secResult.result && secResult.result.suggest === 'risky') {
      return { success: false, message: '内容包含敏感词，请检查后重新输入' };
    }
  } catch (secErr) {
    // 安全检查接口失败时不阻断用户正常提交，仅记录警告日志
    // 若持续失败需排查：openid 是否过期、接口配额是否用尽
    console.warn('[安全检查] msgSecCheck 调用失败，已跳过:', secErr.errCode || secErr.message);
  }

  const weekKey = getWeekKey(bjTime); // 基于北京时间获取本周日标识
  const transaction = await db.startTransaction();

  try {
    // A. 检查验证码是否有效
    const codeRes = await transaction.collection('weekly_codes')
      .where({ code: weeklyCode, is_published: true })
      .limit(1)
      .get();

    if (codeRes.data.length === 0) {
      await transaction.rollback();
      return { success: false, message: '验证码错误' };
    }

    const codeDoc = codeRes.data[0];

    // 【业务确认】：这里未检查 codeDoc.is_used。
    // 如果验证码是"全班通用"的（多人可用同一码），则不检查 is_used 是对的。
    // 如果验证码是"一次性"的，则需要检查 is_used。

    // 检查验证码是否过期
    // expire_date 是 YYYY-MM-DD，按北京时间自然日比较；到期日当天仍然有效。
    const bjDateString = bjTime.toISOString().split('T')[0];
    if (codeDoc.expire_date && codeDoc.expire_date < bjDateString) {
      await transaction.rollback();
      return { success: false, message: '该验证码已过期' };
    }

    // B. 检查该用户本周是否已提交 (防刷)
    const historyRes = await transaction.collection('submissions')
      .where({ user_id: OPENID, week_key: weekKey })
      .get();

    if (historyRes.data.length > 0) {
      await transaction.rollback();
      return { success: false, message: '你本周已经提交过了' };
    }

    // B2. 检查本周是否已有相同内容被提交（标题+补充 完全匹配）
    const dupRes = await transaction.collection('submissions')
      .where({ week_key: weekKey, song_name: title, singer: remark })
      .count();

    if (dupRes.total > 0) {
      await transaction.rollback();
      return { success: false, message: '该内容已被提交过，请换一个吧' };
    }

    // C. 检查本周总提交数是否已达250条上限
    const totalRes = await transaction.collection('submissions')
      .where({ week_key: weekKey })
      .count();
    const totalCount = totalRes.total || 0;

    if (totalCount >= 250) {
      await transaction.rollback();
      const totalSubmissions = await incrementSubmitCount(weekKey);
      return { success: true, message: `提交成功！已提交《${title}》`, totalSubmissions };
    }

    // D. 写入提交记录
    await transaction.collection('submissions').add({
      data: {
        user_id: OPENID,
        song_name: title,
        singer: remark,
        special_note: specialNote || '',
        week_key: weekKey, // 修复点：使用 week_key 字段
        submit_time: db.serverDate(),
        status: 'pending'
      }
    });

    await transaction.commit();

    const totalSubmissions = await incrementSubmitCount(weekKey);

    return {
      success: true,
      message: `提交成功！已提交《${title}》`,
      totalSubmissions
    };

  } catch (e) {
    console.warn('[提交] 事务异常:', e.message || '未知错误');
    await transaction.rollback();
    // 唯一索引冲突 = 并发重复提交（需先在控制台创建 user_id+week_key 唯一索引）
    if (e.message && (e.message.includes('duplicate') || e.message.includes('E11000'))) {
      return { success: false, message: '你本周已经提交过了' };
    }
    return { success: false, message: '系统繁忙，提交失败' };
  }
};
