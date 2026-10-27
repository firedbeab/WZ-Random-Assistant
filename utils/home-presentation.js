// 只负责首页展示，不参与服务端时间窗口、验证码或抽取规则。
function nextOpenText(bjTime, forceClose) {
  const day = bjTime.getUTCDay();
  const hour = bjTime.getUTCHours();
  if (forceClose) return '通道暂时关闭，恢复时间待定';
  let ahead = (7 - day) % 7;
  if (day === 0 && hour >= 8) ahead = 7;
  const next = new Date(bjTime.getTime());
  next.setUTCDate(next.getUTCDate() + ahead);
  return `${next.getUTCMonth() + 1} 月 ${next.getUTCDate()} 日 周日 8:00`;
}

function hoursLeftText(bjTime) {
  if (bjTime.getUTCDay() !== 0) return '';
  const minutes = bjTime.getUTCHours() * 60 + bjTime.getUTCMinutes();
  if (minutes < 8 * 60 || minutes >= 20 * 60) return '';
  const left = 20 * 60 - minutes;
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
    previewSongs: songs.slice(0, 3),
    previewTotal: songs.length,
    previewWeekText: schedule && typeof schedule.week_key === 'string' ? schedule.week_key.replace(/-/g, '.') : '',
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

module.exports = { nextOpenText, hoursLeftText, schedulePreview, submissionView };
