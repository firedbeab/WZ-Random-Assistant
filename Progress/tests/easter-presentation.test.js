const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { cats, invitations, ASCII_REWARD_CHANCE } = require('../../utils/easter-cats');
const replies = require('../../utils/easter-replies');
let component;
const disk = new Map();
const encounterContext = { module: { exports: {} }, require: () => ({ storageKey: key => 'test_' + key }), wx: { getStorageSync: key => disk.get(key), setStorageSync: (key, value) => disk.set(key, structuredClone(value)) } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../utils/easter-encounters.js'), 'utf8'), encounterContext);
const encounters = encounterContext.module.exports;
const photos = { DEFAULT_TOP: 'top', DEFAULT_BOTTOM: 'bottom', prepare: async () => ({ id: 'cat', path: 'cached.jpg' }), withTimeout: promise => promise };
const context = {
  require: name => name.includes('easter-cats') ? { cats, invitations, ASCII_REWARD_CHANCE } : name.includes('replies') ? replies : name.includes('encounters') ? encounters : name.includes('photos') ? photos : {},
  Component: value => { component = value; }, Math: Object.create(Math)
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../components/easter-dice/easter-dice.js'), 'utf8'), context);
const css = fs.readFileSync(path.join(__dirname, '../../components/easter-dice/easter-dice.wxss'), 'utf8');
const wxml = fs.readFileSync(path.join(__dirname, '../../components/easter-dice/easter-dice.wxml'), 'utf8');
const tags = [];
for (const match of wxml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<\/?([a-z][\w-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
  if (match[0].startsWith('</')) assert.equal(tags.pop(), match[1], `unbalanced WXML: ${match[0]}`);
  else if (!match[0].endsWith('/>')) tags.push(match[1]);
}
assert.equal(tags.length, 0, 'every WXML element must be closed');
const sleep = cats.find(cat => cat.motion === 'sleep');
assert.equal(sleep.lines.length, 2);
assert.ok(!sleep.art.includes('z Z'), 'sleep symbols must not widen the centered face');
assert.equal((wxml.match(/class="sleep-z"/g) || []).length, 1, 'keep exactly one independently positioned sleep symbol');
assert.ok(wxml.includes('class="sleep-z">z Z</text>'));
assert.ok(!wxml.includes('class="local-progress"'));
assert.ok(wxml.includes('<scroll-view class="egg-scroll"'));
assert.ok(wxml.includes('height:{{scrollHeight}}px;'));
assert.ok(!wxml.split('\n')[0].includes('catchtouchmove'));
assert.ok(wxml.includes('class="egg-backdrop" catchtap="close" catchtouchmove="noop"'));
assert.ok(!css.includes('overflow-y: auto'));
assert.equal(cats[6].winkFace, '( >ω· )');
assert.equal(cats[8].art.includes('ڡ'), false);
assert.ok(cats.every(cat => cat.lines.every(line => line === line.trim())));
for (const motion of ['peek', 'heart', 'shy', 'wink']) {
  const animation = css.match(new RegExp(`@keyframes cat-${motion} \\{[^\\n]+`))[0];
  assert.ok(!animation.includes('rotate'), `${motion} must face forward`);
}
assert.equal(cats.length, 12);
assert.equal(new Set(cats.map(cat => cat.name)).size, 12);
assert.equal(ASCII_REWARD_CHANCE, .2);
for (const cat of cats) {
  assert.ok(cat.art.trim());
  assert.ok(css.includes(`.cat-${cat.motion} { animation:`) || new RegExp(`\\.cat-${cat.motion} \\{[^}]*animation:`).test(css));
  assert.ok(css.includes(`@keyframes cat-${cat.motion}`));
}
function instance(reason) {
  return {
    ...component.methods, data: { stage: 'ask', visible: true, meows: [] }, _round: { winReason: reason }, _token: 0,
    setData(value, callback) { Object.assign(this.data, value); if (callback) callback(); }, testAllowed: () => false,
    later(fn, ms) { if (ms < 1000) fn(); }
  };
}
(async () => {
  for (const reason of ['pairs', 'triples']) {
    context.Math.random = () => .199999;
    const text = instance(reason); await text.showCat(); assert.equal(text.data.stage, 'ascii');
    context.Math.random = () => .2;
    const photo = instance(reason); await photo.showCat(); assert.equal(photo.data.stage, 'photo');
  }
  context.Math.random = () => 0;
  const four = instance('four'); await four.showCat(); assert.equal(four.data.stage, 'photo');
  assert.equal(encounters.summary('photo', ['cat']).seen, 0);
  four.onPhotoLoad({ currentTarget: { dataset: { photoId: 'old' } } });
  assert.equal(encounters.summary('photo', ['cat']).seen, 0);
  four.onPhotoLoad({ currentTarget: { dataset: { photoId: 'cat' } } });
  assert.equal(four.data.encounterSeen, 1); assert.equal(four.data.encounterTotal, 1);
  four.onPhotoLoad(); assert.equal(encounters.summary('photo', ['cat']).seen, 1);
  const preview = instance('pairs'), before = encounters.summary('cat', cats.map(cat => cat.id)).seen;
  preview.showAscii(7, true); assert.equal(encounters.summary('cat', cats.map(cat => cat.id)).seen, before);
  const alreadySeen = encounters.summary('cat', [cats[7].id]).seen;
  preview.showAscii(7); assert.equal(preview.data.encounterSeen, before + (alreadySeen ? 0 : 1));
  const failed = instance('four'); await failed.showCat(); failed.onPhotoError();
  assert.equal(failed.data.stage, 'ascii'); assert.equal(encounters.summary('photo', ['cat']).seen, 1);
  const hiddenBefore = encounters.summary('cat', [cats[9].id]).seen;
  const hidden = instance('pairs'); hidden.data.visible = false; hidden.showAscii(9);
  assert.equal(encounters.summary('cat', [cats[9].id]).seen, hiddenBefore);
  const swipe = instance('pairs'); let throws = 0; swipe.roll = () => throws++;
  swipe.data.testExpanded = true; swipe.onTouchStart({ touches: [{ clientX: 10, clientY: 100 }] });
  swipe.onTouchEnd({ changedTouches: [{ clientX: 10, clientY: 20 }] }); assert.equal(throws, 0);
  swipe.data.testExpanded = false; swipe.onTouchStart({ touches: [{ clientX: 10, clientY: 100 }] });
  swipe.onTouchEnd({ changedTouches: [{ clientX: 10, clientY: 20 }] }); assert.equal(throws, 1);
  // 关闭之后的测量回调不得重新修改弹窗高度。
  let measure, ticks = [];
  context.wx = { nextTick: fn => ticks.push(fn), getWindowInfo: () => ({ windowHeight: 500 }) };
  const layout = instance('pairs'); layout.data.scrollHeight = 400;
  layout.createSelectorQuery = () => ({ select() { return this; }, boundingClientRect(fn) { measure = fn; return this; }, exec() {} });
  layout.refreshLayout(); ticks.shift()(); measure({ height: 900 }); assert.equal(layout.data.scrollHeight, 430);
  layout.refreshLayout(); ticks.shift()(); layout.data.visible = false; measure({ height: 200 }); assert.equal(layout.data.scrollHeight, 430);
  const meows = instance('pairs');
  for (let i = 0; i < 100; i++) {
    context.Math.random = () => i / 100;
    meows.meow(3);
  }
  let previousCorner;
  for (const item of meows.data.meows) {
    const left = Number(item.style.match(/left:([\d.]+)%/)[1]);
    const top = Number(item.style.match(/top:([\d.]+)%/)[1]);
    assert.ok((left >= 5 && left < 8) || (left >= 71 && left < 74));
    assert.ok((top >= 16 && top < 21) || (top >= 72 && top < 77));
    const corner = (top > 50 ? 2 : 0) + (left > 50 ? 1 : 0);
    assert.notEqual(corner, previousCorner); previousCorner = corner;
    assert.ok(!/--[\w-]+:-?[\d.]+px;/.test(item.style)); // offsets scale with the popup, not viewport pixels
  }
  for (let i = 0; i < meows.data.meows.length; i += 3) {
    assert.equal(new Set(meows.data.meows.slice(i, i + 3).map(item => {
      const left = Number(item.style.match(/left:([\d.]+)%/)[1]);
      const top = Number(item.style.match(/top:([\d.]+)%/)[1]);
      return (top > 50 ? 2 : 0) + (left > 50 ? 1 : 0);
    })).size, 3);
  }
  console.log('PASS: 12 animated cats, reward boundaries, display-only counts, preview exclusion, swipe/scroll separation and bounded meows');
})().catch(error => { console.error(error); process.exitCode = 1; });
