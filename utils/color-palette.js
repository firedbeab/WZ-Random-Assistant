// 只生成品牌语义色；中性色和业务状态色由 theme 保持独立。
const PRESETS = { green: '#28764f', blue: '#4268af', amber: '#a56b28', plum: '#916098', wzred: '#9f2925' };
function normalize(value) { return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : ''; }
function rgb(hex) { return hex.slice(1).match(/../g).map(v => parseInt(v, 16)); }
function hex(values) { return '#' + values.map(v => Math.round(v).toString(16).padStart(2, '0')).join(''); }
function mix(a, b, amount) { const target = rgb(b); return hex(rgb(a).map((v, i) => v + (target[i] - v) * amount)); }
function luminance(color) { const c = rgb(color).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; }
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
function neutralTint(mode, seed) {
  const dark = mode === 'dark';
  const bases = dark ? { bg: '#171819', surface: '#232426', 'surface-2': '#2e3033', 'surface-3': '#3b3d40', line: '#45484b', 'line-strong': '#63676b', 'feedback-surface': '#3b3d40', 'feedback-line': '#92979d' }
    : { bg: '#f4f2ef', surface: '#ffffff', 'surface-2': '#edebe9', 'surface-3': '#e3e3e3', line: '#e0e1e3', 'line-strong': '#c6c9cd', 'feedback-surface': '#ffffff', 'feedback-line': '#b0b7bf' };
  const tokens = {};
  const hsv = hexToHsv(seed);
  // A fixed low-light tint carries the chosen hue into the actual surfaces,
  // even when the original seed is very dark or bright. Neutral seeds stay grey.
  const tint = dark && hsv.s > .07 ? hsvToHex(hsv.h, Math.min(hsv.s, .8), .26) : null;
  for (const key of Object.keys(bases)) {
    if (!dark && ['surface', 'feedback-surface'].includes(key)) tokens[key] = bases[key];
    else if (tint && ['bg', 'surface', 'surface-2', 'surface-3', 'feedback-surface'].includes(key)) tokens[key] = mix(bases[key], tint, .35);
    else tokens[key] = mix(bases[key], seed, dark ? .035 : .012);
  }
  return { ...tokens, 'text-1': dark ? '#f3f3f4' : '#1b1b1d', 'text-2': dark ? '#c5c7ca' : '#5f6066',
    'text-3': dark ? '#afb2b6' : '#62656b', placeholder: dark ? '#afb2b6' : '#62656b', 'text-disabled': dark ? '#a6aab0' : '#73777c',
    'feedback-scrim': dark ? 'rgba(0,0,0,.4)' : 'rgba(24,24,28,.18)',
    'surface-translucent': `rgba(${rgb(tokens.surface).join(',')},.96)` };
}
function generate(seed, mode, neutrals) {
  if (!normalize(seed)) throw new Error('无效颜色');
  const dark = mode === 'dark', neutral = neutrals || neutralTint(mode, seed), base = neutral.bg, surface = neutral['surface-2'];
  const target = dark ? '#ffffff' : '#000000', on = dark ? '#141516' : '#ffffff';
  let accent = seed;
  const readable = candidate => {
    const weak = mix(base, candidate, dark ? .12 : .06);
    return [base, surface, neutral.surface, neutral['surface-3'], neutral['feedback-surface'], weak, on].filter(Boolean).every(bg => contrast(candidate, bg) >= 4.5);
  };
  if (dark) {
    // Lighten in HSV instead of mixing directly with white: preserve the user's
    // hue and as much saturation as contrast allows, including custom colors.
    const hsv = hexToHsv(seed), saturation = Math.min(hsv.s, .7);
    let found = false;
    for (let step = 0; step <= 70 && !found; step++) {
      const s = Math.max(0, saturation - step / 100);
      for (let level = Math.ceil(Math.max(hsv.v, .7) * 100); level <= 100; level++) {
        const candidate = hsvToHex(hsv.h, s, level / 100);
        if (readable(candidate)) { accent = candidate; found = true; break; }
      }
    }
    if (!found) accent = '#ffffff';
  } else {
    for (let i = 0; i <= 100; i++) {
      accent = mix(seed, target, i / 100);
      if (readable(accent)) break;
    }
  }
  return { accent, 'accent-weak': mix(base, accent, dark ? .12 : .06), 'accent-pressed': mix(accent, target, .12),
    'accent-disabled': mix(base, accent, .45), 'on-accent': on,
    'gradient-open-start': mix(base, accent, .13), 'gradient-open-mid': mix(base, accent, .045),
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
module.exports = { PRESETS, normalize, generate, neutralTint, mix, contrast, hsvToHex, hexToHsv };
