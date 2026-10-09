// cloudfunctions/testTool/index.js
//testTool仅供开发者（超级管理员）操作使用，仅用于测试和紧急维护
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const { createDataScope, canUseTestData } = require('./dataScope');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const CLEANUP_TOKEN_TTL_MS = 2 * 60 * 1000;
const CLEANUP_CONFIRMATIONS = {
  week: '清空本周',
  subscriptions: '清空订阅'
};

function getWeekKey(bjTime) {
  const day = bjTime.getUTCDay();
  const diff = (7 - day) % 7;
  const sun = new Date(bjTime.getTime());
  sun.setUTCDate(bjTime.getUTCDate() + diff);
  return sun.toISOString().split('T')[0];
}

function normalizeSongName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

// 计算指定周偏移的 week_key（0=本周, 1=上周, 2=上上周）
function getWeekKeyByOffset(bjTime, offset) {
  const day = bjTime.getUTCDay();
  const diff = day === 0 ? 0 : -day;
  const sun = new Date(bjTime.getTime());
  sun.setUTCDate(bjTime.getUTCDate() + diff - (offset * 7));
  return sun.toISOString().split('T')[0];
}

// 循环删除集合中匹配条件的记录（解决单次 .remove() 有上限的问题）
async function removeAll(collection, where) {
  let total = 0;
  while (true) {
    const res = await db.collection(collection).where(where).limit(100).get();
    if (res.data.length === 0) break;
    const ids = res.data.map(d => d._id);
    const del = await db.collection(collection).where({ _id: _.in(ids) }).remove();
    total += del.stats?.removed || 0;
  }
  return total;
}

function hashText(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getCleanupTokenDocId(openid) {
  return `test_cleanup_token_${hashText(openid).slice(0, 20)}`;
}

async function countMatching(collection, where) {
  const res = await db.collection(collection).where(where).count();
  return res.total;
}

async function getWeekCleanupPreview(weekKey, dataScope) {
  const counterExists = db.collection(dataScope.collection('submission_counters')).doc(weekKey).get()
    .then(() => 1)
    .catch(() => 0);
  const [submissions, schedules, weeklyCodes, exceptions, subscriptions, counters] =
    await Promise.all([
      countMatching(dataScope.collection('submissions'), { week_key: weekKey }),
      countMatching(dataScope.collection('schedules'), { week_key: weekKey }),
      countMatching(dataScope.collection('weekly_codes'), { week_key: weekKey }),
      countMatching(dataScope.collection('schedule_exceptions'), { week_key: weekKey }),
      countMatching(dataScope.collection('message_subscriptions'), { week_key: weekKey }),
      counterExists
    ]);

  const preview = {
    submissions,
    schedules,
    weekly_codes: weeklyCodes,
    schedule_exceptions: exceptions,
    message_subscriptions: subscriptions,
    submission_counters: counters
  };

  preview.total = Object.values(preview).reduce((sum, value) => sum + value, 0);
  return preview;
}

async function getSubscriptionsCleanupPreview(dataScope) {
  const total = await countMatching(dataScope.collection('message_subscriptions'), {});
  return { message_subscriptions: total, total };
}

// 审计日志暂存于现有 configs 集合，保留最近 50 条，避免新增集合后还需人工建表。
async function appendCleanupAudit(entry, dataScope) {
  const ref = db.collection(dataScope.collection('configs')).doc('test_tool_cleanup_audit');
  let entries = [];
  try {
    const res = await ref.get();
    if (Array.isArray(res.data.entries)) entries = res.data.entries;
  } catch (e) {
    entries = [];
  }

  entries.unshift(Object.assign({ recorded_at: new Date().toISOString() }, entry));
  await ref.set({
    data: {
      entries: entries.slice(0, 50),
      updated_at: db.serverDate()
    }
  });
}

async function createCleanupToken(cleanupScope, openid, weekKey, preview, dataScope) {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAtMs = Date.now() + CLEANUP_TOKEN_TTL_MS;
  const ref = db.collection(dataScope.collection('configs')).doc(getCleanupTokenDocId(openid));

  await ref.set({
    data: {
      token_hash: hashText(token),
      scope: cleanupScope,
      operator_openid: openid,
      week_key: weekKey,
      preview,
      confirmation_text: CLEANUP_CONFIRMATIONS[cleanupScope],
      expires_at_ms: expiresAtMs,
      used: false,
      created_at: db.serverDate()
    }
  });

  return { token, expiresAtMs };
}

async function verifyCleanupToken(cleanupScope, openid, weekKey, token, confirmationText, dataScope) {
  if (!token || confirmationText !== CLEANUP_CONFIRMATIONS[cleanupScope]) {
    return { success: false, message: '服务端二次确认失败，请重新预览后操作' };
  }

  const ref = db.collection(dataScope.collection('configs')).doc(getCleanupTokenDocId(openid));
  let tokenData;
  try {
    const res = await ref.get();
    tokenData = res.data;
  } catch (e) {
    return { success: false, message: '确认令牌不存在，请重新预览后操作' };
  }

  const invalid = tokenData.used === true ||
    tokenData.scope !== cleanupScope ||
    tokenData.operator_openid !== openid ||
    tokenData.week_key !== weekKey ||
    Number(tokenData.expires_at_ms) < Date.now() ||
    tokenData.token_hash !== hashText(token);

  if (invalid) {
    return { success: false, message: '确认令牌无效或已过期，请重新预览后操作' };
  }

  // 删除前先消费令牌，避免重复点击或网络重试造成二次删除。
  await ref.update({
    data: {
      used: true,
      used_at: db.serverDate()
    }
  });

  return { success: true, preview: tokenData.preview || {} };
}

const TITLES = [
  '晨曦', '星空', '海风', '山岚', '溪流',
  '落叶', '飞雪', '春雨', '夏蝉', '秋月',
  '云端', '极光', '彩虹', '暮色', '朝霞',
  '花语', '竹影', '松涛', '浪花', '沙漏',
  '星辰', '月光', '阳光', '微风', '细雨',
  '远山', '近水', '古桥', '小径', '长廊',
  '晨雾', '夜灯', '书香', '画卷', '琴韵',
  '诗行', '梦境', '回忆', '未来', '现在',
  '春天', '夏日', '秋收', '冬藏', '四季',
  '花开', '叶落', '鸟鸣', '虫吟', '潮汐',
  '日出', '日落', '月升', '月落', '星河',
  '青山', '绿水', '田园', '村落', '古城',
  '新城', '老街', '小巷', '广场', '公园',
  '海边', '山间', '林里', '湖畔', '河谷',
  '草原', '沙漠', '绿洲', '冰川', '火山',
  '瀑布', '清泉', '幽谷', '密林', '旷野'
];
const REMARKS = [
  '推荐', '经典', '热门', '精选', '收藏',
  '新作', '原创', '转载', '系列', '专题',
  '日常', '随笔', '笔记', '心得', '感悟',
  '分享', '交流', '讨论', '问答', '评测',
  '教程', '攻略', '指南', '清单', '合集',
  '早间', '午间', '晚间', '周末', '假期',
  '学习', '工作', '休闲', '运动', '旅行',
  '美食', '阅读', '音乐', '影视', '游戏',
  '自然', '科技', '艺术', '文学', '历史',
  '地理', '天文', '生物', '化学', '物理',
  '轻松', '治愈', '欢快', '安静', '深沉',
  '温暖', '清凉', '甜蜜', '苦涩', '平淡',
  '日常', '特殊', '纪念', '庆祝', '仪式',
  '早晨', '黄昏', '深夜', '正午', '黎明',
  '春日', '夏夜', '秋晨', '冬午', '四季',
  '灵感', '创意', '想象', '思考', '探索'
];

exports.main = async (event) => {
  const { action, count, offset } = event;
  const dataScope = createDataScope(event);
  const submissionsCollection = dataScope.collection('submissions');
  const schedulesCollection = dataScope.collection('schedules');
  const codesCollection = dataScope.collection('weekly_codes');
  const exceptionsCollection = dataScope.collection('schedule_exceptions');
  const countersCollection = dataScope.collection('submission_counters');
  const subscriptionsCollection = dataScope.collection('message_subscriptions');
  const usersCollection = dataScope.collection('users');
  const configsCollection = dataScope.collection('configs');

  // ===== 权限校验：仅超级管理员可操作 =====
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { success: false, message: '需要用户身份验证' };
  }
  if (!(await canUseTestData(db, OPENID, dataScope))) {
    return { success: false, message: '仅超级管理员可使用测试环境' };
  }
  const userRes = await db.collection(usersCollection)
    .where({ openid: OPENID }).limit(1).get();
  if (userRes.data.length === 0 || userRes.data[0].role !== 'superadmin') {
    return { success: false, message: '无权限访问' };
  }

  const now = new Date();
  const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const weekKey = getWeekKey(bjTime);
  const TEST_ONLY_ACTIONS = new Set([
    'generateRequests', 'generateCodes', 'simulateSubmitted', 'generateCarryover', 'runDraw',
    'clearWeek', 'generatePublished', 'generateAllPublished'
  ]);
  if (TEST_ONLY_ACTIONS.has(action) && !dataScope.testMode) {
    return { success: false, blocked: true, message: '该测试操作只能在测试版中执行' };
  }

  // 清理操作必须先获取影响预览和两分钟一次性令牌。
  if (action === 'previewCleanup') {
    const { scope } = event;

    // 当前项目只有正式云环境，全量清空在服务端永久禁用。
    if (scope === 'all') {
      try {
        await appendCleanupAudit({
          action: 'clearAll',
          status: 'blocked',
          operator_openid: OPENID,
          reason: 'production_guard'
        }, dataScope);
      } catch (e) {
        console.error('[testTool] 记录拦截日志失败:', e.message);
      }
      return {
        success: false,
        blocked: true,
        message: '正式云环境已永久禁用“清空所有数据”'
      };
    }

    if (!Object.prototype.hasOwnProperty.call(CLEANUP_CONFIRMATIONS, scope)) {
      return { success: false, message: '不支持的清理范围' };
    }

    try {
      const preview = scope === 'week'
        ? await getWeekCleanupPreview(weekKey, dataScope)
        : await getSubscriptionsCleanupPreview(dataScope);
      const tokenInfo = await createCleanupToken(scope, OPENID, weekKey, preview, dataScope);
      return {
        success: true,
        scope,
        weekKey,
        preview,
        confirmationText: CLEANUP_CONFIRMATIONS[scope],
        confirmationToken: tokenInfo.token,
        expiresInSeconds: Math.floor(CLEANUP_TOKEN_TTL_MS / 1000)
      };
    } catch (err) {
      console.error('[testTool] 生成清理预览失败:', err.message);
      return { success: false, message: '无法生成清理预览，请稍后重试' };
    }
  }

  // 1. 批量生成提交请求
  if (action === 'generateRequests') {
    const num = count || 50;
    try {
      await removeAll(submissionsCollection, { week_key: weekKey });

      const data = [];
      for (let i = 0; i < num; i++) {
        const idx = i % TITLES.length;
        data.push({
          user_id: `test_user_${i}`,
          song_name: TITLES[idx],
          singer: REMARKS[idx],
          week_key: weekKey,
          submit_time: db.serverDate(),
          status: 'pending'
        });
      }
      const batchSize = 500;
      for (let i = 0; i < data.length; i += batchSize) {
        const batch = data.slice(i, i + batchSize);
        const tasks = batch.map(item =>
          db.collection(submissionsCollection).add({ data: item })
        );
        await Promise.all(tasks);
      }
      return { success: true, message: `已生成 ${num} 条提交请求` };
    } catch (err) {
      console.warn('[testTool] 生成提交失败:', err.message || '未知错误');
      return { success: false, message: '生成失败，请检查云函数日志' };
    }
  }

  // 2. 生成验证码
  if (action === 'generateCodes') {
    try {
      await removeAll(codesCollection, { week_key: weekKey });

      const codes = ['TEST01', 'TEST02', 'TEST03'];
      const expireDate = '2026-12-31';
      const tasks = codes.map(code =>
        db.collection(codesCollection).add({
          data: {
            code, week_key: weekKey, expire_date: expireDate,
            is_published: true, type: 'test',
            description: '测试用验证码', created_at: db.serverDate()
          }
        })
      );
      await Promise.all(tasks);
      return { success: true, message: '已生成3个测试验证码：TEST01, TEST02, TEST03' };
    } catch (err) {
      console.warn('[testTool] 生成验证码失败:', err.message || '未知错误');
      return { success: false, message: '生成失败，请检查云函数日志' };
    }
  }

  // 3. 模拟已提交（当前用户）
  if (action === 'simulateSubmitted') {
    try {
      const existRes = await db.collection(submissionsCollection)
        .where({ user_id: OPENID, week_key: weekKey }).count();
      if (existRes.total > 0) {
        return { success: false, message: '当前用户本周已有提交记录' };
      }
      await db.collection(submissionsCollection).add({
        data: {
          user_id: OPENID, song_name: '测试内容A', singer: '测试备注A',
          week_key: weekKey, submit_time: db.serverDate(), status: 'pending'
        }
      });
      return { success: true, message: '已模拟当前用户提交' };
    } catch (err) {
      console.warn('[testTool] 模拟提交失败:', err.message || '未知错误');
      return { success: false, message: '操作失败，请检查云函数日志' };
    }
  }

  // 3.1 生成上一周历史候补，用于验证跨周补位逻辑。
  // 仅写入 test_ 数据域，且调用入口已经过正式超级管理员身份校验。
  if (action === 'generateCarryover') {
    const num = Math.max(1, Math.min(Number(count) || 3, 20));
    const currentWeek = new Date(`${weekKey}T00:00:00.000Z`);
    currentWeek.setUTCDate(currentWeek.getUTCDate() - 7);
    const previousWeekKey = currentWeek.toISOString().split('T')[0];
    const runId = Date.now();
    try {
      const tasks = Array.from({ length: num }, (_, index) =>
        db.collection(submissionsCollection).add({ data: {
          user_id: `test_carryover_${runId}_${index}`,
          song_name: `历史候补测试曲目${index + 1}`,
          song_key: normalizeSongName(`历史候补测试曲目${index + 1}`),
          singer: `历史候补歌手${index + 1}`,
          special_note: '测试环境跨周候补',
          week_key: previousWeekKey,
          submit_time: db.serverDate(),
          status: 'carryover',
          carryover_at: db.serverDate()
        }})
      );
      await Promise.all(tasks);
      return {
        success: true,
        message: `已生成 ${num} 条上一周历史候补`,
        weekKey: previousWeekKey,
        count: num
      };
    } catch (err) {
      console.warn('[testTool] 生成历史候补失败:', err.message || '未知错误');
      return { success: false, message: '生成失败，请检查云函数日志' };
    }
  }

  // 4. 一键抽取（调用 drawWeeklyPlaylist 逻辑）
  if (action === 'runDraw') {
    try {
      const drawResult = await cloud.callFunction({
        name: 'drawWeeklyPlaylist',
        data: { _testMode: true }
      });
      return drawResult.result;
    } catch (err) {
      console.warn('[testTool] 抽取失败:', err.message || '未知错误');
      return { success: false, message: '抽取失败，请检查云函数日志' };
    }
  }

  // 5. 清空本周所有测试数据（含 selected 项目和历史排期）
  if (action === 'clearWeek') {
    const guard = await verifyCleanupToken(
      'week', OPENID, weekKey, event.confirmationToken, event.confirmationText, dataScope
    );
    if (!guard.success) return guard;

    try {
      // 起始日志必须写入成功，否则拒绝执行删除。
      await appendCleanupAudit({
        action: 'clearWeek',
        status: 'started',
        operator_openid: OPENID,
        week_key: weekKey,
        preview: guard.preview
      }, dataScope);

      const reqDel = await removeAll(submissionsCollection, { week_key: weekKey });
      const scheduleDel = await removeAll(schedulesCollection, { week_key: weekKey });
      const codeDel = await removeAll(codesCollection, { week_key: weekKey });
      const exDel = await removeAll(exceptionsCollection, { week_key: weekKey });
      const subDel = await removeAll(subscriptionsCollection, { week_key: weekKey });
      // 清除本周提交计数器
      let counterDel = 0;
      try {
        await db.collection(countersCollection).doc(weekKey).remove();
        counterDel = 1;
      } catch (e) { /* 文档不存在则忽略 */ }

      const details = {
        submissions: reqDel,
        schedules: scheduleDel,
        weekly_codes: codeDel,
        schedule_exceptions: exDel,
        submission_counters: counterDel,
        message_subscriptions: subDel
      };
      try {
        await appendCleanupAudit({
          action: 'clearWeek',
          status: 'success',
          operator_openid: OPENID,
          week_key: weekKey,
          details
        }, dataScope);
      } catch (auditErr) {
        console.error('[testTool] 完成日志写入失败:', auditErr.message);
      }

      return {
        success: true,
        message: `已清空本周数据（请求:${reqDel} 排期:${scheduleDel} 验证码:${codeDel} 异常记录:${exDel} 计数器:${counterDel} 订阅:${subDel}）`,
        details
      };
    } catch (err) {
      try {
        await appendCleanupAudit({
          action: 'clearWeek',
          status: 'failed',
          operator_openid: OPENID,
          week_key: weekKey,
          error: err.message
        }, dataScope);
      } catch (auditErr) {
        console.error('[testTool] 失败日志写入失败:', auditErr.message);
      }
      console.error('[testTool] 清空本周失败:', err.message);
      return { success: false, message: '清空失败，请检查云函数日志' };
    }
  }

  // 6. 正式环境永久禁止全量清空，即使旧版前端直接调用也会被服务端拦截。
  if (action === 'clearAll') {
    try {
      await appendCleanupAudit({
        action: 'clearAll',
        status: 'blocked',
        operator_openid: OPENID,
        reason: 'production_guard'
      }, dataScope);
    } catch (e) {
      console.error('[testTool] 记录拦截日志失败:', e.message);
    }
    return { success: false, blocked: true, message: '正式云环境已永久禁用“清空所有数据”' };
  }

  // 7. 生成已发布排期（支持 offset 参数：0=本周, 1=上周, 2=上上周）
  if (action === 'generatePublished') {
    const off = offset || 0;
    const targetWeekKey = getWeekKeyByOffset(bjTime, off);
    try {
      await removeAll(schedulesCollection, { week_key: targetWeekKey });

      // 每期用不同的内容起始偏移，避免三期内容完全一样
      const startIdx = off * 5;
      const schedule = {};
      ['day1', 'day2', 'day3', 'day4', 'day5'].forEach((day, di) => {
        const items = [];
        for (let i = 0; i < 4; i++) {
          const idx = (startIdx + di * 4 + i) % TITLES.length;
          items.push({ song_name: TITLES[idx], singer: REMARKS[idx] });
        }
        schedule[day] = items;
      });

      await db.collection(schedulesCollection).add({
        data: {
          week_key: targetWeekKey, status: 'published',
          ...schedule, total_count: 20,
          admin_note: off === 0 ? '测试用已发布排期（本期）' : `测试用已发布排期（前${off}期）`,
          publish_time: db.serverDate(),
          generated_at: db.serverDate()
        }
      });
      const label = off === 0 ? '本期' : off === 1 ? '上一期' : '上上期';
      return { success: true, message: `已生成${label}测试排期（${targetWeekKey}）` };
    } catch (err) {
      console.warn('[testTool] 生成排期失败:', err.message || '未知错误');
      return { success: false, message: '生成失败，请检查云函数日志' };
    }
  }

  // 8. 生成全部3期已发布排期（本期 + 上一期 + 上上期）
  if (action === 'generateAllPublished') {
    try {
      const results = [];
      for (let off = 0; off <= 2; off++) {
        const targetWeekKey = getWeekKeyByOffset(bjTime, off);
        await removeAll(schedulesCollection, { week_key: targetWeekKey });

        const startIdx = off * 5;
        const schedule = {};
        ['day1', 'day2', 'day3', 'day4', 'day5'].forEach((day, di) => {
          const items = [];
          for (let i = 0; i < 4; i++) {
            const idx = (startIdx + di * 4 + i) % TITLES.length;
            items.push({ song_name: TITLES[idx], singer: REMARKS[idx] });
          }
          schedule[day] = items;
        });

        await db.collection(schedulesCollection).add({
          data: {
            week_key: targetWeekKey, status: 'published',
            ...schedule, total_count: 20,
            admin_note: off === 0 ? '测试用已发布排期（本期）' : `测试用已发布排期（前${off}期）`,
            publish_time: db.serverDate(),
            generated_at: db.serverDate()
          }
        });
        results.push(targetWeekKey);
      }
      return { success: true, message: `已生成3期测试排期：${results.join(', ')}` };
    } catch (err) {
      console.warn('[testTool] 批量生成排期失败:', err.message || '未知错误');
      return { success: false, message: '生成失败，请检查云函数日志' };
    }
  }

  // 9. 统计数据
  if (action === 'auditUserOpenidDuplicates') {
    try {
      const counts = new Map();
      let totalDocuments = 0;
      let withOpenid = 0;
      let missingOpenid = 0;
      let offset = 0;
      const pageSize = 100;

      while (true) {
        const res = await db.collection(usersCollection)
          .field({ openid: true })
          .skip(offset)
          .limit(pageSize)
          .get();
        const rows = res.data || [];
        totalDocuments += rows.length;

        for (const row of rows) {
          if (typeof row.openid !== 'string' || !row.openid.trim()) {
            missingOpenid += 1;
            continue;
          }
          withOpenid += 1;
          counts.set(row.openid, (counts.get(row.openid) || 0) + 1);
        }

        if (rows.length < pageSize) break;
        offset += pageSize;
      }

      let duplicateValueCount = 0;
      let duplicateDocumentCount = 0;
      let largestDuplicateGroup = 1;
      for (const count of counts.values()) {
        if (count > 1) {
          duplicateValueCount += 1;
          duplicateDocumentCount += count - 1;
          largestDuplicateGroup = Math.max(largestDuplicateGroup, count);
        }
      }

      // 只返回统计数字，绝不返回、记录或打印具体 openid。
      return {
        success: true,
        data: {
          totalDocuments,
          withOpenid,
          missingOpenid,
          uniqueOpenidCount: counts.size,
          duplicateValueCount,
          duplicateDocumentCount,
          largestDuplicateGroup: duplicateValueCount > 0 ? largestDuplicateGroup : 0
        }
      };
    } catch (err) {
      console.error('[testTool] 用户唯一性审计失败:', err.message);
      return { success: false, message: '用户唯一性审计失败，请检查云函数日志' };
    }
  }

  // 10. 统计数据
  if (action === 'stats') {
    try {
      const collections = [
        'submissions', 'schedules', 'weekly_codes',
        'schedule_exceptions', 'submission_counters',
        'message_subscriptions', 'users', 'system_events'
      ];
      // 所有统计互不依赖，并行执行，避免十余次数据库请求串行累加延迟。
      const [collectionCounts, weekReq, weekSch, selectedCount, consumedSub, unconsumedSub] = await Promise.all([
        Promise.all(collections.map(col => db.collection(dataScope.collection(col)).count())),
        db.collection(submissionsCollection).where({ week_key: weekKey }).count(),
        db.collection(schedulesCollection).where({ week_key: weekKey }).count(),
        db.collection(submissionsCollection).where({ status: 'selected' }).count(),
        db.collection(subscriptionsCollection).where({ consumed: true }).count(),
        db.collection(subscriptionsCollection).where({ consumed: false }).count()
      ]);

      const stats = {};
      collections.forEach((col, index) => {
        stats[col] = collectionCounts[index].total;
      });
      stats.submissions_selected = selectedCount.total;
      stats.subscriptions_consumed = consumedSub.total;
      stats.subscriptions_unconsumed = unconsumedSub.total;

      return {
        success: true,
        data: {
          total: stats,
          thisWeek: { submissions: weekReq.total, schedules: weekSch.total }
        }
      };
    } catch (err) {
      console.warn('[testTool] 统计失败:', err.message || '未知错误');
      return { success: false, message: '统计失败，请检查云函数日志' };
    }
  }

  // 11. 清空所有订阅记录（含已消费和未消费）
  if (action === 'clearSubscriptions') {
    const guard = await verifyCleanupToken(
      'subscriptions', OPENID, weekKey, event.confirmationToken, event.confirmationText, dataScope
    );
    if (!guard.success) return guard;

    try {
      await appendCleanupAudit({
        action: 'clearSubscriptions',
        status: 'started',
        operator_openid: OPENID,
        preview: guard.preview
      }, dataScope);
      const subDel = await removeAll(subscriptionsCollection, {});
      try {
        await appendCleanupAudit({
          action: 'clearSubscriptions',
          status: 'success',
          operator_openid: OPENID,
          details: { message_subscriptions: subDel }
        }, dataScope);
      } catch (auditErr) {
        console.error('[testTool] 完成日志写入失败:', auditErr.message);
      }
      return {
        success: true,
        message: `已清空所有订阅记录（共 ${subDel} 条）`,
        details: { message_subscriptions: subDel }
      };
    } catch (err) {
      try {
        await appendCleanupAudit({
          action: 'clearSubscriptions',
          status: 'failed',
          operator_openid: OPENID,
          error: err.message
        }, dataScope);
      } catch (auditErr) {
        console.error('[testTool] 失败日志写入失败:', auditErr.message);
      }
      console.error('[testTool] 清空订阅失败:', err.message);
      return { success: false, message: '清空失败，请检查云函数日志' };
    }
  }

  // 12. 切换通道开关（强制开放/强制关闭/恢复正常时间校验）
  if (action === 'toggleChannel') {
    // mode: 'open' = 强制开放, 'close' = 强制关闭, 'reset' = 恢复正常
    // 兼容旧版前端：若未传 mode 则根据 forceOpen 字段推断
    const { mode: rawMode, forceOpen } = event;
    const mode = rawMode || (forceOpen === true ? 'open' : 'reset');

    let data;
    let msg;
    if (mode === 'close') {
      data = { forceOpen: false, forceClose: true, updated_at: db.serverDate(), updated_by: OPENID };
      msg = '通道已强制关闭（假期模式）';
    } else if (mode === 'open') {
      data = { forceOpen: true, forceClose: false, updated_at: db.serverDate(), updated_by: OPENID };
      msg = '通道已强制开放';
    } else {
      data = { forceOpen: false, forceClose: false, updated_at: db.serverDate(), updated_by: OPENID };
      msg = '通道已恢复正常时间校验';
    }

    try {
      // set 同时覆盖“文档已存在”和“首次创建”两种情况。
      // update 在文档不存在时可能只返回 updated=0 而不抛错，不能用于这里的 upsert。
      await db.collection(configsCollection).doc('channel_override').set({ data });
      return { success: true, message: msg };
    } catch (outerErr) {
      console.error('[toggleChannel] 意外异常:', outerErr.message);
      console.warn('[testTool] 切换通道失败:', outerErr.message || '未知错误');
      return { success: false, message: '操作失败，请检查云函数日志' };
    }
  }

  // 13. 获取通道状态
  if (action === 'getChannelStatus') {
    try {
      const res = await db.collection(configsCollection).doc('channel_override').get();
      return {
        success: true,
        forceOpen: res.data.forceOpen === true,
        forceClose: res.data.forceClose === true
      };
    } catch (e) {
      return { success: true, forceOpen: false, forceClose: false };
    }
  }

  return { success: false, message: '未知操作' };
};
