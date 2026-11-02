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

// BEGIN shared transaction retry: only confirmed transaction aborts may be replayed.
function isTransactionConflict(error) {
  if (!error || error.businessCode || error.isBusiness) return false;
  return error.code === 'DATABASE_TRANSACTION_CONFLICT' || error.errCode === 'DATABASE_TRANSACTION_CONFLICT' ||
    /\b(database transaction conflict|write conflict)\b/i.test(String(error.errMsg || error.message || ''));
}
async function transactionWithRetry(db, operation) {
  for (let attempt = 0; ; attempt++) {
    let transaction;
    try {
      transaction = await db.startTransaction();
      const result = await operation(transaction);
      await transaction.commit();
      return result;
    } catch (error) {
      if (transaction) { try { await transaction.rollback(); } catch (_) {} }
      if (!isTransactionConflict(error) || attempt >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1) + Math.floor(Math.random() * 30)));
    }
  }
}
// END shared transaction retry.

// cloudfunctions/checkWeeklyCode/index.js
//用于提交内容时的验证
const cloud = require('wx-server-sdk');
const { createDataScope, canUseTestData , isProductionSuperadmin } = require('./dataScope');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

// 辅助函数：计算本周日的日期 (YYYY-MM-DD)，基于北京时间
function getWeekKey(bjTime) {
  const day = bjTime.getUTCDay(); // 0=周日 ... 6=周六
  const diff = (7 - day) % 7;
  const sun = new Date(bjTime.getTime());
  sun.setUTCDate(bjTime.getUTCDate() + diff);
  return sun.toISOString().split('T')[0];
}

// 同一首内容的判定不依赖用户填写的歌手名，防止通过修改歌手规避重复检查。
// NFKC 会统一全角/半角字符；其余处理忽略大小写、空白和常见标点差异。
function normalizeSongName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

// 新记录直接用 song_key 精确判重；同时扫描最多 250 条旧记录，兼容升级前
// 没有 song_key 的数据。removed / rejected 不再占用同名限制。
async function inspectWeekSubmissions(transaction, submissionsCollection, weekKey, songKey) {
  const [exact, legacy, pendingRows] = await Promise.all([
    transaction.collection(submissionsCollection)
      .where({ week_key: weekKey, song_key: songKey })
      .field({ _id: true, status: true })
      .limit(20)
      .get(),
    transaction.collection(submissionsCollection)
      .where({ week_key: weekKey })
      .field({ song_name: true, song_key: true, status: true })
      .limit(250)
      .get(),
    transaction.collection(submissionsCollection)
      .where({ week_key: weekKey, status: 'pending' })
      .field({ _id: true }).limit(250).get()
  ]);

  const isActive = item => !['removed', 'rejected'].includes(item.status);
  const exactDuplicate = exact.data.some(isActive);
  const legacyDuplicate = legacy.data.some(item =>
    isActive(item) && !item.song_key && normalizeSongName(item.song_name) === songKey
  );

  return {
    pendingTotal: pendingRows.data.length,
    duplicate: exactDuplicate || legacyDuplicate
  };
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const probe = await probeTextSafety(event, OPENID); if (probe) return probe;
  const scope = createDataScope(event);
  if (!(await canUseTestData(db, OPENID, scope))) {
    return { success: false, message: '测试数据仅限超级管理员访问' };
  }
  const submissionsCollection = scope.collection('submissions');
  const countersCollection = scope.collection('submission_counters');
  const codesCollection = scope.collection('weekly_codes');
  const configsCollection = scope.collection('configs');
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
  const songKey = normalizeSongName(title);

  // 1. 基础参数校验
  if (!weeklyCode || !title || !remark) {
    return { success: false, message: '参数不完整，请检查网络和输入' };
  }

  // 2. 时间窗口校验（北京时间：周五20:00，含起点，至周日20:00，不含终点）
  const now = new Date();
  const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);

  // 检查超管通道开关
  let channelForceOpen = false;
  let channelForceClose = false;
  try {
    const overrideRes = await db.collection(configsCollection).doc('channel_override').get();
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
    const day = bjTime.getUTCDay(), hour = bjTime.getUTCHours();
    const isWithinWindow = (day === 5 && hour >= 20) || day === 6 || (day === 0 && hour < 20);
    if (!isWithinWindow) {
      return { success: false, message: '提交通道仅在每周五 20:00 至周日 20:00 开放' };
    }
  }

  // Safety completes before the transaction; service failures never silently pass.
  const safety = await checkTextSafety(cloud, OPENID, [title, remark, specialNote].filter(Boolean).join(' '), scope.testMode);
  if (!safety.passed) return { success: false, code: safety.code, message: safety.message };

  const weekKey = getWeekKey(bjTime); // 基于北京时间获取本周日标识
  try {
    const result = await transactionWithRetry(db, async transaction => {
      // A. 检查验证码是否有效
      const codeRes = await transaction.collection(codesCollection)
        .where({ code: weeklyCode, is_published: true })
        .limit(1)
        .get();

      if (codeRes.data.length === 0) {
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
        return { success: false, message: '该验证码已过期' };
      }

      // B. 检查该用户本周是否已提交 (防刷)
      const historyRes = await transaction.collection(submissionsCollection)
        .where({ user_id: OPENID, week_key: weekKey })
        .limit(1)
        .get();

      if (historyRes.data.length > 0) {
        const previous = historyRes.data[0];
        // A retry of the same submitted payload is a confirmation, never a new song or counter increment.
        if (previous.song_name === title && previous.singer === remark && (previous.special_note || '') === specialNote) {
          return { success: true, alreadySubmitted: true, message: '你的本周点歌已收到，无需重复提交' };
        }
        return { success: false, code: 'ALREADY_SUBMITTED', message: '你本周已经提交过了，请刷新首页查看' };
      }

      // Read the shared week counter before candidate queries. Its write conflict
      // serializes concurrent submissions and commits the visible count with the song.
      const counter = await transaction.collection(countersCollection).where({ _id: weekKey }).limit(1).get();
      const previousCount = counter.data.length ? counter.data[0].count : 0;
      if (!Number.isSafeInteger(previousCount) || previousCount < 0) throw Object.assign(new Error('invalid submission counter'), { code: 'COUNTER_INVALID' });

      // B2. 以规范化后的名称判重；歌手/补充说明不参与唯一性判断。
      // 250 条之后仍保存记录，但状态为 overflow，不进入抽取池。
      const weekSummary = await inspectWeekSubmissions(transaction, submissionsCollection, weekKey, songKey);

      if (weekSummary.duplicate) {
        return { success: false, message: '本周已有同名内容，请换一个吧' };
      }

      // C. 前 250 条为 pending，后续为 overflow。两者都是真实投稿记录，
      // 这样用户换设备或刷新后仍能看到自己提交的曲目。
      const submissionStatus = weekSummary.pendingTotal >= 250 ? 'overflow' : 'pending';
      await transaction.collection(submissionsCollection).add({
        data: {
          user_id: OPENID,
          song_name: title,
          song_key: songKey,
          singer: remark,
          special_note: specialNote || '',
          week_key: weekKey, // 修复点：使用 week_key 字段
          submit_time: db.serverDate(),
          status: submissionStatus,
          overflow_at: submissionStatus === 'overflow' ? db.serverDate() : null
        }
    });

    const counterRef = transaction.collection(countersCollection).doc(weekKey);
    if (counter.data.length) await counterRef.update({ data: { count: previousCount + 1 } });
    else await counterRef.set({ data: { count: 1 } });
    return { success: true, message: `提交成功！已提交《${title}》`, totalSubmissions: previousCount + 1 };
    });

    return result;

  } catch (e) {
    // SDK codes aid diagnosis without logging user content, identifiers or database queries.
    const sdkCode = e && typeof e.code === 'string' && /^[A-Z_]{3,80}$/.test(e.code) ? e.code : e && Number.isInteger(e.errCode) ? e.errCode : 'UNKNOWN';
    console.warn('[提交] 事务未确认', { code: sdkCode, conflict: isTransactionConflict(e) });
    // 唯一索引冲突 = 并发重复提交（需先在控制台创建 user_id+week_key 唯一索引）
    if (e && e.message && (e.message.includes('duplicate') || e.message.includes('E11000'))) {
      return { success: false, code: 'ALREADY_SUBMITTED', message: '你本周已经提交过了，请刷新首页查看' };
    }
    if (isTransactionConflict(e)) return { success: false, code: 'SUBMISSION_BUSY', message: '当前提交较多，请稍后再试；填写内容已保留' };
    // A lost commit acknowledgement can mean a saved song. Never replay an unknown failure blindly.
    return { success: false, code: 'SUBMISSION_UNCERTAIN', message: '暂时无法确认提交结果，请刷新首页查看；填写内容已保留' };
  }
};
