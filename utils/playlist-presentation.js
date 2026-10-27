// 排期的显示模型；不改变原始排期、周次选择或订阅周期。
function playlistPresentation(schedule, weekKey) {
  let sunday = null;
  if (typeof weekKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(weekKey)) {
    const date = new Date(`${weekKey}T00:00:00Z`);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === weekKey) sunday = date;
  }
  const dateAt = offset => {
    if (!sunday) return null;
    const date = new Date(sunday.getTime());
    date.setUTCDate(date.getUTCDate() + offset);
    return date;
  };
  const shortDate = date => `${date.getUTCMonth() + 1}.${String(date.getUTCDate()).padStart(2, '0')}`;
  const first = dateAt(1), last = dateAt(5);
  const periodRange = first
    ? `${first.getUTCFullYear()}.${shortDate(first)} — ${last.getUTCFullYear() !== first.getUTCFullYear() ? last.getUTCFullYear() + '.' : ''}${shortDate(last)}`
    : '';
  const days = ['周一', '周二', '周三', '周四', '周五'];
  const playlistDays = days.map((label, index) => {
    const date = dateAt(index + 1);
    const source = schedule && schedule[`day${index + 1}`];
    const songs = (Array.isArray(source) ? source : []).filter(song => song && typeof song.song_name === 'string' && song.song_name).map((song, i) => ({
      key: `${index + 1}-${i}`, number: i + 1,
      title: song.song_name, singer: typeof song.singer === 'string' ? song.singer : '',
      note: typeof song.special_note === 'string' ? song.special_note : ''
    }));
    return { key: index + 1, label, dateText: date ? `${date.getUTCMonth() + 1}月${date.getUTCDate()}日` : '', songs };
  });
  return {
    periodRange, playlistDays,
    playlistTotal: playlistDays.reduce((sum, day) => sum + day.songs.length, 0),
    playlistNote: schedule && typeof schedule.admin_note === 'string' ? schedule.admin_note : ''
  };
}

module.exports = { playlistPresentation };
