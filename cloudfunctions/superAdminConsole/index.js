const cloud = require('wx-server-sdk');
const { createDataScope, isProductionSuperadmin, canUseTestData } = require('./dataScope');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const EDITABLE_SUBMISSION_STATUSES = new Set(['pending', 'overflow', 'carryover']);
const RESTORABLE_STATUSES = new Set(['pending', 'overflow', 'carryover']);
const DAYS = ['day1', 'day2', 'day3', 'day4', 'day5'];

function getWeekKey() {
  const bj = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const sun = new Date(bj.getTime());
  sun.setUTCDate(bj.getUTCDate() + ((7 - bj.getUTCDay()) % 7));
  return sun.toISOString().split('T')[0];
}

function normalizeSongName(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function sanitize(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>]/g, '').trim().slice(0, max);
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

function clampPage(value, fallback, max) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, max) : fallback;
}

function publicError(err, fallback) {
  const allowed = new Set([
    '记录不存在', '记录状态已变化，请刷新后重试', '页面数据已过期，请刷新后重试',
    '存在同名内容，请修改后重试', '排期中存在重复内容', '排期至少需要保留一个项目'
  ]);
  return err && allowed.has(err.message) ? err.message : fallback;
}

async function fetchAll(collection, where, orderBy, maxRows = 1000) {
  const rows = [];
  let offset = 0;
  while (rows.length < maxRows) {
    let query = db.collection(collection).where(where || {});
    if (orderBy) query = query.orderBy(orderBy.field, orderBy.direction);
    const batch = await query.skip(offset).limit(Math.min(100, maxRows - rows.length)).get();
    rows.push(...batch.data);
    if (batch.data.length < 100) break;
    offset += batch.data.length;
  }
  return rows;
}

async function audit(scope, entry) {
  await db.collection(scope.collection('system_events')).add({
    data: Object.assign({
      category: 'admin_action', severity: 'info', created_at: db.serverDate()
    }, entry)
  });
}

async function safeAudit(scope, entry) {
  try { await audit(scope, entry); } catch (err) {
    console.warn('[superAdminConsole] 审计写入失败:', err.message || '未知错误');
  }
}

async function checkText(openid, content, testMode) {
  if (!content) return true;
  if (testMode) {
    console.log('[测试环境] 已跳过超管编辑内容安全调用');
    return true;
  }
  try {
    const res = await cloud.openapi.security.msgSecCheck({
      openid, scene: 2, version: 2, content
    });
    return !(res && res.result && res.result.suggest === 'risky');
  } catch (err) {
    console.warn('[内容安全] 检查失败，已跳过:', err.errCode || err.message);
    return true;
  }
}

function toScheduleItem(item) {
  return {
    submission_id: item.submission_id || item._id || '',
    song_name: sanitize(item.song_name, 50),
    song_key: normalizeSongName(item.song_name),
    singer: sanitize(item.singer, 50),
    special_note: sanitize(item.special_note || '', 50),
    is_repeat: item.is_repeat === true,
    source_week_key: typeof item.source_week_key === 'string' ? item.source_week_key : ''
  };
}

function validateDays(rawDays) {
  if (!rawDays || typeof rawDays !== 'object') throw new Error('操作参数无效');
  const days = {};
  const names = new Set();
  let total = 0;
  DAYS.forEach(day => {
    const source = Array.isArray(rawDays[day]) ? rawDays[day] : [];
    if (source.length > 20) throw new Error('单日项目过多');
    days[day] = source.map(toScheduleItem).filter(item => item.song_name && item.singer);
    days[day].forEach(item => {
      if (names.has(item.song_key)) throw new Error('排期中存在重复内容');
      names.add(item.song_key);
      total += 1;
    });
  });
  if (total === 0) throw new Error('排期至少需要保留一个项目');
  return { days, total };
}

async function adjustCounter(countersCollection, weekKey, delta) {
  if (!delta) return;
  const ref = db.collection(countersCollection).doc(weekKey);
  try {
    const current = await ref.get();
    const next = Math.max(0, Number(current.data.count || 0) + delta);
    await ref.update({ data: { count: next, updated_at: db.serverDate() } });
  } catch (err) {
    if (delta > 0) await ref.set({ data: { count: delta, updated_at: db.serverDate() } });
  }
}

exports.main = async event => {
  const { OPENID } = cloud.getWXContext();
  const scope = createDataScope(event);
  if (!OPENID || !(await isProductionSuperadmin(db, OPENID))) {
    return { success: false, message: '仅超级管理员可访问' };
  }
  if (!(await canUseTestData(db, OPENID, scope))) {
    return { success: false, message: '测试数据仅限超级管理员访问' };
  }

  const action = event.action;
  const submissions = scope.collection('submissions');
  const schedules = scope.collection('schedules');
  const counters = scope.collection('submission_counters');
  const events = scope.collection('system_events');
  const exceptions = scope.collection('schedule_exceptions');

  try {
    if (action === 'listSubmissions') {
      const weekKey = typeof event.weekKey === 'string' && event.weekKey ? event.weekKey : getWeekKey();
      const status = typeof event.status === 'string' ? event.status : 'all';
      const page = clampPage(event.page, 1, 10000);
      const pageSize = clampPage(event.pageSize, 30, 50);
      const where = { week_key: weekKey };
      if (status !== 'all') where.status = status;
      let rows = await fetchAll(submissions, where, { field: 'submit_time', direction: 'desc' }, 1500);
      const keyword = sanitize(event.keyword || '', 50).toLowerCase();
      if (keyword) {
        rows = rows.filter(item => `${item.song_name || ''} ${item.singer || ''} ${item.special_note || ''}`.toLowerCase().includes(keyword));
      }
      const start = (page - 1) * pageSize;
      return { success: true, data: rows.slice(start, start + pageSize), total: rows.length, weekKey };
    }

    if (action === 'updateSubmission') {
      if (!validId(event.id)) return { success: false, message: '记录编号无效' };
      const before = (await db.collection(submissions).doc(event.id).get()).data;
      if (!EDITABLE_SUBMISSION_STATUSES.has(before.status)) {
        return { success: false, message: '当前状态不可编辑，请刷新后重试' };
      }
      const songName = sanitize(event.songName, 50);
      const singer = sanitize(event.singer, 50);
      const specialNote = sanitize(event.specialNote || '', 50);
      if (!songName || !singer) return { success: false, message: '内容名称和歌手不能为空' };
      if (!(await checkText(OPENID, `${songName} ${singer} ${specialNote}`, scope.testMode))) {
        return { success: false, message: '内容包含敏感词，请修改后重试' };
      }
      const songKey = normalizeSongName(songName);
      const duplicate = await db.collection(submissions)
        .where({ week_key: before.week_key, song_key: songKey, status: _.nin(['removed', 'rejected']) })
        .limit(5).get();
      if (duplicate.data.some(item => item._id !== event.id)) throw new Error('存在同名内容，请修改后重试');
      const after = { song_name: songName, song_key: songKey, singer, special_note: specialNote };
      await db.collection(submissions).doc(event.id).update({
        data: Object.assign({}, after, { updated_at: db.serverDate(), updated_by: OPENID })
      });
      await safeAudit(scope, {
        action: 'submission.update', operator_openid: OPENID, target_type: 'submission',
        target_id: event.id, week_key: before.week_key,
        before: { song_name: before.song_name, singer: before.singer, special_note: before.special_note || '' }, after
      });
      return { success: true, message: '投稿已更新' };
    }

    if (action === 'removeSubmissions') {
      const ids = Array.isArray(event.ids) ? Array.from(new Set(event.ids.filter(validId))).slice(0, 50) : [];
      const reason = sanitize(event.reason || '', 100);
      if (ids.length === 0) return { success: false, message: '请选择要移除的记录' };
      if (!reason) return { success: false, message: '请填写移除原因' };
      let removed = 0;
      const weekDeltas = new Map();
      for (const id of ids) {
        let before;
        try { before = (await db.collection(submissions).doc(id).get()).data; } catch (err) { continue; }
        if (!EDITABLE_SUBMISSION_STATUSES.has(before.status)) continue;
        await db.collection(submissions).doc(id).update({ data: {
          status: 'removed', restore_status: before.status, removed_at: db.serverDate(),
          removed_by: OPENID, removed_reason: reason
        }});
        weekDeltas.set(before.week_key, (weekDeltas.get(before.week_key) || 0) - 1);
        removed += 1;
        await safeAudit(scope, {
          action: 'submission.remove', operator_openid: OPENID, target_type: 'submission',
          target_id: id, week_key: before.week_key, before, after: { status: 'removed' }, reason
        });
      }
      for (const [weekKey, delta] of weekDeltas.entries()) await adjustCounter(counters, weekKey, delta);
      return { success: true, message: `已移除 ${removed} 条记录`, removed };
    }

    if (action === 'restoreSubmission') {
      if (!validId(event.id)) return { success: false, message: '记录编号无效' };
      const before = (await db.collection(submissions).doc(event.id).get()).data;
      if (before.status !== 'removed') return { success: false, message: '该记录不是已移除状态' };
      const nextStatus = RESTORABLE_STATUSES.has(before.restore_status) ? before.restore_status : 'pending';
      const duplicate = await db.collection(submissions)
        .where({ week_key: before.week_key, song_key: before.song_key || normalizeSongName(before.song_name), status: _.nin(['removed', 'rejected']) })
        .limit(2).get();
      if (duplicate.data.some(item => item._id !== event.id)) throw new Error('存在同名内容，请修改后重试');
      await db.collection(submissions).doc(event.id).update({ data: {
        status: nextStatus, restored_at: db.serverDate(), restored_by: OPENID,
        removed_at: _.remove(), removed_by: _.remove(), removed_reason: _.remove()
      }});
      await adjustCounter(counters, before.week_key, 1);
      await safeAudit(scope, {
        action: 'submission.restore', operator_openid: OPENID, target_type: 'submission',
        target_id: event.id, week_key: before.week_key,
        before: { status: 'removed' }, after: { status: nextStatus }
      });
      return { success: true, message: '投稿已恢复' };
    }

    if (action === 'listSchedules') {
      const rows = await fetchAll(schedules, {}, { field: 'generated_at', direction: 'desc' }, 50);
      return { success: true, data: rows.map(item => ({
        _id: item._id, week_key: item.week_key, status: item.status,
        total_count: item.total_count || 0, revision: Number(item.revision) || 1,
        admin_note: item.admin_note || '', generated_at: item.generated_at, publish_time: item.publish_time
      })) };
    }

    if (action === 'getSchedule') {
      if (!validId(event.id)) return { success: false, message: '排期编号无效' };
      const data = (await db.collection(schedules).doc(event.id).get()).data;
      data.revision = Number(data.revision) || 1;
      return { success: true, data };
    }

    if (action === 'updateSchedule') {
      if (!validId(event.id)) return { success: false, message: '排期编号无效' };
      const before = (await db.collection(schedules).doc(event.id).get()).data;
      if (!['pending', 'published', 'withdrawn'].includes(before.status)) {
        return { success: false, message: '当前排期状态不可编辑' };
      }
      const expectedRevision = Number(event.revision) || 1;
      const currentRevision = Number(before.revision) || 1;
      if (expectedRevision !== currentRevision) throw new Error('页面数据已过期，请刷新后重试');
      const validated = validateDays(event.days);
      const adminNote = sanitize(event.adminNote || '', 100);
      const allText = DAYS.flatMap(day => validated.days[day])
        .map(item => `${item.song_name} ${item.singer} ${item.special_note}`).join(' ');
      if (!(await checkText(OPENID, `${allText} ${adminNote}`, scope.testMode))) {
        return { success: false, message: '排期包含敏感内容，请修改后重试' };
      }
      const afterData = Object.assign({}, validated.days, {
        admin_note: adminNote, total_count: validated.total,
        revision: currentRevision + 1, updated_at: db.serverDate(), updated_by: OPENID
      });
      await db.collection(schedules).doc(event.id).update({ data: afterData });
      await safeAudit(scope, {
        action: 'schedule.update', operator_openid: OPENID, target_type: 'schedule',
        target_id: event.id, week_key: before.week_key,
        before: DAYS.reduce((obj, day) => Object.assign(obj, { [day]: before[day] || [] }), { admin_note: before.admin_note || '', revision: currentRevision }),
        after: Object.assign({}, validated.days, { admin_note: adminNote, revision: currentRevision + 1 })
      });
      return { success: true, message: '排期已保存', revision: currentRevision + 1 };
    }

    if (action === 'withdrawSchedule') {
      if (!validId(event.id)) return { success: false, message: '排期编号无效' };
      const reason = sanitize(event.reason, 100);
      if (!reason) return { success: false, message: '请填写撤回原因' };
      const before = (await db.collection(schedules).doc(event.id).get()).data;
      if (before.status !== 'published') return { success: false, message: '只有已发布排期可以撤回' };
      const expectedRevision = Number(event.revision) || 1;
      const currentRevision = Number(before.revision) || 1;
      if (expectedRevision !== currentRevision) throw new Error('页面数据已过期，请刷新后重试');
      await db.collection(schedules).doc(event.id).update({ data: {
        status: 'withdrawn', withdraw_reason: reason, withdrawn_at: db.serverDate(),
        withdrawn_by: OPENID, revision: currentRevision + 1
      }});
      const selectedIds = DAYS.flatMap(day => before[day] || []).map(item => item.submission_id).filter(validId);
      if (selectedIds.length > 0) {
        await db.collection(submissions).where({ _id: _.in(selectedIds), status: 'selected' })
          .update({ data: { status: 'carryover', carryover_at: db.serverDate() } });
      }
      await safeAudit(scope, {
        action: 'schedule.withdraw', operator_openid: OPENID, target_type: 'schedule',
        target_id: event.id, week_key: before.week_key,
        before: { status: 'published', revision: currentRevision },
        after: { status: 'withdrawn', revision: currentRevision + 1 }, reason
      });
      return { success: true, message: '排期已撤回' };
    }

    if (action === 'listEvents') {
      const category = typeof event.category === 'string' ? event.category : 'all';
      const page = clampPage(event.page, 1, 10000);
      const pageSize = clampPage(event.pageSize, 30, 50);
      const includeExceptions = category === 'all' || category === 'schedule_exception';
      const includeSystemEvents = category !== 'schedule_exception';
      const systemWhere = category === 'all' ? {} : { category };
      const [systemRows, exceptionRows] = await Promise.all([
        includeSystemEvents ? fetchAll(events, systemWhere, { field: 'created_at', direction: 'desc' }, 500) : [],
        includeExceptions ? fetchAll(exceptions, {}, { field: 'created_at', direction: 'desc' }, 500) : []
      ]);
      const normalizedExceptions = exceptionRows.map(item => Object.assign({}, item, {
        category: 'schedule_exception', severity: 'warning',
        action: item.reason === '管理员跳过该日' ? 'schedule.skip_day' : 'schedule.mark_exception',
        target_type: 'schedule', target_id: item.schedule_id,
        before: item.original_item, operator_openid: item.operator
      }));
      const rows = systemRows.concat(normalizedExceptions).sort((a, b) => {
        const aTime = new Date(a.created_at || 0).getTime();
        const bTime = new Date(b.created_at || 0).getTime();
        return bTime - aTime;
      });
      const start = (page - 1) * pageSize;
      return { success: true, data: rows.slice(start, start + pageSize), total: rows.length };
    }

    if (action === 'listCounters') {
      const rows = await fetchAll(counters, {}, null, 200);
      rows.sort((a, b) => String(b._id).localeCompare(String(a._id)));
      return { success: true, data: rows.slice(0, 50) };
    }

    if (action === 'getCounterDetail') {
      const weekKey = typeof event.weekKey === 'string' ? event.weekKey : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(weekKey)) return { success: false, message: '周标识无效' };
      let counter = { _id: weekKey, count: 0 };
      try { counter = (await db.collection(counters).doc(weekKey).get()).data; } catch (err) { /* 0 */ }
      const rows = await fetchAll(submissions, { week_key: weekKey }, null, 2000);
      const statusCounts = {};
      rows.forEach(item => { statusCounts[item.status || 'unknown'] = (statusCounts[item.status || 'unknown'] || 0) + 1; });
      return { success: true, data: { counter, statusCounts, storedTotal: rows.length } };
    }

    if (action === 'setCounter') {
      const weekKey = typeof event.weekKey === 'string' ? event.weekKey : '';
      const count = Number(event.count);
      const reason = sanitize(event.reason, 100);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(weekKey) || !Number.isInteger(count) || count < 0 || count > 100000) {
        return { success: false, message: '计数参数无效' };
      }
      if (!reason) return { success: false, message: '请填写调整原因' };
      let beforeCount = 0;
      try { beforeCount = Number((await db.collection(counters).doc(weekKey).get()).data.count) || 0; } catch (err) { /* 0 */ }
      await db.collection(counters).doc(weekKey).set({ data: {
        count, updated_at: db.serverDate(), updated_by: OPENID, update_reason: reason
      }});
      await safeAudit(scope, {
        action: 'counter.set', operator_openid: OPENID, target_type: 'submission_counter',
        target_id: weekKey, week_key: weekKey, before: { count: beforeCount }, after: { count }, reason
      });
      return { success: true, message: '计数器已更新', count };
    }

    if (action === 'recalculateCounter') {
      const weekKey = typeof event.weekKey === 'string' ? event.weekKey : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(weekKey)) return { success: false, message: '周标识无效' };
      let beforeCount = 0;
      try { beforeCount = Number((await db.collection(counters).doc(weekKey).get()).data.count) || 0; } catch (err) { /* 0 */ }
      const result = await db.collection(submissions)
        .where({ week_key: weekKey, status: _.neq('removed') }).count();
      await db.collection(counters).doc(weekKey).set({ data: {
        count: result.total, updated_at: db.serverDate(), updated_by: OPENID,
        update_reason: '按现存非 removed 投稿重新计算'
      }});
      await safeAudit(scope, {
        action: 'counter.recalculate', operator_openid: OPENID, target_type: 'submission_counter',
        target_id: weekKey, week_key: weekKey,
        before: { count: beforeCount }, after: { count: result.total }
      });
      return { success: true, message: '已按现存投稿重新计算', count: result.total };
    }

    return { success: false, message: '未知操作' };
  } catch (err) {
    console.error('[superAdminConsole]', action, err);
    await safeAudit(scope, {
      category: 'system_error', severity: 'error', action: `super_admin.${action || 'unknown'}`,
      operator_openid: OPENID, error: String(err.message || '未知错误').slice(0, 500)
    });
    return { success: false, message: publicError(err, '操作失败，请稍后重试') };
  }
};
