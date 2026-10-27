// 仅用于歌单写操作；验证码过期、权限和网络错误不能冒充并发冲突。
const TITLE = '歌单状态已更新';
const MESSAGE = '可能有其他管理员在此前编辑、发布或撤回了这份歌单。当前页面已不是最新状态，本次操作未全部完成。请刷新查看最新状态，重新核对后再操作。';
function isConflict(error) {
  const message = typeof error === 'string' ? error : error && error.message || '';
  return /页面数据已过期|版本.*过期|排期状态已变更|记录状态已变化|排期已经变化|该排期已发布|排期已发布|项目索引无效|项目不存在|记录不存在|排期不存在|该日无项目/.test(message);
}
function snapshot(schedule) { return schedule ? { id: schedule._id, revision: schedule.revision } : null; }
function matches(saved, schedule) { return !!saved && !!schedule && saved.id === schedule._id && saved.revision === schedule.revision; }
module.exports = { TITLE, MESSAGE, isConflict, snapshot, matches };
