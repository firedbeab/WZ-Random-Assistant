const theme = require('../../utils/theme');
const { navigationLayout } = require('../../utils/navigation-layout');

Component(theme.component({
  properties: {
    title: { type: String, value: 'WZ随机助手' },
    back: { type: Boolean, value: false },
    parent: { type: String, value: '/pages/index/index' },
    variant: { type: String, value: 'closed' }
  },
  data: { ...navigationLayout(), canGoBack: false },
  lifetimes: { attached() { this.updateLayout(); } },
  pageLifetimes: {
    show() { this.updateLayout(); },
    resize() { this.updateLayout(); }
  },
  methods: {
    updateLayout() {
      let info = {}, capsule = {};
      try {
        info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
      } catch (_) { /* 使用保守的安全占位，不能让导航测量失败阻断页面。 */ }
      try { capsule = wx.getMenuButtonBoundingClientRect(); } catch (_) {}
      this.setData({
        ...navigationLayout(info, capsule),
        canGoBack: typeof getCurrentPages === 'function' && getCurrentPages().length > 1
      });
    },
    goBack() {
      const home = () => wx.reLaunch({ url: '/pages/index/index' });
      const parent = () => this.properties.parent && this.properties.parent !== '/pages/index/index'
        ? wx.redirectTo({ url: this.properties.parent, fail: home }) : home();
      if (typeof getCurrentPages === 'function' && getCurrentPages().length > 1) {
        wx.navigateBack({ delta: 1, fail: parent });
      } else parent();
    }
  }
}));
