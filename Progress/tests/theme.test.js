const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const theme = require('../../utils/theme');
const { outputs } = require('../build-theme.cjs');

function fixture(options = {}) {
  let event, keyboard, keyboardRemovals = 0;
  let windowInfo = { windowHeight: 800, windowWidth: 390, statusBarHeight: 44 };
  const disk = options.disk || new Map(), natives = [];
  let system = options.system || 'light', observers = 0;
  const wx = {
    getStorageSync: key => disk.get(key), setStorageSync: (key, value) => disk.set(key, structuredClone(value)),
    getAppBaseInfo: () => ({ theme: system }),
    onThemeChange: handler => { observers++; event = handler; },
    getWindowInfo: () => windowInfo,
    getMenuButtonBoundingClientRect: () => ({ top: 50, height: 32, left: 290 }),
    onKeyboardHeightChange: handler => { keyboard = handler; },
    offKeyboardHeightChange: handler => { if (handler === keyboard) { keyboard = null; keyboardRemovals++; } },
    setNavigationBarColor: value => natives.push(value), setBackgroundColor() {}, setBackgroundTextStyle() {}
  };
  if (options.old) { delete wx.getAppBaseInfo; wx.getSystemInfoSync = () => ({ theme: system }); }
  if (options.throwing) { wx.getAppBaseInfo = () => { throw Error('unsupported'); }; wx.onThemeChange = () => { throw Error('unsupported'); }; }
  const sandbox = { module: { exports: {} }, wx, setTimeout, clearTimeout, require: name => name.includes('navigation-layout') ? require('../../utils/navigation-layout') : require('../../utils/color-palette') };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/theme.js'), 'utf8'), sandbox);
  const instance = sandbox.module.exports;
  return { theme: instance, wx, disk, natives, observers: () => observers, emit(mode) { system = mode; if (event) event({ theme: mode }); }, window(value) { windowInfo = { ...windowInfo, ...value }; }, keyboard(height) { if (keyboard) keyboard({ height }); }, keyboardRemovals: () => keyboardRemovals };
}
const makePage = definition => ({ data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } });
function luminance(hex) {
  const values = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
}
function contrast(a, b) { const first = luminance(a), second = luminance(b); return (Math.max(first, second) + .05) / (Math.min(first, second) + .05); }

test('浅深色的正文、辅助文字、品牌操作和状态文字均保有可读对比度', () => {
  for (const mode of ['light', 'dark']) {
    const colors = theme.getTokens(mode);
    for (const text of ['text-1', 'text-2', 'text-3', 'placeholder']) for (const surface of ['bg', 'surface', 'surface-2']) {
      assert.ok(contrast(colors[text], colors[surface]) >= 4.5, `${mode}: ${text}/${surface}=${contrast(colors[text], colors[surface])}`);
    }
    for (const family of ['accent', 'success', 'danger', 'warn', 'info']) {
      assert.ok(contrast(colors[family], colors[family + '-weak']) >= 4.5, `${mode}: ${family} on weak surface`);
      assert.ok(contrast(colors[family], colors['on-' + family]) >= 4.5, `${mode}: ${family} filled button`);
    }
  }
});
test('颜色生成物无漂移，九页均接入外观变量和切换按钮，所有语义变量均有定义', () => {
  for (const [file, expected] of Object.entries(outputs())) assert.equal(fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n'), expected);
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  assert.equal(app.darkmode, true); assert.equal(app.themeLocation, 'theme.json');
  const variableNames = new Set(Object.keys(theme.getTokens()).concat([...fs.readFileSync(path.join(root, 'styles/tokens.wxss'), 'utf8').matchAll(/--([\w-]+):/g)].map(match => match[1]), ['lift', 'tilt', 'travel', 'rise', 'spin', 'entry-x', 'entry-y', 'drift', 'dice-size', 'dice-pip-depth', 'window-height', 'keyboard-inset', 'feedback-top', 'navigation-height']));
  function inspect(dir) { for (const item of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isDirectory()) inspect(file); else if (item.name.endsWith('.wxss')) for (const match of fs.readFileSync(path.join(root, file), 'utf8').matchAll(/var\(--([\w-]+)/g)) assert(variableNames.has(match[1]), `${file}: undefined ${match[1]}`); } }
  for (const dir of ['pages', 'components', 'styles']) inspect(dir);
  for (const page of app.pages) {
    const config = JSON.parse(fs.readFileSync(path.join(root, page + '.json'), 'utf8')), xml = fs.readFileSync(path.join(root, page + '.wxml'), 'utf8');
    assert.equal(config.navigationBarTextStyle, '@navigationBarTextStyle');
    assert.ok(xml.startsWith('<page-meta page-style="{{appearanceStyle}}'));
    assert.ok(/<appearance-toggle(?:\s[^>]*)?\s*\/>/.test(xml)); assert.ok(config.usingComponents['appearance-toggle']);
  }
});
test('系统主题初始化、单次监听、旧API与不可用API降级', () => {
  const f = fixture({ system: 'dark' }); f.theme.start(); f.theme.start();
  assert.equal(f.observers(), 1); assert.equal(f.theme.getState().resolved, 'dark');
  let notified = 0; const release = f.theme.subscribe(() => notified++);
  f.emit('light'); assert.equal(f.theme.getState().resolved, 'light'); assert.equal(notified, 1);
  release(); f.emit('dark'); assert.equal(notified, 1);
  const old = fixture({ old: true, system: 'dark' }); old.theme.start(); assert.equal(old.theme.getState().resolved, 'dark');
  const partial = fixture(); partial.wx.getAppBaseInfo = () => ({}); partial.wx.getSystemInfoSync = () => ({ theme: 'dark' });
  partial.theme.start(); assert.equal(partial.theme.getState().resolved, 'dark');
  const unavailable = fixture({ throwing: true }); assert.doesNotThrow(() => unavailable.theme.start()); assert.equal(unavailable.theme.getState().resolved, 'light');
});
test('手动选择持久化、拒绝非法配色，切回跟随系统可恢复系统变化', () => {
  const f = fixture(); f.theme.start();
  assert.equal(f.theme.setPreference({ mode: 'dark', palette: 'green' }), true);
  f.emit('light'); assert.equal(f.theme.getState().resolved, 'dark');
  const second = fixture({ disk: f.disk }); second.theme.start(); assert.equal(second.theme.getState().resolved, 'dark');
  assert.equal(f.theme.setPreference({ mode: 'dark', palette: 'invalid;--bg:red' }), false);
  assert.equal(f.theme.setPreference({ mode: 'invalid' }), false);
  f.theme.setPreference({ mode: 'system' }); assert.equal(f.theme.getState().resolved, 'light');
  f.emit('dark'); assert.equal(f.theme.getState().resolved, 'dark');
});
test('页面生命周期、返回值和业务data保留；隐藏页面不覆盖当前原生导航，卸载解除监听', async () => {
  const f = fixture(), calls = [];
  const definition = f.theme.page({ data: { title: '原业务' }, async onLoad(value) { calls.push(value); return 42; }, onShow() { calls.push('show'); }, onHide() { calls.push('hide'); }, onUnload() { calls.push('unload'); } });
  const page = makePage(definition);
  assert.equal(await definition.onLoad.call(page, 'options'), 42); assert.equal(page.data.title, '原业务');
  definition.onHide.call(page); const nativeCount = f.natives.length;
  f.emit('dark'); assert.equal(page.data.appearanceMode, 'dark'); assert.equal(f.natives.length, nativeCount);
  definition.onShow.call(page); assert.equal(f.natives.at(-1).frontColor, '#ffffff');
  definition.onUnload.call(page); f.emit('light'); assert.equal(page.data.appearanceMode, 'dark');
  assert.deepEqual(calls, ['options', 'hide', 'show', 'unload']);
});
test('键盘覆盖与窗口已缩高不重复抬升，通知避开导航，旋转与卸载保留生命周期', () => {
  const f=fixture();let resized=0;
  const def=f.theme.page({data:{},onResize(){resized++;}}),p=makePage(def);def.onLoad.call(p);
  assert.match(p.data.viewportStyle,/--feedback-top:100px/);
  f.keyboard(300);assert.match(p.data.viewportStyle,/--keyboard-inset:300px/);
  f.window({windowHeight:500});def.onResize.call(p);f.keyboard(300);assert.match(p.data.viewportStyle,/--keyboard-inset:0px/);
  f.window({windowHeight:620});f.keyboard(300);assert.match(p.data.viewportStyle,/--keyboard-inset:120px/);
  f.window({windowHeight:800});f.keyboard(0);assert.match(p.data.viewportStyle,/--keyboard-inset:0px/);
  f.window({windowHeight:390});def.onResize.call(p);assert.equal(resized,2);assert.match(p.data.viewportStyle,/--window-height:390px/);
  def.onUnload.call(p);const old=p.data.viewportStyle;f.keyboard(200);assert.equal(p.data.viewportStyle,old);assert.equal(f.keyboardRemovals(),1);
});

test('组件附加与销毁保持原行为，SVG色值随外观更新而照片数据原样保留', () => {
  const f = fixture(), calls = [];
  const def = f.theme.component({ data: { photo: '/original.jpg' }, lifetimes: { attached() { calls.push('attached'); }, detached() { calls.push('detached'); } } });
  const component = makePage(def); def.lifetimes.attached.call(component);
  const lightIcon = component.data.themeIcons.bell;
  f.emit('dark'); assert.notEqual(component.data.themeIcons.bell, lightIcon); assert.equal(component.data.photo, '/original.jpg');
  assert.ok(decodeURIComponent(component.data.themeIcons.bell).includes(f.theme.getTokens('dark').accent));
  def.lifetimes.detached.call(component); f.emit('light'); assert.equal(component.data.appearanceMode, 'dark');
  assert.deepEqual(calls, ['attached', 'detached']);
});
test('共用切换按钮更新所有已加载页面并保存选择，业务data不丢失', () => {
  const f = fixture(); let toggle;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'components/appearance-toggle/appearance-toggle.js'), 'utf8'), { Component: value => { toggle = value; }, require: () => f.theme });
  const def = f.theme.page({ data: { note: '保留' } }), first = makePage(def), second = makePage(def);
  def.onLoad.call(first); def.onLoad.call(second); toggle.methods.toggle();
  assert.equal(first.data.appearanceMode, 'dark'); assert.equal(second.data.appearanceMode, 'dark'); assert.equal(first.data.note, '保留');
  assert.equal(f.disk.get(f.theme.STORAGE_KEY).mode, 'dark'); toggle.methods.toggle(); assert.equal(first.data.appearanceMode, 'light');
  def.onUnload.call(first); def.onUnload.call(second);
});
test('手动外观不让原生确认框在系统浅色背景使用浅粉色文字', () => {
  const f = fixture(); f.theme.start(); f.theme.setPreference({ mode: 'dark' });
  assert.equal(f.theme.getState().tokens.danger, '#ffaaa5');
  assert.equal(f.theme.getNativeColors().danger, '#bd3535');
  f.emit('dark'); assert.equal(f.theme.getNativeColors().danger, '#ffaaa5');
});

test('实时调色立即广播，关闭或离页时可刷入最后一个颜色，重启恢复自定义主题', () => {
  const f=fixture();f.theme.start();
  f.theme.setPreference({mode:'dark',palette:'custom',customColor:'#9f2925'},{deferSave:true});
  assert.equal(f.theme.getState().palette,'custom');assert.equal(f.theme.getState().customColor,'#9f2925');
  f.theme.flushPreference();const second=fixture({disk:f.disk});second.theme.start();
  assert.equal(second.theme.getState().customColor,'#9f2925');assert.equal(second.theme.getState().resolved,'dark');
});
