// 接收已偏移到北京时间的 Date，统一首页与我的的时间展示。
// 服务端独立校验同一窗口；周标识和周日抽取时间保持原协议。
const { mondayDateText } = require('./period-label');
function isRegularOpen(bjTime) {
  const day = bjTime.getUTCDay(), hour = bjTime.getUTCHours();
  return (day === 5 && hour >= 20) || day === 6 || (day === 0 && hour < 20);
}

function nextOpenText(bjTime, forceClose) {
  const day = bjTime.getUTCDay();
  const hour = bjTime.getUTCHours();
  if (forceClose) return '通道暂时关闭，恢复时间待定';
  let ahead = (5 - day + 7) % 7;
  if (day === 5 && hour >= 20) ahead = 7;
  const next = new Date(bjTime.getTime());
  next.setUTCDate(next.getUTCDate() + ahead);
  return `${next.getUTCMonth() + 1} 月 ${next.getUTCDate()} 日 周五 20:00`;
}

function hoursLeftText(bjTime) {
  if (!isRegularOpen(bjTime)) return '';
  const daysToSunday = (7 - bjTime.getUTCDay()) % 7;
  const minutes = bjTime.getUTCHours() * 60 + bjTime.getUTCMinutes();
  const left = daysToSunday * 24 * 60 + 20 * 60 - minutes;
  return left < 60 ? `还剩 ${left} 分钟` : `还剩 ${Math.floor(left / 60)} 小时${left % 60 ? ` ${left % 60} 分钟` : ''}`;
}

function schedulePreview(schedule) {
  const songs = [];
  const days = ['周一', '周二', '周三', '周四', '周五'];
  for (let day = 1; day <= 5; day++) {
    const rows = Array.isArray(schedule && schedule[`day${day}`]) ? schedule[`day${day}`] : [];
    rows.forEach((song, index) => {
      if (!song || !song.song_name) return;
      songs.push({ key: `${day}-${index}`, title: song.song_name, singer: song.singer || '', day: days[day - 1] });
    });
  }
  return {
    previewSongs: songs.slice(0, 4),
    previewTotal: songs.length,
    previewWeekText: mondayDateText(schedule && schedule.week_key),
    previewNote: schedule && typeof schedule.admin_note === 'string' ? schedule.admin_note : ''
  };
}

function submissionView(song) {
  const text = value => typeof value === 'string' ? value : '';
  return {
    submittedTitle: text(song && song.song_name),
    submittedSinger: text(song && (song.singer || song.remark)),
    submittedNote: text(song && (song.special_note || song.specialNote))
  };
}

module.exports = { isRegularOpen, nextOpenText, hoursLeftText, schedulePreview, submissionView };
