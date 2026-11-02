const test = require('node:test');
const assert = require('node:assert/strict');
const { mondayDateText } = require('../../utils/period-label');
const home = require('../../utils/home-presentation');
const my = require('../../utils/my-presentation');
const journal = require('../../utils/song-journal');
const playlist = require('../../utils/playlist-presentation');

test('周日期次只在展示时转为下周一，跨月跨年与非法输入一致处理', () => {
  for (const [key, label] of [['2026-11-08','2026.11.09'],['2026-12-27','2026.12.28'],['2023-12-31','2024.01.01'],['2024-02-25','2024.02.26']]) assert.equal(mondayDateText(key),label);
  for (const key of [null,undefined,{},'', 'bad','2026-02-30','2026-11-09']) assert.equal(mondayDateText(key),'');
});

test('首页、我的、个人记录及入选详情统一周一显示，内部查询键、所属歌单和原对象不变', () => {
  const weekKey = '2026-11-08',schedule={week_key:weekKey,day1:[]};
  assert.equal(home.schedulePreview(schedule).previewWeekText,'2026.11.09');
  assert.equal(my.state({period:{weekKey,open:true},submission:null,schedule:null}).weekLabel,'2026.11.09 期');
  const raw={id:'submission',weekKey,submittedAt:Date.parse('2026-11-06T12:00:00Z'),placement:{weekKey:'2026-11-15',day:1,scheduleId:'later'}};
  const view=journal.present(raw,'submissions');
  assert.equal(view.period,'2026.11.09期');assert.equal(view.weekKey,weekKey);
  assert.equal(view.placement.periodDate,'2026.11.16');assert.equal(view.placement.weekKey,'2026-11-15');assert.equal(view.placement.scheduleId,'later');assert.equal(raw.placement.periodDate,undefined);
  assert.equal(journal.present({...raw,scheduleId:'s',likedAt:raw.submittedAt,count:2},'likes').period,'2026.11.09期');
  assert.equal(playlist.playlistPresentation(schedule,weekKey).periodRange,'2026.11.09 — 11.13');
  assert.equal(schedule.week_key,weekKey);
});
