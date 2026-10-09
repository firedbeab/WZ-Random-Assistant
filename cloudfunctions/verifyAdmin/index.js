const cloud = require('wx-server-sdk');
const bcrypt = require('bcryptjs');
const { createDataScope, canUseTestData } = require('./dataScope');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 超管通行码哈希由云函数环境变量注入，避免进入源码和 Git 历史。
const SUPER_ADMIN_HASH = (process.env.SUPER_ADMIN_HASH || '').trim();

// 暴力破解防护配置
const MAX_FAIL_COUNT = 5;       // 最大连续失败次数
const LOCK_DURATION_MS = 15 * 60 * 1000; // 锁定时长：15 分钟

/**
 * 检查用户是否被锁定（暴力破解防护）
 * 返回 { locked: true/false, remainingSeconds: 剩余秒数 }
 */
async function checkLock(openid, attemptsCollection) {
  try {
    const res = await db.collection(attemptsCollection).doc(openid).get();
    const doc = res.data;
    if (doc.locked_until) {
      const now = Date.now();
      const lockUntil = new Date(doc.locked_until).getTime();
      if (now < lockUntil) {
        const remainingSeconds = Math.ceil((lockUntil - now) / 1000);
        return { locked: true, remainingSeconds };
      }
      // 锁定已过期，自动解锁
      await db.collection(attemptsCollection).doc(openid).update({
        data: { fail_count: 0, locked_until: null }
      });
    }
    return { locked: false };
  } catch (err) {
    // 文档不存在 → 从未尝试过，不锁定
    return { locked: false };
  }
}

/**
 * 记录一次失败尝试，达到上限则锁定
 * 使用 _.inc(1) 原子递增，确保并发请求下计数准确
 */
async function recordFailure(openid, attemptsCollection) {
  const now = new Date();
  try {
    // 原子递增（关键：_.inc 是数据库级别的原子操作，并发安全）
    await db.collection(attemptsCollection).doc(openid).update({
      data: {
        fail_count: _.inc(1),
        last_attempt: now
      }
    });
    // 递增后读取实际计数，判断是否达到锁定阈值
    const res = await db.collection(attemptsCollection).doc(openid).get();
    if (res.data.fail_count >= MAX_FAIL_COUNT) {
      const lockUntil = new Date(now.getTime() + LOCK_DURATION_MS);
      await db.collection(attemptsCollection).doc(openid).update({
        data: { locked_until: lockUntil }
      });
      return { locked: true };
    }
    return { locked: false, failCount: res.data.fail_count };
  } catch (err) {
    // 文档不存在，创建并初始化为1
    try {
      await db.collection(attemptsCollection).add({
        data: { _id: openid, fail_count: 1, locked_until: null, last_attempt: now }
      });
      return { locked: false, failCount: 1 };
    } catch (e) {
      // 并发创建（duplicate），重试递增
      try {
        await db.collection(attemptsCollection).doc(openid).update({
          data: { fail_count: _.inc(1), last_attempt: now }
        });
        const res = await db.collection(attemptsCollection).doc(openid).get();
        if (res.data.fail_count >= MAX_FAIL_COUNT) {
          const lockUntil = new Date(now.getTime() + LOCK_DURATION_MS);
          await db.collection(attemptsCollection).doc(openid).update({
            data: { locked_until: lockUntil }
          });
          return { locked: true };
        }
        return { locked: false, failCount: res.data.fail_count };
      } catch (retryErr) {
        return { locked: false, failCount: 1 };
      }
    }
  }
}

/**
 * 验证成功时清除失败记录
 */
async function clearAttempts(openid, attemptsCollection) {
  try {
    await db.collection(attemptsCollection).doc(openid).update({
      data: { fail_count: 0, locked_until: null }
    });
  } catch (err) {
    // 文档不存在，无需清除
  }
}

async function recordSecurityEvent(scope, entry) {
  try {
    await db.collection(scope.collection('system_events')).add({
      data: Object.assign({
        category: 'security', severity: 'warning', created_at: db.serverDate()
      }, entry)
    });
  } catch (err) {
    console.warn('[管理员验证] 安全事件写入失败:', err.message || '未知错误');
  }
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { adminCode, action } = event;
  const scope = createDataScope(event);
  const attemptsCollection = scope.collection('login_attempts');
  const passcodesCollection = scope.collection('admin_passcodes');
  const usersCollection = scope.collection('users');

  if (!(await canUseTestData(db, OPENID, scope))) {
    return { success: false, message: '仅超级管理员可使用测试环境' };
  }

  // 1. 验证通行码并赋权
  if (action === 'verify') {
    if (typeof adminCode !== 'string' || !adminCode || adminCode.length > 64) {
      return { success: false, message: '通行码格式错误' };
    }
    if (!SUPER_ADMIN_HASH) {
      console.error('[管理员验证] 缺少 SUPER_ADMIN_HASH 环境变量');
      return { success: false, message: '管理员验证暂不可用，请联系负责人' };
    }
    try {
      // ===== 暴力破解防护：检查是否被锁定 =====
      const lockStatus = await checkLock(OPENID, attemptsCollection);
      if (lockStatus.locked) {
        const minutes = Math.ceil(lockStatus.remainingSeconds / 60);
        await recordSecurityEvent(scope, {
          action: 'admin_verify.blocked', operator_openid: OPENID,
          result: 'locked', remaining_seconds: lockStatus.remainingSeconds
        });
        return { success: false, message: `尝试次数过多，请 ${minutes} 分钟后再试` };
      }

      // 判断是否为超管验证码（使用 bcrypt 比对哈希）
      const isSuperAdmin = bcrypt.compareSync(adminCode, SUPER_ADMIN_HASH);
      let role = 'admin';
      let adminLabel = '超级管理员'; // 默认标签（超管）

      if (isSuperAdmin) {
        role = 'superadmin';
      } else {
        // 普通管理员：遍历 admin_passcodes 集合，bcrypt 比对
        const passcodes = await db.collection(passcodesCollection).get();
        let matched = false;
        for (const pc of passcodes.data) {
          if (bcrypt.compareSync(adminCode, pc.code_hash)) {
            matched = true;
            adminLabel = pc.label || '管理员'; // 保存通行码标签
            break;
          }
        }
        if (!matched) {
          // 验证失败：记录失败次数（原子递增，并发安全）
          const result = await recordFailure(OPENID, attemptsCollection);
          await recordSecurityEvent(scope, {
            action: 'admin_verify.failed', operator_openid: OPENID,
            result: result.locked ? 'locked' : 'invalid_code',
            fail_count: result.failCount || MAX_FAIL_COUNT
          });
          if (result.locked) {
            return { success: false, message: `尝试次数过多，已锁定 15 分钟` };
          }
          const remaining = MAX_FAIL_COUNT - (result.failCount || 0);
          return { success: false, message: `通行码错误，还剩 ${remaining} 次尝试机会` };
        }
      }

      // 验证成功：清除失败记录
      await clearAttempts(OPENID, attemptsCollection);

      // 检查用户文档是否存在
      const userRes = await db.collection(usersCollection).where({ openid: OPENID }).get();

      if (userRes.data.length > 0) {
        // 用户已存在，更新角色和标签
        await db.collection(usersCollection).where({ openid: OPENID }).update({
          data: {
            role: role,
            admin_label: adminLabel,
            last_admin_verify: db.serverDate()
          }
        });
      } else {
        // 用户文档不存在，创建并赋权
        await db.collection(usersCollection).add({
          data: {
            openid: OPENID,
            role: role,
            admin_label: adminLabel,
            points: 0,
            last_admin_verify: db.serverDate(),
            created_at: db.serverDate()
          }
        });
      }

      await recordSecurityEvent(scope, {
        action: 'admin_verify.success', operator_openid: OPENID,
        severity: 'info', result: 'success', role
      });
      return { success: true, message: '验证成功', role: role };
    } catch (err) {
      console.warn('[管理员验证] 系统异常:', err.message || '未知错误');
      await recordSecurityEvent(scope, {
        category: 'system_error', action: 'admin_verify.error',
        operator_openid: OPENID, severity: 'error',
        error: String(err.message || '未知错误').slice(0, 500)
      });
      return { success: false, message: '系统繁忙，请稍后重试' };
    }
  }

  return { success: false, message: '未知请求' };
};
