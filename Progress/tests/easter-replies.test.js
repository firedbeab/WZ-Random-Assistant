const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const replies = require('../../utils/easter-replies');
const eligible = { song_name: '《晴天》', singer: '周杰伦' };
assert.equal(replies.REPLY_CHANCE, .3);
assert.equal(replies.singerTemplates.length, 8); assert.equal(replies.songTemplates.length, 6);
const expected = [
  '我也很喜欢听周杰伦的歌呀', '今天想听周杰伦，也想晒晒太阳喵。', '听周杰伦的时候，给小猫留一只耳机嘛。',
  '周杰伦的歌，适合和小猫一起听喵～', '原来你也喜欢周杰伦呀，喵 :3', '周杰伦和小鱼干，今天先选哪个呢喵？',
  '下次听周杰伦，记得叫上小猫呀。', '周杰伦的歌？小猫的耳朵已经竖起来啦。',
  '《晴天》呀，小猫陪你一起听喵～', '《晴天》这个名字，小猫记住啦。', '今天有《晴天》，也有一只小猫。',
  '听《晴天》的时候，可以顺手摸摸小猫。', '《晴天》已经准备好，小猫也坐好啦。', '《晴天》？先让我找个舒服的姿势喵。'
];
assert.deepEqual(replies.candidates(eligible).map(item => item.text), expected);
assert.equal(new Set(expected).size, 14);
for (const name of ['雨', '晴天', '周杰伦', '龍的傳人', '一二三四五', '〇']) assert.equal(replies.chineseName(name), name);
assert.equal(replies.chineseName('  周杰伦  '), '周杰伦');
assert.equal(replies.chineseName('《晴天》', true), '晴天');
for (const name of ['', '一二三四五六', 'Jay Chou', '五月天3', '周杰伦/林俊杰', '周杰伦、林俊杰', '周 杰伦', '喵🐱', '《晴天', '《《晴天》》', null]) assert.equal(replies.chineseName(name, true), '');
assert.equal(replies.chineseName('《周杰伦》'), '', 'singer symbols must not be removed');
assert.equal(replies.candidates({ song_name: '晴天', singer: 'Jay Chou' }).length, 6);
assert.equal(replies.candidates({ song_name: '一二三四五六', singer: '陈奕迅' }).length, 8);
assert.equal(replies.candidates(null).length, 0);
assert.equal(replies.candidates({ ...eligible, status: 'removed' }).length, 0);
assert.equal(replies.choose(eligible, {}, () => .3), null);
assert.ok(replies.choose(eligible, {}, () => .299999));
assert.equal(replies.choose(eligible, { mode: 'off' }, () => 0), null);
assert.ok(replies.choose(eligible, { mode: 'force' }, () => .99999));
assert.equal(replies.choose({ song_name: 'English', singer: 'English' }, { mode: 'force' }), null);
for (let i = 0; i < 8; i++) assert.equal(replies.choose(null, { mode: 'singer', index: i }).text, expected[i]);
for (let i = 0; i < 6; i++) assert.equal(replies.choose(null, { mode: 'song', index: i }).text, expected[i + 8]);
const distribution = { fallback: 0, singer: 0, song: 0 };
for (let i = 0; i < 14000; i++) {
  let call = 0;
  const choice = replies.choose(eligible, {}, () => call++ === 0 ? (i + .5) / 14000 : (i % 14 + .5) / 14);
  distribution[choice ? choice.kind : 'fallback']++;
}
assert.deepEqual(distribution, { fallback: 9800, singer: 2400, song: 1800 });
function service(cloudCall) {
  const context = { module: { exports: {} }, require: () => ({ cloudCall }), setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../utils/easter-replies.js'), 'utf8'), context);
  return context.module.exports;
}
(async () => {
  let request;
  const live = service(async options => { request = options; return { result: { success: true, data: eligible } }; });
  assert.deepEqual(await live.load(), eligible);
  assert.equal(request.name, 'getUserInfo'); assert.equal(request.data.action, 'getLatestSubmission');
  assert.equal(Object.keys(request.data).length, 1, 'client must not supply identity');
  assert.equal(await service(async () => ({ result: { success: false } })).load(), null);
  assert.equal(await service(async () => { throw new Error('offline'); }).load(), null);
  assert.equal(await service(() => new Promise(() => {})).load(5), null);
  console.log('PASS: all 14 exact texts, Chinese/title boundaries, latest-only input, 30% boundary/distribution, test previews and network fallbacks');
})().catch(error => { console.error(error); process.exitCode = 1; });
