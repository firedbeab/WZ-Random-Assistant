const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const { createDataScope, canUseTestData } = require('./dataScope');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// ================= 辅助函数 =================

// 获取本周日日期 (YYYY-MM-DD) 作为周标识（基于北京时间）
function getWeekKey() {
  const now = new Date();
  const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const day = bjTime.getUTCDay(); // 0=周日 ... 6=周六
  const diff = (7 - day) % 7;
  const sun = new Date(bjTime.getTime());
  sun.setUTCDate(bjTime.getUTCDate() + diff);
  return sun.toISOString().split('T')[0];
}

// 获取近2周标识（用于黑名单过滤，排除当前周）
function getHistoryKeys() {
  const keys = [];
  const now = new Date();
  const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  for (let i = 1; i <= 2; i++) {
    const d = new Date(bjTime.getTime());
    d.setUTCDate(d.getUTCDate() - (i * 7));
    const day = d.getUTCDay();
    const diff = (7 - day) % 7;
    d.setUTCDate(d.getUTCDate() + diff);
    keys.push(d.toISOString().split('T')[0]);
  }
  return keys;
}

function normalizeSongName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function getSongKey(item) {
  return item && item.song_key
    ? item.song_key
    : normalizeSongName(item && item.song_name);
}

// Fisher-Yates 洗牌算法
function shuffle(arr) {
  let m = arr.length, t, i;
  while (m) {
    i = crypto.randomInt(m--);
    t = arr[m]; arr[m] = arr[i]; arr[i] = t;
  }
  return arr;
}

// 排期会被小程序前端读取，只保存展示和后续审核真正需要的字段。
function toScheduleItem(submission) {
  return {
    submission_id: submission._id,
    song_name: submission.song_name,
    song_key: getSongKey(submission),
    singer: submission.singer,
    special_note: submission.special_note || '',
    is_repeat: false,
    source_week_key: submission.week_key || ''
  };
}

function uniqueBySong(items) {
  const uniqueMap = new Map();
  items.forEach(item => {
    const key = getSongKey(item);
    if (!key) return;
    if (!uniqueMap.has(key) || crypto.randomInt(2) === 0) uniqueMap.set(key, item);
  });
  return Array.from(uniqueMap.values());
}

async function removeAllMatching(collection, where) {
  let removed = 0;
  while (true) {
    const batch = await db.collection(collection).where(where).limit(100).get();
    if (batch.data.length === 0) break;
    const ids = batch.data.map(item => item._id);
    await db.collection(collection).where({ _id: _.in(ids) }).remove();
    removed += ids.length;
  }
  return removed;
}

async function fetchAll(collection, where, orderBy) {
  const rows = [];
  let offset = 0;
  while (true) {
    let query = db.collection(collection).where(where);
    if (orderBy) query = query.orderBy(orderBy.field, orderBy.direction);
    const batch = await query.skip(offset).limit(100).get();
    rows.push(...batch.data);
    if (batch.data.length < 100) break;
    offset += 100;
  }
  return rows;
}

// ================= 订阅消息通知 =================

// 向所有已订阅的管理员发送"有待审核排期"通知
async function notifyAdmins(weekKey, scope) {
  const ADMIN_TPL_ID = 'G9y63KY2Q0mPOS-ML_PtxVu9wqE5xKqVnnNgEFtPC_8';
  if (scope.testMode) {
    console.log('[测试环境] 已跳过管理员订阅消息发送');
    return;
  }
  const subscriptionsCollection = scope.collection('message_subscriptions');
  const usersCollection = scope.collection('users');
  try {
    let allSubs = [];
    let skip = 0;
    while (true) {
      const res = await db.collection(subscriptionsCollection)
        .where({ template_id: ADMIN_TPL_ID, type: 'admin', consumed: false })
        .skip(skip).limit(100).get();
      allSubs = allSubs.concat(res.data);
      if (res.data.length < 100) break;
      skip += 100;
    }
    console.log(`[通知] 找到 ${allSubs.length} 条管理员订阅`);

    if (allSubs.length === 0) {
      console.log('[通知] 无订阅记录，跳过通知');
      return;
    }

    // 按 openid 去重（同一管理员可能有多条订阅记录）
    const sentOpenids = new Set();

    for (const sub of allSubs) {
      // 同一管理员只发一次
      if (sentOpenids.has(sub.openid)) {
        console.log(`[通知] openid ${sub.openid.slice(0,6)}... 已发送过，标记重复记录为 consumed`);
        await db.collection(subscriptionsCollection).doc(sub._id).update({
          data: { consumed: true }
        });
        continue;
      }

      try {
        // 检查该用户是否仍是管理员（防止被撤销后仍收到通知）
        const userRes = await db.collection(usersCollection)
          .where({ openid: sub.openid }).limit(1).get();
        if (userRes.data.length === 0 ||
            !['admin', 'superadmin'].includes(userRes.data[0].role)) {
          console.log(`[通知] openid ${sub.openid.slice(0,6)}... 已不是管理员，跳过`);
          await db.collection(subscriptionsCollection).doc(sub._id).update({
            data: { consumed: true }
          });
          continue;
        }

        console.log(`[通知] 正在向 openid ${sub.openid.slice(0,6)}... 发送通知...`);
        await cloud.openapi.subscribeMessage.send({
          touser: sub.openid,
          templateId: ADMIN_TPL_ID,
          data: {
            date8: { value: weekKey },
            thing13: { value: '本周列表已生成，请前往审核' }
          },
          page: 'pages/admin/admin'
        });
        console.log(`[通知] ✅ 发送成功`);
        sentOpenids.add(sub.openid);
        await db.collection(subscriptionsCollection).doc(sub._id).update({
          data: { consumed: true }
        });
      } catch (e) {
        console.warn(`[通知] ❌ 发送失败 | errCode: ${e.errCode} | errMsg: ${e.errMsg || e.message || '未知'}`);
      }
    }
  } catch (err) {
    console.warn('[通知] 管理员通知流程异常:', err.errCode || '', err.errMsg || err.message || '未知错误');
  }
}

// ================= 主逻辑 =================

exports.main = async (event, context) => {
  const scope = createDataScope(event);
  const schedulesCollection = scope.collection('schedules');
  const submissionsCollection = scope.collection('submissions');
  const subscriptionsCollection = scope.collection('message_subscriptions');
  const usersCollection = scope.collection('users');
  // ===== 权限校验：仅管理员或定时任务可调用 =====
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
  }
  // OPENID 为空 → 定时任务触发，放行

  const weekKey = getWeekKey();
  console.log(`[抽取任务] 启动 | 周标识: ${weekKey}`);

  try {
    // 0. 清理过期排期数据：保留本周 + 前2周，更早的全部删除
    const keepKeys = [weekKey, ...getHistoryKeys()];
    // 0.1 清理过期提交；0.2 清理两周前已消费订阅。三个集合互不依赖，并行处理。
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const cleanupResults = await Promise.allSettled([
      removeAllMatching(schedulesCollection, { week_key: _.nin(keepKeys) }),
      removeAllMatching(submissionsCollection, { week_key: _.nin(keepKeys) }),
      removeAllMatching(subscriptionsCollection, { consumed: true, created_at: _.lt(twoWeeksAgo) })
    ]);
    const cleanupLabels = ['过期排期', '过期提交请求', '已消费订阅记录'];
    cleanupResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.warn(`[清理] ${cleanupLabels[index]}清理失败，本周抽取继续:`, result.reason?.message || '未知错误');
      }
    });
    const [totalCleaned, requestsCleaned, subsCleaned] = cleanupResults.map(result =>
      result.status === 'fulfilled' ? result.value : 0
    );
    if (totalCleaned > 0) console.log(`[清理] 已删除 ${totalCleaned} 条过期排期`);
    if (requestsCleaned > 0) console.log(`[清理] 已删除 ${requestsCleaned} 条过期提交请求`);
    if (subsCleaned > 0) console.log(`[清理] 已删除 ${subsCleaned} 条已消费订阅记录`);

    // 1. 本周候选与历史黑名单互不依赖，并行分页读取。
    const historyKeys = getHistoryKeys();
    const [allRequests, carryoverRequests, currentWeekUsers, allSchedules] = await Promise.all([
      fetchAll(
        submissionsCollection,
        { status: 'pending', week_key: weekKey },
        { field: 'submit_time', direction: 'asc' }
      ),
      fetchAll(
        submissionsCollection,
        { status: 'carryover', week_key: _.in(historyKeys) },
        { field: 'submit_time', direction: 'asc' }
      ),
      fetchAll(submissionsCollection, { week_key: weekKey }),
      fetchAll(schedulesCollection, { week_key: _.in(historyKeys), status: 'published' })
    ]);

    // 用户本周已提交（包括 overflow）时，不再用其历史候选补位，避免同一用户一周占两次机会。
    const currentUserIds = new Set(currentWeekUsers.map(item => item.user_id).filter(Boolean));
    const eligibleCarryover = carryoverRequests.filter(item => !currentUserIds.has(item.user_id));

    if (allRequests.length === 0 && eligibleCarryover.length === 0) {
      return { success: false, message: '本周及历史均无可用提交，任务跳过' };
    }

    // 2. 当前周与历史候选分别按规范化名称去重。当前周优先级始终更高。
    const currentUnique = uniqueBySong(allRequests);
    const currentSongKeys = new Set(currentUnique.map(getSongKey));
    const carryoverUnique = uniqueBySong(eligibleCarryover)
      .filter(item => !currentSongKeys.has(getSongKey(item)));

    // 3. 构建近2周已播放黑名单
    const historySet = new Set();
    allSchedules.forEach(pl => {
      ['day1','day2','day3','day4','day5'].forEach(d => {
        if (Array.isArray(pl[d])) {
          pl[d].forEach(s => historySet.add(getSongKey(s)));
        }
      });
    });

    // 4. 四级候选顺序：当周新内容 > 历史候选新内容 > 当周重复内容 > 历史候选重复内容。
    const pools = [
      currentUnique.filter(r => !historySet.has(getSongKey(r))),
      carryoverUnique.filter(r => !historySet.has(getSongKey(r))),
      currentUnique.filter(r => historySet.has(getSongKey(r))),
      carryoverUnique.filter(r => historySet.has(getSongKey(r)))
    ].map(pool => shuffle([...pool]));
    console.log(`[抽取] 当周:${allRequests.length} | 历史候选:${eligibleCarryover.length} | 四级池:${pools.map(p => p.length).join('/')}`);

    // 5. 填充 5天 × 4项 = 20个位置
    const schedule = { day1: [], day2: [], day3: [], day4: [], day5: [] };
    const days = ['day1','day2','day3','day4','day5'];
    const selectedIds = [];

    for (const day of days) {
      for (let i = 0; i < 4; i++) {
        const activePool = pools.find(pool => pool.length > 0);
        const item = activePool ? activePool.pop() : null;
        if (!item) break;

        const scheduleItem = toScheduleItem(item);
        scheduleItem.is_repeat = historySet.has(getSongKey(item));
        schedule[day].push(scheduleItem);
        selectedIds.push(item._id);
      }
    }

    if (selectedIds.length === 0) return { success: false, message: '无有效项目可抽取' };

    // 6. 事务写入
    const tx = await db.startTransaction();
    try {
      // 6.0 竞态检查：防止重复抽取（事务内检查是否已有待审核排期）
      const existingPending = await tx.collection(schedulesCollection)
        .where({ week_key: weekKey, status: 'pending' })
        .count();
      if (existingPending.total > 0) {
        await tx.rollback();
        return { success: false, message: '本周已有待审核排期，请勿重复抽取' };
      }

      // 6.1 写入周排期
      await tx.collection(schedulesCollection).add({
        data: {
          week_key: weekKey,
          status: 'pending',
          ...schedule,
          total_count: selectedIds.length,
          revision: 1,
          generated_at: db.serverDate()
        }
      });

      // 6.2 更新请求状态
      if (selectedIds.length > 0) {
        await tx.collection(submissionsCollection)
          .where({ _id: _.in(selectedIds) })
          .update({ data: { status: 'selected', picked_at: db.serverDate() } });
      }

      await tx.commit();
      console.log(`[抽取] ✅ 成功 | 已排期 ${selectedIds.length} 项`);

      // 抽取成功后，通知所有已订阅的管理员前往审核
      await notifyAdmins(weekKey, scope);

      return { success: true, message: `抽取完成，共 ${selectedIds.length} 个项目`, count: selectedIds.length };

    } catch (e) {
      await tx.rollback();
      throw e;
    }

  } catch (err) {
    console.warn('[抽取] 异常:', err.message || '未知错误');
    return { success: false, message: '抽取失败，请稍后重试' };
  }
};
