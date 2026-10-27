const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cats = require('../../utils/easter-cats');
const dice = require('../../utils/dice-easter-egg');
const sourceReplies = require('../../utils/easter-replies');

let checks = 0;
function check(actual, expected, label) { assert.equal(actual, expected, label); checks++; }

let component;
let previewCalls = [];
let failNextPreview = false;
let records = 0;
const photos = { DEFAULT_TOP: 'top', DEFAULT_BOTTOM: 'bottom', prepare: async () => null, manifest: async () => [], withTimeout: value => value };
const encounters = {
  pick: (_, catalog) => catalog[0],
  summary: (_, ids) => ({ seen: 0, total: ids.length }),
  record: (_, id, ids) => { records++; return { seen: 1, total: ids.length }; }
};
const replies = { ...sourceReplies, load: async () => null, choose: () => null };
// 原生预览在真机上不会通知“用户点了返回”，所以这里刻意只区分启动成功与启动失败。
const wx = {
  previewImage(options) {
    previewCalls.push(options);
    if (failNextPreview) { failNextPreview = false; if (options.fail) options.fail({ errMsg: 'previewImage:fail' }); }
    else if (options.success) options.success({ errMsg: 'previewImage:ok' });
  },
  nextTick(fn) { fn(); }
};
const context = {
  Component: value => { component = value; }, setTimeout, clearTimeout, wx,
  require(name) {
    if (name.endsWith('/theme')) return require('../../utils/theme');
    if (name.includes('easter-cats')) return cats;
    if (name.includes('replies')) return replies;
    if (name.includes('encounters')) return encounters;
    if (name.includes('photos')) return photos;
    return dice;
  }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../components/easter-dice/easter-dice.js'), 'utf8'), context);

function instance() {
  const item = {
    ...component.methods,
    properties: { testMode: false, superadmin: false },
    data: structuredClone(component.data),
    _round: { rolls: 3, won: true, winReason: 'four' },
    _token: 0, _rotation: [-18, -26], _timers: [], _layouts: 0, _resets: 0,
    setData(value, callback) { Object.assign(this.data, value); if (callback) callback(); },
    later(fn) { fn(); },
    refreshLayout() { this._layouts++; },
    clearTimers() {},
    resetRound() { this._resets++; }
  };
  Object.assign(item.data, {
    visible: true, stage: 'photo', photoReady: true, photoSrc: 'cached.jpg',
    topText: '上方文案', bottomText: '下方文案', _photoId: 'p1'
  });
  item._currentPhoto = { id: 'p1' };
  return item;
}
const hide = item => component.pageLifetimes.hide.call(item);
const show = item => component.pageLifetimes.show.call(item);
const reset = () => { previewCalls = []; failNextPreview = false; };

(async () => {
// 1) 预览期间页面 hide 只挂起，不能结束奖励或重置轮次。
reset();
let item = instance();
const recordsBefore = records;
await item.previewCat();
check(previewCalls.length, 1, 'previewImage 只调用一次');
hide(item);
check(item.data.visible, true, '预览中 hide 不能关闭弹窗');
check(item.data.stage, 'photo', '预览中 hide 不能切换阶段');
check(item.data.photoSrc, 'cached.jpg', '预览中 hide 不能清掉照片');
check(item.data.topText, '上方文案', '预览中 hide 保留上方文案');
check(item.data.bottomText, '下方文案', '预览中 hide 保留下方文案');
check(item._resets, 0, '预览中 hide 不能重置已中奖轮次');
check(item._token, 0, '预览中 hide 不能递增会话 token');
check(records, recordsBefore, '预览中 hide 不能重复记录遇见数');

// 2) 从大图返回（页面 show）：弹窗保持、布局重新校准、预览标记释放。
show(item);
check(item.data.visible, true, '返回后弹窗仍然打开');
check(item.data.stage, 'photo', '返回后仍是同一阶段');
check(item.data.photoSrc, 'cached.jpg', '返回后仍是同一张照片');
check(item._layouts, 1, '返回后重新校准一次布局');
check(item._previewing, false, '返回后预览标记已释放');
check(item._previewSuspended, false, '返回后挂起标记已释放');

// 3) 返回之后用户主动关闭，仍按原逻辑退出。
item.close();
check(item.data.visible, false, '用户主动关闭可以正常退出');
check(item._previewing, false, '主动关闭会清理预览标记');

// 4) 真正离开页面（非预览状态下的 hide）必须继续关闭。
reset();
item = instance();
hide(item);
check(item.data.visible, false, '非预览状态 hide 仍然关闭弹窗');
check(item._resets, 1, '非预览状态 hide 仍会重置已中奖轮次');

// 5) 预览启动失败要立刻释放标记，否则离开页面不再清理。
reset();
item = instance();
failNextPreview = true;
await item.previewCat();
check(item._previewing, false, '预览启动失败后标记立即释放');
hide(item);
check(item.data.visible, false, '预览失败后离开页面可以正常关闭');

// 6) 连点预览不应重复打开原生大图。
reset();
item = instance();
await item.previewCat();
await item.previewCat();
await item.previewCat();
check(previewCalls.length, 1, '连点只打开一次原生大图');

// 7) 照片未就绪或阶段不对时不触发预览。
reset();
item = instance();
item.data.photoReady = false;
await item.previewCat();
item.data.photoReady = true;
item.data.stage = 'ascii';
await item.previewCat();
item.data.stage = 'photo';
item.data.visible = false;
await item.previewCat();
check(previewCalls.length, 0, '照片未就绪、阶段不对或弹窗关闭时不预览');

// 8) 反复预览与返回多次后状态不串。
reset();
item = instance();
for (let i = 0; i < 3; i++) { await item.previewCat(); hide(item); show(item); }
check(item.data.visible, true, '多次预览往返后弹窗仍然打开');
check(item.data.photoSrc, 'cached.jpg', '多次预览往返后照片不变');
check(previewCalls.length, 3, '每次都只打开一次原生大图');

// 9) 预览标记泄漏有兜底：超时后清掉，之后的 hide 恢复清理能力。
reset();
item = instance();
item._previewing = true;
item._previewStartedAt = Date.now() - 6 * 60 * 1000;
show(item);
check(item._previewing, false, '超过兜底时长后预览标记被清除');
hide(item);
check(item.data.visible, false, '兜底清除后真正离开页面可以关闭');

// 10) 组件卸载时清理预览状态。
reset();
item = instance();
await item.previewCat();
component.lifetimes.detached.call(item);
check(item._detached, true, '卸载标记已设置');
check(item._previewing, false, '卸载后预览标记已清理');

console.log(`PASS: ${checks} preview lifecycle assertions; hide-suspend, show-restore, real leave, preview start failure, rapid taps, repeated rounds, leak fallback and unmount cleanup`);
})().catch(err => { console.error(err); process.exit(1); });
