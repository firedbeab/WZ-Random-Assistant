const theme = require('../../utils/theme');
const colors = require('../../utils/color-palette');
// RGB hex accepts six digits, with an optional leading #. The theme module
// continues to store the canonical #rrggbb form.
function inputColor(value) {
  if (typeof value !== 'string') return '';
  const clean = value.trim();
  return colors.normalize(clean[0] === '#' ? clean : '#' + clean);
}
Component(theme.component({
  properties: { value: { type: String, value: '#28764f', observer(value) { if (colors.normalize(value) && value !== this.data.hex) this.applyHex(value); } } },
  data: { hex: '#28764f', hue: 150, hueColor: '#00ff80', sat: 66, val: 46, field: '#28764f', focused: false, invalid: false },
  lifetimes: { attached() { this.applyHex(this.properties.value); }, detached() { clearTimeout(this._changeTimer); } },
  methods: {
    applyHex(value) { const hex = colors.normalize(value); if (!hex) return; const hsv = colors.hexToHsv(hex); this._hsv = hsv; this.setData({ hex, field: hex, hue: hsv.h, hueColor: colors.hsvToHex(hsv.h, 1, 1), sat: hsv.s * 100, val: (1 - hsv.v) * 100 }); },
    commit(hsv) { const value = colors.hsvToHex(hsv.h, hsv.s, hsv.v); this._hsv = hsv; this.setData({ hex: value, field: value, hue: hsv.h, hueColor: colors.hsvToHex(hsv.h, 1, 1), sat: hsv.s * 100, val: (1 - hsv.v) * 100 }); this.emitChange(false); },
    emitChange(final) {
      clearTimeout(this._changeTimer);
      const elapsed = Date.now() - (this._lastChange || 0);
      if (final || elapsed >= 40) { this._lastChange = Date.now(); this.triggerEvent('change', { value: this.data.hex, final }); }
      else this._changeTimer = setTimeout(() => { this._lastChange = Date.now(); this.triggerEvent('change', { value: this.data.hex, final: false }); }, 40 - elapsed);
    },
    start(e) {
      if (!e.touches || e.touches.length !== 1) return;
      this._kind = e.currentTarget.dataset.kind;
      const touch = { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
      this._rect = null;
      this.createSelectorQuery().select(this._kind === 'hue' ? '.picker-hue' : '.picker-plane').boundingClientRect(rect => { if (rect && this._kind) { this._rect = rect; this.movePoint(touch); } }).exec();
    },
    move(e) { if (e.touches && e.touches.length === 1) this.movePoint(e.touches[0]); },
    end() { if (this._kind) this.emitChange(true); this._kind = null; this._rect = null; },
    movePoint(touch) {
      const r = this._rect; if (!r || !this._kind || !r.width || !r.height) return;
      let width = 375;
      try { const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync(); width = info.windowWidth || width; } catch (_) {}
      const inset = 20 * width / 750, clamp = n => Math.max(0, Math.min(1, n));
      const x = clamp((touch.clientX - r.left - inset) / Math.max(1, r.width - 2 * inset));
      const y = clamp((touch.clientY - r.top - inset) / Math.max(1, r.height - 2 * inset));
      this.commit(this._kind === 'hue' ? { ...this._hsv, h: Math.min(359.99, x * 360) } : { ...this._hsv, s: x, v: 1 - y });
    },
    input(e) { this.setData({ field: e.detail.value, invalid: false }); const value = inputColor(e.detail.value); if (value) { this.applyHex(value); this.emitChange(true); } },
    focus(e) { this.setData({ focused: true }); this.triggerEvent('keyboardfocus', { height: e.detail && e.detail.height || 0 }); },
    blur() { this.setData({ focused: false }); this.triggerEvent('keyboardblur'); const value = inputColor(this.data.field); if (value) { this.applyHex(value); this.emitChange(true); } else this.setData({ invalid: true }); }
  }
}));
