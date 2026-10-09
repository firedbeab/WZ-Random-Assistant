//用户信息获取
const cloud = require('wx-server-sdk');
const { createDataScope, isProductionSuperadmin } = require('./dataScope');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const scope = createDataScope(event);
  const usersCollection = scope.collection('users');
  const configsCollection = scope.collection('configs');
  const schedulesCollection = scope.collection('schedules');
  const submissionsCollection = scope.collection('submissions');
  const countersCollection = scope.collection('submission_counters');

  try {
    let testSuperadmin = false;
    if (scope.testMode) {
      testSuperadmin = await isProductionSuperadmin(db, OPENID);
      if (!testSuperadmin) {
        return { success: false, message: '测试数据仅限超级管理员访问' };
      }
    }

    // 测试版不直接开放数据库集合读取权限；这些只读操作统一经云函数鉴权。
    if (event.action === 'getPublishedSchedule') {
      const weekKey = typeof event.weekKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(event.weekKey)
        ? event.weekKey
        : '';
      if (!weekKey) return { success: false, message: '周标识无效' };
      const result = await db.collection(schedulesCollection)
        .where({ week_key: weekKey, status: 'published' })
        .limit(1)
        .get();
      return { success: true, data: result.data[0] || null };
    }

    if (event.action === 'getMySubmission') {
      const weekKey = typeof event.weekKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(event.weekKey)
        ? event.weekKey
        : '';
      if (!weekKey) return { success: false, message: '周标识无效' };
      const result = await db.collection(submissionsCollection)
        .where({ user_id: OPENID, week_key: weekKey })
        .limit(1)
        .get();
      return { success: true, data: result.data[0] || null };
    }

    if (event.action === 'getSubmitCount') {
      const weekKey = typeof event.weekKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(event.weekKey)
        ? event.weekKey
        : '';
      if (!weekKey) return { success: false, message: '周标识无效' };
      try {
        const result = await db.collection(countersCollection).doc(weekKey).get();
        return { success: true, data: Number(result.data.count) || 0 };
      } catch (err) {
        return { success: true, data: 0 };
      }
    }

    // 用户资料与通道状态互不依赖，并行读取以降低首页等待时间。
    const [userResult, overrideRes] = await Promise.all([
      db.collection(usersCollection).where({ openid: OPENID }).limit(1).get(),
      db.collection(configsCollection).doc('channel_override').get().catch(() => null)
    ]);

    // configs 集合或 channel_override 文档不存在 → 通道未强制
    const channelForceOpen = !!(overrideRes && overrideRes.data.forceOpen === true);
    const channelForceClose = !!(overrideRes && overrideRes.data.forceClose === true);

    if (userResult.data.length > 0) {
      const userData = userResult.data[0];
      if (scope.testMode && testSuperadmin && userData.role !== 'superadmin') {
        await db.collection(usersCollection).doc(userData._id).update({
          data: { role: 'superadmin', synced_from_production_at: db.serverDate() }
        });
        userData.role = 'superadmin';
      }
      userData.channelForceOpen = channelForceOpen;
      userData.channelForceClose = channelForceClose;
      return {
        success: true,
        data: userData,
        message: '获取成功'
      };
    } else {
      const newUser = {
        openid: OPENID,
        role: testSuperadmin ? 'superadmin' : 'user',
        points: 0,
        data_scope: scope.testMode ? 'test' : 'production',
        created_at: db.serverDate()
      };

      try {
        const addRes = await db.collection(usersCollection).add({ data: newUser });
        newUser._id = addRes._id;
      } catch (addErr) {
        // 并发场景：另一个请求已创建同一用户，重新查询
        if (addErr.errCode === -502001 || addErr.message?.includes('duplicate')) {
          const retry = await db.collection(usersCollection)
            .where({ openid: OPENID })
            .limit(1)
            .get();
          if (retry.data.length > 0) {
            const retryData = retry.data[0];
            retryData.channelForceOpen = channelForceOpen;
            retryData.channelForceClose = channelForceClose;
            return { success: true, data: retryData, message: '获取成功' };
          }
        }
        throw addErr;
      }

      return {
        success: true,
        data: { ...newUser, channelForceOpen, channelForceClose },
        message: '新用户创建成功'
      };
    }
  } catch (err) {
    console.warn('[用户信息] 获取失败:', err.message || '未知错误');
    return {
      success: false,
      message: '获取用户信息失败，请稍后重试'
    };
  }
};
