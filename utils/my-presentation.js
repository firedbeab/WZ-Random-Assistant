// 只负责「我的」的周期与显示；提交权限仍由原云函数检查。
const { nextOpenText } = require('./home-presentation');
function context(user = {}, now = Date.now()) {
  user = user || {};
  const bj = new Date(now + 28800000), day = bj.getUTCDay(), hour = bj.getUTCHours();
  const regularOpen = day === 0 && hour >= 8 && hour < 20;
  const open = !user.channelForceClose && (regularOpen || user.channelForceOpen === true);
  const period = new Date(bj.getTime());
  period.setUTCDate(bj.getUTCDate() + (open ? (7 - day) % 7 : -day));
  const weekKey = period.toISOString().slice(0, 10);
  return { weekKey, open, forceClosed: user.channelForceClose === true, nextOpen: nextOpenText(bj, user.channelForceClose === true) };
}
function firstUse(value) {
  if (value && typeof value === 'object' && !(value instanceof Date)) value = value.$date;
  if (value === null || value === undefined || value === '') return '首次使用日期暂无记录';
  const time = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isFinite(time) || time <= 0 || !Number.isFinite(new Date(time + 28800000).getTime())) return '首次使用日期暂无记录';
  return '首次使用 · ' + new Date(time + 28800000).toISOString().slice(0, 10).replace(/-/g, '.');
}
function state({ period, submission, schedule }) {
  const published = !!schedule, submitted = !!submission;
  const base = { weekLabel: period.weekKey.replace(/-/g, '.') + ' 期', submitted, published, open: period.open && !published };
  if (published) {
    const matched = submitted && Array.from({ length: 5 }, (_, i) => schedule['day' + (i + 1)] || [])
      .some(rows => rows.some(row => row && row.submission_id === submission._id));
    return { ...base, kind: 'published', status: '歌单已发布 · 通道已关闭', title: '本期安排，已经公布',
      description: submitted ? (matched ? '你的点歌已列入本期歌单，可以查看播出安排。' : '你的提交记录仍可查看，最终安排以歌单为准。') : '查看完整歌单与播出安排，也可以回看往期。',
      action: 'playlist', actionLabel: '查看本期歌单' };
  }
  if (submitted) return { ...base, kind: period.open ? 'submitted-open' : 'submitted-closed',
    status: period.open ? '已提交 · 通道开放中' : '已提交 · 通道已关闭', title: '你的点歌，已收到',
    description: period.open ? '本周无需再次提交，抽取后还需等待审核与发布。' : '等待抽取、审核与发布，最终安排以歌单为准。', action: 'submission', actionLabel: '查看提交记录' };
  return { ...base, kind: period.open ? 'open' : 'closed', status: period.open ? '尚未提交 · 通道开放中' : '暂无投稿记录 · 通道已关闭',
    title: period.open ? '这周，想听什么？' : '等待下一次开放',
    description: period.open ? '可以回首页提交本周点歌，每人每周一次。' : (period.forceClosed ? period.nextOpen : '下次开放：' + period.nextOpen), action: 'home', actionLabel: period.open ? '去首页点歌' : '回首页看看' };
}
const loading = () => ({ kind: 'loading', weekLabel: '本周点歌', status: '正在同步', title: '正在读取本周记录', description: '正在确认投稿、通道与歌单状态。', action: '', actionLabel: '请稍候' });
const failed = () => ({ ...loading(), kind: 'error', status: '暂时无法同步', title: '本周记录读取失败', description: '请检查网络后重试，暂不判断投稿或通道状态。', action: 'retry', actionLabel: '重新加载' });
module.exports = { context, firstUse, state, loading, failed };
