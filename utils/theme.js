// 外观的唯一颜色来源。中性色、品牌色、状态色分开；页面只消费语义变量。
const NEUTRALS = {
  light: {
    bg: '#f4f2ef', surface: '#ffffff', 'surface-2': '#edebe7', 'surface-3': '#e2e5df',
    line: '#e0e3dc', 'line-strong': '#c6cec5', 'text-1': '#1b1b1d', 'text-2': '#5f6066',
    'text-3': '#686b63', placeholder: '#686b63', 'text-disabled': '#777e75',
    mask: 'rgba(0, 0, 0, .5)', 'on-overlay': '#ffffff',
    'surface-translucent': 'rgba(255, 255, 255, .96)',
    'shadow-sm': '0 2rpx 8rpx rgba(60, 50, 40, .05)',
    'shadow-md': '0 8rpx 24rpx rgba(60, 50, 40, .08)',
    'shadow-dialog': '0 26rpx 90rpx rgba(0, 0, 0, .18)'
  },
  dark: {
    bg: '#141a16', surface: '#1f2722', 'surface-2': '#2a352e', 'surface-3': '#344139',
    line: '#3d4b41', 'line-strong': '#59695c', 'text-1': '#f1f3ef', 'text-2': '#c0c9c0',
    'text-3': '#a5b2a6', placeholder: '#a5b2a6', 'text-disabled': '#9caaa0',
    mask: 'rgba(0, 0, 0, .72)', 'on-overlay': '#ffffff',
    'surface-translucent': 'rgba(31, 39, 34, .96)',
    'shadow-sm': '0 2rpx 8rpx rgba(0, 0, 0, .2)',
    'shadow-md': '0 8rpx 24rpx rgba(0, 0, 0, .28)',
    'shadow-dialog': '0 26rpx 90rpx rgba(0, 0, 0, .5)'
  }
};
const PALETTES = {
  green: {
    light: {
      accent: '#28764f', 'accent-weak': '#e8f2ec', 'accent-pressed': '#246a48',
      'accent-disabled': '#8aab98', 'on-accent': '#ffffff',
      'gradient-open-start': '#e2efe7', 'gradient-open-mid': '#eef1ea',
      'gradient-closed-start': '#eceae5', 'gradient-closed-mid': '#f0eeea',
      'focus-ring': '0 0 0 4rpx rgba(40, 118, 79, .22)'
    },
    dark: {
      accent: '#7ed5a1', 'accent-weak': '#233d2e', 'accent-pressed': '#a0e2b9',
      'accent-disabled': '#4c6d58', 'on-accent': '#102218',
      'gradient-open-start': '#1c2b22', 'gradient-open-mid': '#18231c',
      'gradient-closed-start': '#1a211c', 'gradient-closed-mid': '#171e19',
      'focus-ring': '0 0 0 4rpx rgba(126, 213, 161, .3)'
    }
  }
};
// 业务状态色不随将来的品牌主题换色。
const STATES = {
  light: {
    success: '#217346', 'success-weak': '#e8f2ec', 'on-success': '#ffffff',
    danger: '#bd3535', 'danger-weak': '#fbeceb', 'on-danger': '#ffffff',
    warn: '#805711', 'warn-weak': '#fdf3e3', 'on-warn': '#ffffff',
    info: '#2f6fb3', 'info-weak': '#eaf1fa', 'on-info': '#ffffff',
    carryover: '#72509e', 'carryover-weak': '#f3eaf9'
  },
  dark: {
    success: '#81d9a3', 'success-weak': '#233d2e', 'on-success': '#102218',
    danger: '#ffaaa5', 'danger-weak': '#432a29', 'on-danger': '#301311',
    warn: '#efc77b', 'warn-weak': '#3b311e', 'on-warn': '#2d210b',
    info: '#99c5f3', 'info-weak': '#233346', 'on-info': '#102337',
    carryover: '#d5b3f3', 'carryover-weak': '#352944'
  }
};
const STORAGE_KEY = 'appearance_preferences_v1';
let preference = { mode: 'system', palette: 'green' };
let systemMode = 'light', started = false;
const listeners = new Set();
const api = () => typeof wx === 'undefined' ? null : wx;
const validMode = value => value === 'light' || value === 'dark' || value === 'system';

function getTokens(mode = 'light', palette = 'green') {
  const resolved = mode === 'dark' ? 'dark' : 'light';
  const brand = Object.prototype.hasOwnProperty.call(PALETTES, palette) ? PALETTES[palette] : PALETTES.green;
  return { ...NEUTRALS[resolved], ...brand[resolved], ...STATES[resolved] };
}
function cssVariables(tokens) {
  return Object.keys(tokens).map(key => `--${key}:${tokens[key]};`).join('');
}
function iconSources(tokens) {
  const svg = (body, color) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`);
  const bell = '<path d="M15 7a5 5 0 0 0-10 0c0 6-2 6-2 7h14c0-1-2-1-2-7M8 17h4"/>';
  return {
    back: svg('<path d="m12 4-6 6 6 6"/>', tokens['text-1']),
    chevron: svg('<path d="m5.5 7.5 4.5 4.5 4.5-4.5"/>', tokens['text-3']),
    bell: svg(bell, tokens.accent), bellMuted: svg(bell, tokens['text-2'])
  };
}
function getState() {
  const resolved = preference.mode === 'system' ? systemMode : preference.mode;
  const tokens = getTokens(resolved, preference.palette);
  return { ...preference, resolved, tokens, style: cssVariables(tokens), icons: iconSources(tokens) };
}
function notify() { const state = getState(); listeners.forEach(listener => listener(state)); }
function readSystemMode() {
  const platform = api();
  if (!platform) return;
  for (const reader of ['getAppBaseInfo', 'getSystemInfoSync']) {
    if (typeof platform[reader] !== 'function') continue;
    try {
      const info = platform[reader]();
      if (info && (info.theme === 'dark' || info.theme === 'light')) { systemMode = info.theme; return; }
    } catch (_) { /* 新接口不可用或缺字段时尝试旧接口，均失败则保留最近模式。 */ }
  }
}
function start() {
  if (started || !api()) return;
  started = true;
  const platform = api();
  try {
    const saved = platform.getStorageSync && platform.getStorageSync(STORAGE_KEY);
    if (saved && validMode(saved.mode)) preference.mode = saved.mode;
    if (saved && Object.prototype.hasOwnProperty.call(PALETTES, saved.palette)) preference.palette = saved.palette;
  } catch (_) {}
  readSystemMode();
  try {
    if (typeof platform.onThemeChange === 'function') platform.onThemeChange(({ theme } = {}) => {
      if ((theme === 'light' || theme === 'dark') && theme !== systemMode) {
        systemMode = theme;
        if (preference.mode === 'system') notify();
      }
    });
  } catch (_) { /* 老客户端可继续使用手动选择，不让监听失败影响页面。 */ }
}
function refreshSystem() {
  start();
  const before = getState().resolved;
  readSystemMode();
  if (before !== getState().resolved) notify();
}
// 微信原生确认框由系统着色；手动选择应用深色时也应按系统底色选择其按钮色。
function getNativeColors() { readSystemMode(); return getTokens(systemMode, preference.palette); }
function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
// 供后续「我的」接入；本轮没有新增设置入口，也不主动写入偏好。
function setPreference(next) {
  if (!next || !validMode(next.mode) || !Object.prototype.hasOwnProperty.call(PALETTES, next.palette || preference.palette)) return false;
  preference = { mode: next.mode, palette: next.palette || preference.palette };
  readSystemMode();
  try { if (api() && api().setStorageSync) api().setStorageSync(STORAGE_KEY, { ...preference }); } catch (_) {}
  notify();
  return true;
}
function viewData(state = getState()) {
  return { appearanceMode: state.resolved, appearanceStyle: state.style, themeIcons: state.icons, themeColors: state.tokens };
}
function syncNative(state) {
  const platform = api();
  if (!platform) return;
  try {
    if (platform.setNavigationBarColor) platform.setNavigationBarColor({
      frontColor: state.resolved === 'dark' ? '#ffffff' : '#000000', backgroundColor: state.tokens.surface,
      fail() {}
    });
    if (platform.setBackgroundColor) platform.setBackgroundColor({
      backgroundColor: state.tokens.bg, backgroundColorTop: state.tokens.bg, backgroundColorBottom: state.tokens.bg,
      fail() {}
    });
    if (platform.setBackgroundTextStyle) platform.setBackgroundTextStyle({ textStyle: state.resolved === 'dark' ? 'light' : 'dark', fail() {} });
  } catch (_) { /* 原生 API 不支持时，theme.json 与 CSS 仍负责系统跟随和页面配色。 */ }
}
function page(definition) {
  const result = { ...definition, data: { ...viewData(), ...definition.data } };
  result.onLoad = function (...args) {
    start();
    this._appearanceVisible = true;
    this._releaseAppearance = subscribe(state => {
      this.setData(viewData(state));
      if (this._appearanceVisible) syncNative(state);
    });
    this.setData(viewData()); syncNative(getState());
    if (definition.onLoad) return definition.onLoad.apply(this, args);
  };
  result.onShow = function (...args) {
    this._appearanceVisible = true; refreshSystem();
    this.setData(viewData()); syncNative(getState());
    if (definition.onShow) return definition.onShow.apply(this, args);
  };
  result.onHide = function (...args) {
    this._appearanceVisible = false;
    if (definition.onHide) return definition.onHide.apply(this, args);
  };
  result.onUnload = function (...args) {
    this._appearanceVisible = false;
    if (this._releaseAppearance) this._releaseAppearance();
    this._releaseAppearance = null;
    if (definition.onUnload) return definition.onUnload.apply(this, args);
  };
  return result;
}
function component(definition) {
  const life = definition.lifetimes || {};
  return { ...definition, data: { ...viewData(), ...definition.data }, lifetimes: {
    ...life,
    attached(...args) {
      start(); this.setData(viewData());
      this._releaseAppearance = subscribe(state => this.setData(viewData(state)));
      if (life.attached) return life.attached.apply(this, args);
    },
    detached(...args) {
      if (this._releaseAppearance) this._releaseAppearance();
      this._releaseAppearance = null;
      if (life.detached) return life.detached.apply(this, args);
    }
  } };
}
module.exports = { getTokens, cssVariables, getState, getNativeColors, start, refreshSystem, subscribe, setPreference, page, component, STORAGE_KEY };
