const crypto = require('crypto');
const CATEGORIES = ['使用问题', '功能建议', '其他'];
const STATUSES = ['received', 'handling', 'done'];
const ADMIN = ['adminList', 'adminUpdate', 'adminListPolls', 'createPoll', 'endPoll'];
const hash = (...parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const userKey = openid => hash('feedback-user-v1', openid).slice(0, 12);
const error = (message, code = 'INVALID_INPUT') => { const e = new Error(message); e.businessCode = code; throw e; };
function text(value, max, min = 1) {
  if (typeof value !== 'string') error('请检查填写内容');
  const clean = value.trim();
  if (Array.from(clean).length < min || clean.length > max) error(`内容长度应为 ${min}–${max} 字`);
  return clean;
}
function id(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) error('记录标识无效'); return value; }
function requestId(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{12,80}$/.test(value)) error('请求标识无效，请重新打开页面'); return value; }
function createService({ db, checkText, canUseTestData, isProductionSuperadmin, createDataScope, now = Date.now }) {
  return async (event, openid) => {
    if (!openid) return { success: false, code: 'UNAUTHENTICATED', message: '无法确认用户身份' };
    const scope = createDataScope(event), action = event.action;
    const col = (name, connection = db) => connection.collection(scope.collection(name));
    const read = async (name, key, connection = db) => (await col(name, connection).doc(key).get()).data;
    const put = (name, key, data, connection = db) => col(name, connection).doc(key).set({ data });
    const transact = async fn => {
      const tx = await db.startTransaction();
      try { const result = await fn(tx); await tx.commit(); return result; }
      catch (e) { try { await tx.rollback(); } catch (_) {} throw e; }
    };
    const profile = async () => {
      const result = await col('users').where({ openid }).limit(1).get();
      return result.data[0] || null;
    };
    const safeFeedback = (entry, admin) => ({ _id: entry._id, category: entry.category, content: entry.content,
      status: entry.status, alias: entry.alias || '点歌同学', userKey: entry.user_key, version: entry.version,
      createdAt: entry.created_at, updatedAt: entry.updated_at, reply: entry.reply || '', revision: entry.revision || 1,
      replyVersion: entry.reply_version || 0, unread: !admin && (entry.reply_version || 0) > (entry.read_reply_version || 0) });
    const page = async (name, where) => {
      const offset = event.offset === undefined ? 0 : Number(event.offset);
      if (!Number.isInteger(offset) || offset < 0 || offset > 10000) error('翻页参数无效');
      const result = await col(name).where(where).orderBy('created_at', 'desc').skip(offset).limit(21).get();
      return { items: result.data.slice(0, 20), hasMore: result.data.length > 20, offset: offset + Math.min(result.data.length, 20) };
    };
    const pollView = async (poll, admin) => {
      const vote = await read('feedback_votes', hash(poll._id, openid));
      const ended = poll.closed === true || now() >= poll.ends_at;
      const visible = admin || ended || !!vote;
      return { _id: poll._id, title: poll.title, description: poll.description, createdAt: poll.created_at,
        endsAt: poll.ends_at, ended, total: poll.total || 0, choice: vote ? vote.choice : -1,
        resultsVisible: visible, options: poll.options.map((label, i) => ({ label, count: visible ? poll.counts[i] : null })) };
    };
    try {
      if (!await canUseTestData(db, openid, scope)) error('测试数据仅限超级管理员或测试白名单账号访问', 'TEST_ACCESS_DENIED');
      const admin = ADMIN.includes(action);
      if (admin && !await isProductionSuperadmin(db, openid)) error('仅超级管理员可管理反馈和投票', 'FORBIDDEN');
      let result;
      if (action === 'getProfile') {
        const user = await profile();
        result = { alias: user && user.name_alias || '点歌同学', userKey: userKey(openid) };
      } else if (action === 'setAlias') {
        const alias = text(event.alias, 12, 2), user = await profile();
        if (!user) error('账号资料尚未准备好，请刷新后再试');
        await checkText(alias, openid, scope);
        // 仅增量更新显示字段；绝不接收 role、openid 或重建旧账号。
        await col('users').doc(user._id).update({ data: { name_alias: alias } });
        result = { alias, userKey: userKey(openid) };
      } else if (action === 'submitFeedback') {
        const content = text(event.content, 500, 2), category = event.category;
        if (!CATEGORIES.includes(category)) error('请选择反馈类型');
        const key = hash(openid, requestId(event.requestId));
        const existing = await read('user_feedback', key);
        if (existing) return { success: true, data: safeFeedback(existing, false) };
        await checkText(content, openid, scope);
        const user = await profile(), timestamp = now(), day = new Date(timestamp + 28800000).toISOString().slice(0, 10);
        result = await transact(async tx => {
          const old = await read('user_feedback', key, tx);
          if (old) return safeFeedback(old, false);
          const limitKey = hash(openid, day), limit = await read('feedback_limits', limitKey, tx);
          if (limit && (limit.count >= 3 || timestamp - limit.last_at < 60000)) error('每分钟最多提交一次，每天最多 3 条，请稍后再试', 'RATE_LIMIT');
          const entry = { _id: key, owner: openid, user_key: userKey(openid), alias: user && user.name_alias || '点歌同学',
            category, content, version: typeof event.version === 'string' ? event.version.slice(0, 30) : '',
            created_at: timestamp, updated_at: timestamp, status: 'received', revision: 1, reply: '', reply_version: 0, read_reply_version: 0 };
          const { _id, ...data } = entry;
          await put('user_feedback', key, data, tx);
          await put('feedback_limits', limitKey, { count: (limit && limit.count || 0) + 1, last_at: timestamp }, tx);
          return safeFeedback(entry, false);
        });
      } else if (action === 'listMine' || action === 'adminList') {
        const where = action === 'listMine' ? { owner: openid } : {};
        if (action === 'adminList') {
          if (event.status && !STATUSES.includes(event.status)) error('状态无效');
          if (event.status) where.status = event.status;
          if (event.userKey) { if (!/^[a-f0-9]{12}$/.test(event.userKey)) error('用户编号无效'); where.user_key = event.userKey; }
        }
        const batch = await page('user_feedback', where);
        result = { ...batch, items: batch.items.map(entry => safeFeedback(entry, admin)) };
      } else if (action === 'getFeedback' || action === 'markRead') {
        const key = id(event.id);
        result = await transact(async tx => {
          const entry = await read('user_feedback', key, tx);
          if (!entry || entry.owner !== openid) error('无法查看这条反馈', 'NOT_FOUND');
          if (action === 'markRead') {
            if (!Number.isInteger(event.replyVersion) || event.replyVersion < 0 || event.replyVersion > (entry.reply_version || 0)) error('回复状态已更新，请刷新');
            const readVersion = Math.max(entry.read_reply_version || 0, event.replyVersion);
            await col('user_feedback', tx).doc(key).update({ data: { read_reply_version: readVersion } });
            entry.read_reply_version = readVersion;
          }
          return safeFeedback(entry, false);
        });
      } else if (action === 'adminUpdate') {
        const key = id(event.id), reply = text(event.reply, 500, 0);
        if (!STATUSES.includes(event.status) || !Number.isInteger(event.revision)) error('处理状态无效');
        if (reply) await checkText(reply, openid, scope);
        result = await transact(async tx => {
          const entry = await read('user_feedback', key, tx);
          if (!entry) error('反馈已不存在', 'NOT_FOUND');
          if (event.revision !== entry.revision) error('可能有其他管理员处理了这条反馈，请关闭后重新打开，查看最新状态', 'CONFLICT');
          const patch = { status: event.status, reply, revision: entry.revision + 1, updated_at: now(),
            reply_version: (entry.reply_version || 0) + (reply !== entry.reply ? 1 : 0) };
          await col('user_feedback', tx).doc(key).update({ data: patch });
          return safeFeedback({ ...entry, ...patch }, true);
        });
      } else if (action === 'listPolls' || action === 'adminListPolls') {
        const batch = await page('feedback_polls', {});
        result = { ...batch, items: await Promise.all(batch.items.map(poll => pollView(poll, admin))) };
      } else if (action === 'createPoll') {
        const title = text(event.title, 50, 2), description = text(event.description || '', 100, 0);
        if (!Array.isArray(event.options) || event.options.length < 2 || event.options.length > 4 || ![3, 7, 14].includes(event.days)) error('投票需要 2–4 个选项，持续 3、7 或 14 天');
        const options = event.options.map(v => text(v, 30));
        if (new Set(options).size !== options.length) error('投票选项不能重复');
        const key = hash(openid, 'poll', requestId(event.requestId));
        await checkText([title, description, ...options].join('\n'), openid, scope);
        result = await transact(async tx => {
          const old = await read('feedback_polls', key, tx);
          if (old) return { id: key };
          const timestamp = now();
          await put('feedback_polls', key, { title, description, options, counts: options.map(() => 0), total: 0,
            ends_at: timestamp + event.days * 86400000, closed: false, created_at: timestamp }, tx);
          return { id: key };
        });
      } else if (action === 'vote') {
        const key = id(event.id), choice = event.choice;
        result = await transact(async tx => {
          const poll = await read('feedback_polls', key, tx);
          if (!poll) error('投票不存在', 'NOT_FOUND');
          if (poll.closed || now() >= poll.ends_at) error('投票已结束，请刷新查看结果', 'POLL_CLOSED');
          if (!Number.isInteger(choice) || choice < 0 || choice >= poll.options.length) error('请选择有效选项');
          const voteKey = hash(key, openid), old = await read('feedback_votes', voteKey, tx), counts = poll.counts.slice();
          if (old && old.choice === choice) return { unchanged: true };
          if (old) counts[old.choice]--;
          counts[choice]++;
          if (counts.some(v => !Number.isInteger(v) || v < 0)) error('计票状态异常，请稍后重试', 'COUNT_INVALID');
          await col('feedback_polls', tx).doc(key).update({ data: { counts, total: poll.total + (old ? 0 : 1) } });
          await put('feedback_votes', voteKey, { poll_id: key, owner: openid, choice, updated_at: now() }, tx);
          return { voted: true };
        });
      } else if (action === 'endPoll') {
        const key = id(event.id);
        result = await transact(async tx => {
          const poll = await read('feedback_polls', key, tx);
          if (!poll) error('投票不存在', 'NOT_FOUND');
          await col('feedback_polls', tx).doc(key).update({ data: { closed: true, closed_at: now() } });
          return { id: key };
        });
      } else error('未知操作');
      return { success: true, data: result };
    } catch (e) {
      if (e.businessCode) return { success: false, code: e.businessCode, message: e.message };
      // 不回传 OPENID、数据库错误或用户正文。
      console.warn('[manageFeedback]', scope.testMode ? 'test' : 'production', ADMIN.includes(action) ? 'admin' : 'user', 'BACKEND_UNAVAILABLE');
      return { success: false, code: 'BACKEND_UNAVAILABLE', message: '服务暂不可用，请稍后重试；未确认成功的内容仍保留在当前页面' };
    }
  };
}
module.exports = { createService, hash, userKey };
