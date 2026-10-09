// cloudfunctions/adminAuditPlaylist/index.js
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const { createDataScope, canUseTestData } = require('./dataScope');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function getSubmissionId(item) {
  return item && (item.submission_id || item._id);
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

function toScheduleItem(item) {
  return {
    submission_id: getSubmissionId(item),
    song_name: item.song_name,
    song_key: getSongKey(item),
    singer: item.singer,
    special_note: item.special_note || '',
    is_repeat: item.is_repeat === true
  };
}

function isValidDocId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

function isValidDayIndex(value) {
  return Number.isInteger(value) && value >= 0 && value <= 4;
}

function isValidSongIndex(value) {
  return Number.isInteger(value) && value >= 0 && value <= 99;
}

function safeOperationMessage(err, fallback) {
  const allowed = new Set(['排期状态已变更', '该日无项目', '项目索引无效']);
  return err && allowed.has(err.message) ? err.message : fallback;
}

function getPriorWeekKeys(weekKey) {
  const base = new Date(`${weekKey}T00:00:00.000Z`);
  return [1, 2].map(offset => {
    const d = new Date(base.getTime());
    d.setUTCDate(d.getUTCDate() - offset * 7);
    return d.toISOString().split('T')[0];
  });
}

async function appendSystemEvent(scope, entry) {
  try {
    await db.collection(scope.collection('system_events')).add({
      data: Object.assign({
        category: 'admin_action',
        severity: 'info',
        created_at: db.serverDate()
      }, entry)
    });
  } catch (err) {
    // 审计不可用不能让已完成的业务操作回滚；错误仍会进入云函数运行日志。
    console.warn('[审计] 写入 system_events 失败:', err.message || '未知错误');
  }
}

// ================= 订阅消息通知 =================

// 向所有已订阅的用户发送"排期已发布"通知
async function notifyStudents(weekKey, scope) {
  const STUDENT_TPL_ID = 'evJj_6Kl8CNKTf5C_j2PtJ6FPmMTbBESvuZ35DfOiGA';
  if (scope.testMode) {
    console.log('[测试模式] 已跳过真实用户订阅消息发送');
    return;
  }
  const subscriptionsCollection = scope.collection('message_subscriptions');
  try {
    let allSubs = [];
    let skip = 0;
    while (true) {
      const res = await db.collection(subscriptionsCollection)
        .where({
          template_id: STUDENT_TPL_ID,
          type: 'student',
          week_key: weekKey,
          consumed: false
        })
        .skip(skip).limit(100).get();
      allSubs = allSubs.concat(res.data);
      if (res.data.length < 100) break;
      skip += 100;
    }
    console.log(`[通知] 找到 ${allSubs.length} 条用户订阅`);

    // 构造发布时间（北京时间）
    const now = new Date();
    const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const month = bjTime.getUTCMonth() + 1;
    const day = bjTime.getUTCDate();
    const hours = String(bjTime.getUTCHours()).padStart(2, '0');
    const mins = String(bjTime.getUTCMinutes()).padStart(2, '0');
    const publishTime = `${month}月${day}日 ${hours}:${mins}`;

    // 按 openid 去重（同一用户可能有多条历史记录，只发一次）
    const sentOpenids = new Set();

    for (const sub of allSubs) {
      // 同一用户只发一次
      if (sentOpenids.has(sub.openid)) {
        await db.collection(subscriptionsCollection).doc(sub._id).update({
          data: { consumed: true }
        });
        continue;
      }

      try {
        await cloud.openapi.subscribeMessage.send({
          touser: sub.openid,
          templateId: STUDENT_TPL_ID,
          data: {
            time18: { value: publishTime },
            thing11: { value: '本周列表已发布，快来看看吧' }
          },
          page: 'pages/playlist/index'
        });
        sentOpenids.add(sub.openid);
        await db.collection(subscriptionsCollection).doc(sub._id).update({
          data: { consumed: true }
        });
      } catch (e) {
        console.warn('[通知] 发送用户消息失败:', e.errCode || '');
      }
    }
  } catch (err) {
    console.warn('[通知] 用户通知流程异常:', err.message || '未知错误');
  }
}

exports.main = async (event, context) => {
  const { action, playlistId, dayIndex, songIndex, reason } = event;
  const { OPENID } = cloud.getWXContext();
  const scope = createDataScope(event);
  if (!(await canUseTestData(db, OPENID, scope))) {
    return { success: false, message: '测试数据仅限超级管理员访问' };
  }
  const usersCollection = scope.collection('users');
  const schedulesCollection = scope.collection('schedules');
  const submissionsCollection = scope.collection('submissions');
  const exceptionsCollection = scope.collection('schedule_exceptions');

  // ===== 权限校验：仅管理员可操作（定时任务无 OPENID，此处不涉及） =====
  if (OPENID) {
    const userRes = await db.collection(usersCollection)
      .where({ openid: OPENID }).limit(1).get();
    if (userRes.data.length === 0 ||
        !['admin', 'superadmin'].includes(userRes.data[0].role)) {
      return { success: false, message: '无权限访问' };
    }
  } else {
    return { success: false, message: '无权限访问' };
  }

  // 1. 获取待审核排期
  if (action === 'getPending') {
    try {
      const res = await db.collection(schedulesCollection)
        .where({ status: 'pending' })
        .orderBy('generated_at', 'desc')
        .limit(1)
        .get();

      return res.data.length > 0
        ? { success: true, data: res.data[0] }
        : { success: false, message: '暂无待审核排期' };
    } catch (err) {
      console.warn('[审核] 查询排期失败:', err.message || '未知错误');
      return { success: false, message: '查询失败，请稍后重试' };
    }
  }

  // 2. 标记异常并自动替补
  if (action === 'markException') {
    if (!isValidDocId(playlistId) || !isValidDayIndex(dayIndex) || !isValidSongIndex(songIndex)) {
      return { success: false, message: '操作参数无效' };
    }
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 50)) {
      return { success: false, message: '原因不能超过50个字符' };
    }
    const tx = await db.startTransaction();
    try {
      // A. 获取当前排期
      const plRes = await tx.collection(schedulesCollection).doc(playlistId).get();
      const schedule = plRes.data;
      const beforeDay = Array.isArray(schedule[`day${dayIndex + 1}`])
        ? schedule[`day${dayIndex + 1}`].map(toScheduleItem)
        : [];
      if (schedule.status !== 'pending') throw new Error('排期状态已变更');

      // B. 移除异常项目
      const dayKey = `day${dayIndex + 1}`;
      if (!Array.isArray(schedule[dayKey]) || schedule[dayKey].length === 0) {
        throw new Error('该日无项目');
      }
      if (songIndex < 0 || songIndex >= schedule[dayKey].length) {
        throw new Error('项目索引无效');
      }
      const removedItem = schedule[dayKey].splice(songIndex, 1)[0];
      const removedSubmissionId = getSubmissionId(removedItem);

      // C. 记录异常日志
      await tx.collection(exceptionsCollection).add({
        data: {
          schedule_id: playlistId,
          week_key: schedule.week_key,
          day: dayKey,
          original_item: toScheduleItem(removedItem),
          reason: reason || '管理员手动移除',
          operator: OPENID,
          created_at: db.serverDate()
        }
      });

      // D. 替补优先使用本周 pending；不足时再从前两周 carryover 中选择。
      const priorWeekKeys = getPriorWeekKeys(schedule.week_key);
      const [currentCandidates, carryoverCandidates, currentWeekRecords] = await Promise.all([
        tx.collection(submissionsCollection)
          .where({ week_key: schedule.week_key, status: 'pending' }).limit(100).get(),
        tx.collection(submissionsCollection)
          .where({ week_key: _.in(priorWeekKeys), status: 'carryover' }).limit(100).get(),
        tx.collection(submissionsCollection)
          .where({ week_key: schedule.week_key }).limit(100).get()
      ]);

      // 构建当前排期已包含的项目集合
      const existingItems = new Set();
      ['day1','day2','day3','day4','day5'].forEach(d => {
        if (Array.isArray(schedule[d])) {
          schedule[d].forEach(s => existingItems.add(getSongKey(s)));
        }
      });

      // 过滤掉已在排期中的候选项目
      const currentUsers = new Set(currentWeekRecords.data.map(item => item.user_id).filter(Boolean));
      const filterCandidates = list => list.filter(c =>
        !existingItems.has(getSongKey(c)) && !currentUsers.has(c.user_id)
      );
      // 本周候选本身当然属于 currentUsers，不应用“本周已有提交”过滤。
      const validCurrent = currentCandidates.data.filter(c => !existingItems.has(getSongKey(c)));
      const validCarryover = filterCandidates(carryoverCandidates.data);
      const validCandidates = validCurrent.length > 0 ? validCurrent : validCarryover;

      let replacement = null;
      // 被移出排期的原提交不应继续保持 selected 状态。
      if (removedSubmissionId) {
        await tx.collection(submissionsCollection).doc(removedSubmissionId).update({
          data: { status: 'rejected', rejected_at: db.serverDate() }
        });
      }

      if (validCandidates.length > 0) {
        const randomIdx = crypto.randomInt(validCandidates.length);
        replacement = validCandidates[randomIdx];

        // 更新替补项目状态为 selected
        await tx.collection(submissionsCollection).doc(replacement._id).update({
          data: { status: 'selected', picked_at: db.serverDate() }
        });

        // 加入排期
        schedule[dayKey].push({
          submission_id: replacement._id,
          song_name: replacement.song_name,
          song_key: getSongKey(replacement),
          singer: replacement.singer,
          special_note: replacement.special_note || '',
          is_repeat: false
        });
      }

      // E. 更新排期
      await tx.collection(schedulesCollection).doc(playlistId).update({
        data: {
          [dayKey]: schedule[dayKey],
          revision: (Number(schedule.revision) || 1) + 1,
          updated_at: db.serverDate()
        }
      });

      await tx.commit();
      await appendSystemEvent(scope, {
        action: 'schedule.mark_exception', operator_openid: OPENID,
        target_type: 'schedule', target_id: playlistId, week_key: schedule.week_key,
        before: { [dayKey]: beforeDay }, after: { [dayKey]: schedule[dayKey].map(toScheduleItem) },
        reason: reason || '管理员手动移除'
      });
      return { success: true, message: replacement ? '已替换' : '已移除 (无替补)' };

    } catch (e) {
      await tx.rollback();
      console.warn('[审核] 标记异常失败:', e.message || '未知错误');
      return { success: false, message: safeOperationMessage(e, '操作失败，请稍后重试') };
    }
  }

  // 3. 跳过某一天（清空该日所有项目）
  if (action === 'skipDay') {
    if (!isValidDocId(playlistId) || !isValidDayIndex(dayIndex)) {
      return { success: false, message: '操作参数无效' };
    }
    const tx = await db.startTransaction();
    try {
      const plRes = await tx.collection(schedulesCollection).doc(playlistId).get();
      const schedule = plRes.data;
      if (schedule.status !== 'pending') throw new Error('排期状态已变更');

      const dayKey = `day${dayIndex + 1}`;
      const removedItems = schedule[dayKey] || [];
      const removedSubmissionIds = removedItems.map(getSubmissionId).filter(Boolean);

      // 清空该日项目
      await tx.collection(schedulesCollection).doc(playlistId).update({
        data: {
          [dayKey]: [],
          revision: (Number(schedule.revision) || 1) + 1,
          updated_at: db.serverDate()
        }
      });

      // 记录跳过操作日志
      if (removedItems.length > 0) {
        await tx.collection(exceptionsCollection).add({
          data: {
            schedule_id: playlistId,
            week_key: schedule.week_key,
            day: dayKey,
            original_item: { count: removedItems.length, items: removedItems.map(toScheduleItem) },
            reason: '管理员跳过该日',
            operator: OPENID,
            created_at: db.serverDate()
          }
        });
      }


      if (removedSubmissionIds.length > 0) {
        await tx.collection(submissionsCollection)
          .where({ _id: _.in(removedSubmissionIds) })
          .update({ data: { status: 'rejected', rejected_at: db.serverDate() } });
      }

      await tx.commit();
      await appendSystemEvent(scope, {
        action: 'schedule.skip_day', operator_openid: OPENID,
        target_type: 'schedule', target_id: playlistId, week_key: schedule.week_key,
        before: { [dayKey]: removedItems.map(toScheduleItem) }, after: { [dayKey]: [] },
        reason: '管理员跳过该日'
      });
      const dayLabel = ['周一', '周二', '周三', '周四', '周五'][dayIndex];
      return { success: true, message: `已跳过「${dayLabel}」` };

    } catch (e) {
      await tx.rollback();
      console.warn('[审核] 跳过日期失败:', e.message || '未知错误');
      return { success: false, message: safeOperationMessage(e, '操作失败，请稍后重试') };
    }
  }

  // 4. 确认发布
  if (action === 'publish') {
    const { note } = event;
    if (!isValidDocId(playlistId)) {
      return { success: false, message: '排期记录无效' };
    }
    if (note !== undefined && (typeof note !== 'string' || note.length > 100)) {
      return { success: false, message: '发布备注不能超过100个字符' };
    }
    let weekKey;

    // 事务：读取 + 状态检查 + 状态更新（防止重复发布和中途失败）
    const tx = await db.startTransaction();
    try {
      const plRes = await tx.collection(schedulesCollection).doc(playlistId).get();
      const schedule = plRes.data;

      // 防止重复发布
      if (schedule.status !== 'pending') {
        await tx.rollback();
        return { success: false, message: '该排期已发布或状态已变更' };
      }

      weekKey = schedule.week_key;

      await tx.collection(schedulesCollection).doc(playlistId).update({
        data: {
          status: 'published',
          admin_note: note || '',
          revision: (Number(schedule.revision) || 1) + 1,
          publish_time: db.serverDate()
        }
      });

      await tx.commit();
      await appendSystemEvent(scope, {
        action: 'schedule.publish', operator_openid: OPENID,
        target_type: 'schedule', target_id: playlistId, week_key: schedule.week_key,
        before: { status: schedule.status, admin_note: schedule.admin_note || '' },
        after: { status: 'published', admin_note: note || '' }
      });
    } catch (e) {
      await tx.rollback();
      return { success: false, message: '发布失败，请重试' };
    }

    // 事务外：未入选的当周 pending 转为 carryover，供随后两周补位。
    try {
      const pendingRes = await db.collection(submissionsCollection)
        .where({ week_key: weekKey, status: 'pending' })
        .get();

      if (pendingRes.data.length > 0) {
        await db.collection(submissionsCollection)
          .where({ week_key: weekKey, status: 'pending' })
          .update({ data: { status: 'carryover', carryover_at: db.serverDate() } });
        console.log(`[发布清理] 已将 ${pendingRes.data.length} 条 pending 标记为 carryover`);
      }
    } catch (cleanupErr) {
      console.warn('[发布] 转换历史候选失败，不影响推送:', cleanupErr.message || '');
    }

    // overflow 不参与抽取，发布完成后即可清理；失败不影响发布结果。
    try {
      let removed = 0;
      while (true) {
        const overflowRes = await db.collection(submissionsCollection)
          .where({ week_key: weekKey, status: 'overflow' }).limit(100).get();
        if (overflowRes.data.length === 0) break;
        const ids = overflowRes.data.map(item => item._id);
        const result = await db.collection(submissionsCollection)
          .where({ _id: _.in(ids) }).remove();
        removed += result.stats && result.stats.removed ? result.stats.removed : ids.length;
      }
      if (removed > 0) console.log(`[发布清理] 已删除 ${removed} 条 overflow`);
    } catch (overflowErr) {
      console.warn('[发布] 清理 overflow 失败，不影响发布:', overflowErr.message || '');
    }

    try {
      await notifyStudents(weekKey, scope);
    } catch (notifyErr) {
      console.warn('[发布] 学生通知异常，不影响发布:', notifyErr.message || '');
    }

    return { success: true, message: '发布成功' };
  }

  // 5. 更新单个项目的特殊备注
  if (action === 'updateNote') {
    const { songIndex, note } = event;
    if (!isValidDocId(playlistId) || !isValidDayIndex(dayIndex) || !isValidSongIndex(songIndex)) {
      return { success: false, message: '操作参数无效' };
    }
    if (note !== undefined && (typeof note !== 'string' || note.length > 50)) {
      return { success: false, message: '备注不能超过50个字符' };
    }
    try {
      // 文本安全检查（管理员备注也需过审）
      if (note && note.trim()) {
        try {
          const secResult = await cloud.openapi.security.msgSecCheck({
            openid: OPENID,
            scene: 2,       // 评论场景
            version: 2,
            content: note.trim()
          });
          if (secResult && secResult.result && secResult.result.suggest === 'risky') {
            return { success: false, message: '备注包含敏感词，请修改后重试' };
          }
        } catch (secErr) {
          console.warn('[安全检查] updateNote msgSecCheck 调用失败，已跳过:', secErr.errCode || secErr.message);
        }
      }

      const plRes = await db.collection(schedulesCollection).doc(playlistId).get();
      const schedule = plRes.data;
      if (schedule.status !== 'pending') {
        return { success: false, message: '排期已发布，无法修改' };
      }

      const dayKey = `day${dayIndex + 1}`;
      if (!Array.isArray(schedule[dayKey]) || songIndex < 0 || songIndex >= schedule[dayKey].length) {
        return { success: false, message: '项目不存在' };
      }

      const savedNote = (note || '').substring(0, 50);
      const previousNote = schedule[dayKey][songIndex].special_note || '';
      schedule[dayKey][songIndex].special_note = savedNote;

      await db.collection(schedulesCollection).doc(playlistId).update({
        data: {
          [dayKey]: schedule[dayKey],
          revision: (Number(schedule.revision) || 1) + 1,
          updated_at: db.serverDate()
        }
      });

      await appendSystemEvent(scope, {
        action: 'schedule.update_note', operator_openid: OPENID,
        target_type: 'schedule', target_id: playlistId, week_key: schedule.week_key,
        before: { day: dayKey, song_index: songIndex, special_note: previousNote },
        after: { day: dayKey, song_index: songIndex, special_note: savedNote }
      });

      return {
        success: true,
        message: '备注已更新',
        data: { special_note: savedNote }
      };
    } catch (err) {
      console.warn('[审核] 更新备注失败:', err.message || '未知错误');
      return { success: false, message: '更新失败，请稍后重试' };
    }
  }

  return { success: false, message: '未知操作' };
};
