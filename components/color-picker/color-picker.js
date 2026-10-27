const theme = require('../../utils/theme');
const colors = require('../../utils/color-palette');
Component(theme.component({
  properties: { value: { type: String, value: '#28764f', observer(value) { if (colors.normalize(value) && value !== this.data.hex) this.applyHex(value); } } },
  data: { hex: '#28764f', hue: 150, hueColor: '#00ff80', sat: 66, val: 46, field: '#28764f' },
  lifetimes: { attached() { this.applyHex(this.properties.value); } },
  methods: {
    applyHex(value) { const hex = colors.normalize(value); if (!hex) return; const hsv = colors.hexToHsv(hex); this._hsv = hsv; this.setData({ hex, field: hex, hue: hsv.h, hueColor: colors.hsvToHex(hsv.h, 1, 1), sat: hsv.s * 100, val: (1 - hsv.v) * 100 }); },
    commit(hsv) { const value = colors.hsvToHex(hsv.h, hsv.s, hsv.v); this._hsv = hsv; this.setData({ hex: value, field: value, hue: hsv.h, hueColor: colors.hsvToHex(hsv.h, 1, 1), sat: hsv.s * 100, val: (1 - hsv.v) * 100 }); this.triggerEvent('change', { value }); },
    start(e) {
      if (!e.touches || e.touches.length !== 1) return;
      this._kind = e.currentTarget.dataset.kind;
      const touch = { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
      this._rect = null;
      this.createSelectorQuery().select(this._kind === 'hue' ? '.picker-hue' : '.picker-plane').boundingClientRect(rect => { if (rect && this._kind) { this._rect = rect; this.movePoint(touch); } }).exec();
    },
    move(e) { if (e.touches && e.touches.length === 1) this.movePoint(e.touches[0]); },
    end() { this._kind = null; this._rect = null; },
    movePoint(touch) { const r = this._rect; if (!r || !this._kind || !r.width || !r.height) return; const x = Math.max(0, Math.min(1, (touch.clientX - r.left) / r.width)), y = Math.max(0, Math.min(1, (touch.clientY - r.top) / r.height)); this.commit(this._kind === 'hue' ? { ...this._hsv, h: Math.min(359.99, x * 360) } : { ...this._hsv, s: x, v: 1 - y }); },
    input(e) { this.setData({ field: e.detail.value }); },
    blur() { const value = colors.normalize(this.data.field); if (value) { this.applyHex(value); this.triggerEvent('change', { value }); } else this.setData({ field: this.data.hex }); },
    hueChange(e) { this.commit({ ...this._hsv, h: Number(e.detail.value) }); }
  }
}));
