// cloudfunctions/manageWeeklyCode/index.js
const cloud = require('wx-server-sdk');
const { createDataScope, canUseTestData } = require('./dataScope');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function isValidCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9]{4,20}$/.test(value);
}

function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidDocId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

function getWeekKey(bjTime) {
  const day = bjTime.getUTCDay(); // 0=周日 ... 6=周六
  const diff = (7 - day) % 7;
  const sun = new Date(bjTime.getTime());
  sun.setUTCDate(bjTime.getUTCDate() + diff);
  return sun.toISOString().split('T')[0];
}

exports.main = async (event, context) => {
  const { action, codeId, code, expireDate } = event;
  const scope = createDataScope(event);
  const usersCollection = scope.collection('users');
  const codesCollection = scope.collection('weekly_codes');

  // ===== 权限校验：仅管理员可操作 =====
  const { OPENID } = cloud.getWXContext();
  if (OPENID) {
    if (!(await canUseTestData(db, OPENID, scope))) {
      return { success: false, message: '仅超级管理员可使用测试环境' };
    }
    const userRes = await db.collection(usersCollection)
      .where({ openid: OPENID }).limit(1).get();
    if (userRes.data.length === 0 ||
        !['admin', 'superadmin'].includes(userRes.data[0].role)) {
      return { success: false, message: '无权限访问' };
    }
  } else {
    return { success: false, message: '无权限访问' };
  }

  // 1. 列出所有验证码（按创建时间倒序），同时清理已过期的
  if (action === 'list') {
    try {
      // 获取当前北京时间，用于比较过期时间
      const now = new Date();
      const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      const todayStr = bjTime.toISOString().split('T')[0]; // YYYY-MM-DD

      // 先删除已过期的验证码
      const expiredRes = await db.collection(codesCollection)
        .where({ expire_date: db.command.lt(todayStr) })
        .get();

      if (expiredRes.data.length > 0) {
        const deletePromises = expiredRes.data.map(doc =>
          db.collection(codesCollection).doc(doc._id).remove()
        );
        await Promise.all(deletePromises);
        console.log(`[验证码清理] 已删除 ${expiredRes.data.length} 个过期验证码`);
      }

      // 再返回剩余的有效验证码
      const res = await db.collection(codesCollection)
        .orderBy('_id', 'desc')
        .get();
      return { success: true, data: res.data };
    } catch (err) {
      console.warn('[验证码] 查询失败:', err.message || '未知错误');
      return { success: false, message: '查询失败，请稍后重试' };
    }
  }

  // 2. 手动添加验证码
  if (action === 'add') {
    if (!isValidCode(code)) {
      return { success: false, message: '验证码须为4-20位字母或数字' };
    }
    if (!isValidDateString(expireDate)) {
      return { success: false, message: '过期日期格式不正确' };
    }
    try {
      // 检查是否已存在相同验证码
      const existRes = await db.collection(codesCollection)
        .where({ code })
        .count();
      if (existRes.total > 0) {
        return { success: false, message: '该验证码已存在' };
      }

      // 计算周标识
      const now = new Date();
      const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      const weekKey = getWeekKey(bjTime);

      await db.collection(codesCollection).add({
        data: {
          code,
          week_key: weekKey,
          expire_date: expireDate,
          is_published: false,
          is_used: false,
          type: 'manual',
          description: '管理员手动添加',
          created_at: db.serverDate()
        }
      });
      return { success: true, message: '添加成功' };
    } catch (err) {
      console.warn('[验证码] 添加失败:', err.message || '未知错误');
      return { success: false, message: '添加失败，请稍后重试' };
    }
  }

  // 3. 编辑验证码（草稿状态）
  if (action === 'update') {
    if (!isValidDocId(codeId)) {
      return { success: false, message: '验证码记录无效' };
    }
    if (!isValidCode(code)) {
      return { success: false, message: '验证码须为4-20位字母或数字' };
    }
    if (!isValidDateString(expireDate)) {
      return { success: false, message: '过期日期格式不正确' };
    }
    try {
      const docRes = await db.collection(codesCollection).doc(codeId).get();
      if (docRes.data.is_published) {
        return { success: false, message: '已发布的验证码不可修改' };
      }

      // 检查是否与其他验证码重复
      const existRes = await db.collection(codesCollection)
        .where({ code, _id: db.command.neq(codeId) })
        .count();
      if (existRes.total > 0) {
        return { success: false, message: '该验证码已存在' };
      }

      await db.collection(codesCollection).doc(codeId).update({
        data: { code, expire_date: expireDate }
      });
      return { success: true, message: '保存成功' };
    } catch (err) {
      console.warn('[验证码] 保存失败:', err.message || '未知错误');
      return { success: false, message: '保存失败，请稍后重试' };
    }
  }

  // 4. 发布验证码（发布后不可改）
  if (action === 'publish') {
    if (!isValidDocId(codeId)) {
      return { success: false, message: '验证码记录无效' };
    }
    try {
      const docRes = await db.collection(codesCollection).doc(codeId).get();
      if (docRes.data.is_published) {
        return { success: false, message: '该验证码已发布' };
      }

      await db.collection(codesCollection).doc(codeId).update({
        data: { is_published: true }
      });
      return { success: true, message: '发布成功' };
    } catch (err) {
      console.warn('[验证码] 发布失败:', err.message || '未知错误');
      return { success: false, message: '发布失败，请稍后重试' };
    }
  }

  // 5. 删除验证码（草稿状态）
  if (action === 'delete') {
    if (!isValidDocId(codeId)) {
      return { success: false, message: '验证码记录无效' };
    }
    try {
      const docRes = await db.collection(codesCollection).doc(codeId).get();
      if (docRes.data.is_published) {
        return { success: false, message: '已发布的验证码不可删除' };
      }

      await db.collection(codesCollection).doc(codeId).remove();
      return { success: true, message: '删除成功' };
    } catch (err) {
      console.warn('[验证码] 删除失败:', err.message || '未知错误');
      return { success: false, message: '删除失败，请稍后重试' };
    }
  }

  return { success: false, message: '未知操作' };
};
