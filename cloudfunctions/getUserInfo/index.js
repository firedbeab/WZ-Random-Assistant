//用户信息获取
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();

  try {
    // 用户资料与通道状态互不依赖，并行读取以降低首页等待时间。
    const [userResult, overrideRes] = await Promise.all([
      db.collection('users').where({ openid: OPENID }).limit(1).get(),
      db.collection('configs').doc('channel_override').get().catch(() => null)
    ]);

    // configs 集合或 channel_override 文档不存在 → 通道未强制
    const channelForceOpen = !!(overrideRes && overrideRes.data.forceOpen === true);
    const channelForceClose = !!(overrideRes && overrideRes.data.forceClose === true);

    if (userResult.data.length > 0) {
      const userData = userResult.data[0];
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
        role: 'user',
        points: 0,
        created_at: db.serverDate()
      };

      try {
        const addRes = await db.collection('users').add({ data: newUser });
        newUser._id = addRes._id;
      } catch (addErr) {
        // 并发场景：另一个请求已创建同一用户，重新查询
        if (addErr.errCode === -502001 || addErr.message?.includes('duplicate')) {
          const retry = await db.collection('users')
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
};image.png
