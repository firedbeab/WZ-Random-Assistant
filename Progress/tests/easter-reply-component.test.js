const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourceReplies = require('../../utils/easter-replies');
const cats = require('../../utils/easter-cats');
const dice = require('../../utils/dice-easter-egg');
let component, choiceCalls = 0, random = 0, loadReply = async () => null;
const replies = { ...sourceReplies,
  load: () => loadReply(),
  choose(submission, options) { choiceCalls++; return sourceReplies.choose(submission, options, () => random); }
};
const photo = { id: 'photo', path: 'cached.jpg', topText: '管理员上方文案', bottomText: '照片默认文案', hasCustomBottom: false };
const photos = { DEFAULT_TOP: 'top', DEFAULT_BOTTOM: 'bottom', prepare: async () => photo, manifest: async () => [], withTimeout: value => value };
let records = 0;
const encounters = { pick: (_, catalog) => catalog[0], summary: (_, ids) => ({ seen: 0, total: ids.length }), record: (_, id, ids) => { records++; return { seen: 1, total: ids.length }; } };
const context = { Component: value => { component = value; }, setTimeout, clearTimeout,
  require(name) { return name.endsWith('/theme') ? require('../../utils/theme') : name.includes('easter-cats') ? cats : name.includes('replies') ? replies : name.includes('encounters') ? encounters : name.includes('photos') ? photos : name.includes('diagnostics') ? { record() {} } : dice; }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../components/easter-dice/easter-dice.js'), 'utf8'), context);
function instance(test = true, superadmin = true) {
  const item = { ...component.methods, properties: { testMode: test, superadmin }, data: structuredClone(component.data),
    _round: { rolls: 1, winReason: 'four' }, _token: 0, _rotation: [-18, -26], _timers: [],
    setData(value, callback) { Object.assign(this.data, value); if (callback) callback(); },
    later() {}, refreshLayout() {} };
  item.data.visible = true; item.data.stage = 'ask';
  item._replySubmission = { singer: '周杰伦', song_name: '《晴天》' };
  return item;
}
const option = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value } });
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const preview = instance(); preview.showAscii(0, true);
  assert.equal(preview.data.bottomText, '小猫用文字和你打了个招呼。');
  const before = records;
  for (const [mode, templates, name] of [[2, sourceReplies.singerTemplates, '周杰伦'], [3, sourceReplies.songTemplates, '晴天']]) {
    preview.onTestOption(option('replyModeIndex', mode));
    assert.equal(preview.data.replyTemplates.length, templates.length);
    assert.equal(preview.data.replyTemplateIndex, 0);
    for (let i = 0; i < templates.length; i++) {
      preview.onTestOption(option('replyTemplateIndex', i));
      assert.equal(preview.data.bottomText, templates[i].replace(mode === 2 ? '{歌手}' : '{歌名}', name));
    }
  }
  assert.equal(records, before, 'fourteen previews must not increase encounter counts');
  preview.onTestOption(option('replyModeIndex', 1));
  assert.equal(preview.data.bottomText, '小猫用文字和你打了个招呼。');

  random = .9;
  for (const [test, admin] of [[false, true], [true, false], [false, false]]) {
    const ordinary = instance(test, admin); ordinary.data.replyModeIndex = 2;
    ordinary.onTestOption(option('replyTemplateIndex', 7));
    assert.equal(ordinary.data.replyTemplateIndex, 0, 'test controls must be ignored outside test superadmin');
    ordinary.showAscii(0);
    assert.equal(ordinary.data.bottomText, '小猫用文字和你打了个招呼。');
  }
  random = 0;
  const personalized = instance(false, false), count = choiceCalls;
  await personalized.showCat();
  assert.equal(personalized.data.stage, 'photo');
  assert.equal(personalized.data.topText, '管理员上方文案');
  assert.equal(personalized.data.bottomText, '我也很喜欢听周杰伦的歌呀');
  assert.equal(choiceCalls, count + 1);
  random = .9;
  personalized.onPhotoError();
  assert.equal(personalized.data.stage, 'ascii');
  assert.equal(personalized.data.bottomText, '我也很喜欢听周杰伦的歌呀');
  assert.equal(choiceCalls, count + 1, 'photo failure must reuse one caption decision');

  photo.hasCustomBottom = true; photo.bottomText = '管理员自定义下方文案';
  const custom = instance(); custom.data.replyModeIndex = 2;
  const customCount = choiceCalls;
  await custom.showCat();
  custom.onTestOption(option('replyTemplateIndex', 3));
  assert.equal(custom.data.bottomText, '管理员自定义下方文案');
  assert.equal(custom.data.topText, '管理员上方文案');
  assert.equal(choiceCalls, customCount);
  photo.hasCustomBottom = false;

  const unavailable = instance(); unavailable._replySubmission = null; unavailable.data.replyModeIndex = 4;
  unavailable.showAscii(0);
  assert.equal(unavailable.data.bottomText, '小猫用文字和你打了个招呼。');
  unavailable._replySubmission = { singer: '周杰伦' };
  unavailable.showAscii(0);
  assert.equal(unavailable.data.bottomText, '小猫用文字和你打了个招呼。', 'late load must not rewrite an already-decided reward');

  const requests = [];
  loadReply = () => new Promise(resolve => requests.push(resolve));
  const race = instance(); race.data.visible = false; race.open();
  assert.equal(race._replySubmission, null);
  race.close(); race.open();
  requests[0]({ singer: '旧歌手' }); await tick();
  assert.equal(race._replySubmission, null, 'closed session must not leak into reopened session');
  requests[1]({ singer: '新歌手' }); await tick();
  assert.equal(race._replySubmission.singer, '新歌手');
  race.close(); race.open(); race._detached = true;
  requests[2]({ singer: '迟来的' }); await tick();
  assert.equal(race._replySubmission, null, 'detached component ignores late results');
  for (const action of ['testAscii', 'testInvitation', 'testReset', 'scenarioIndex', 'pityIndex']) {
    const fast = instance(), timers = [];
    fast.later = (fn, ms) => timers.push({ fn, ms });
    if (action.endsWith('Index')) fast.onTestOption(option(action, 0));
    else fast[action]();
    assert.ok(timers.some(timer => timer.ms === 400), `${action} must restore post-entry layout calibration`);
  }
  console.log('PASS: 14 component previews, custom-caption priority, one decision per reward, production/test gating and asynchronous lifecycle');
})().catch(error => { console.error(error); process.exitCode = 1; });
