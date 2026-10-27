// 只生成品牌语义色；中性色和业务状态色由 theme 保持独立。
const PRESETS = { green: '#28764f', blue: '#4268af', amber: '#a56b28', plum: '#916098' };
function normalize(value) { return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : ''; }
function rgb(hex) { return hex.slice(1).match(/../g).map(v => parseInt(v, 16)); }
function hex(values) { return '#' + values.map(v => Math.round(v).toString(16).padStart(2, '0')).join(''); }
function mix(a, b, amount) { const target = rgb(b); return hex(rgb(a).map((v, i) => v + (target[i] - v) * amount)); }
function luminance(color) { const c = rgb(color).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; }
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
function generate(seed, mode) {
  if (!normalize(seed)) throw new Error('无效颜色');
  const dark = mode === 'dark', base = dark ? '#141a16' : '#f4f2ef', surface = dark ? '#2a352e' : '#edebe7';
  const target = dark ? '#ffffff' : '#000000', on = dark ? '#102218' : '#ffffff';
  let accent = seed;
  for (let i = 0; i <= 100; i++) {
    accent = mix(seed, target, i / 100);
    const weak = mix(base, accent, dark ? .12 : .06);
    if ([base, surface, weak, on].every(bg => contrast(accent, bg) >= 4.5)) break;
  }
  return { accent, 'accent-weak': mix(base, accent, dark ? .12 : .06), 'accent-pressed': mix(accent, target, .12),
    'accent-disabled': mix(base, accent, .45), 'on-accent': on,
    'gradient-open-start': mix(base, accent, .13), 'gradient-open-mid': mix(base, accent, .045),
    'gradient-closed-start': mix(base, accent, .035), 'gradient-closed-mid': mix(base, accent, .012),
    'focus-ring': `0 0 0 4rpx ${mix(base, accent, .4)}` };
}
function hsvToHex(h, s, v) {
  const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return hex([f(5), f(3), f(1)].map(n => n * 255));
}
function hexToHsv(color) {
  const [r, g, b] = rgb(color).map(v => v / 255), max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = !d ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}
module.exports = { PRESETS, normalize, generate, contrast, hsvToHex, hexToHsv };
