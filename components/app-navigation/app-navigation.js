const { navigationLayout } = require('../../utils/navigation-layout');

Component({
  properties: {
    title: { type: String, value: 'WZ随机助手' },
    back: { type: Boolean, value: false },
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
      if (typeof getCurrentPages === 'function' && getCurrentPages().length > 1) {
        wx.navigateBack({ delta: 1, fail: home });
      } else home();
    }
  }
});
