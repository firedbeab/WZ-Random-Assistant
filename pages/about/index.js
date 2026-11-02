const { APP_VERSION } = require('../../utils/version');
const feedback = require('../../utils/admin-feedback');
const theme = require('../../utils/theme');
Page(theme.page(feedback.notifications({
  data: { appVersion: APP_VERSION,},

  goHelp() {
    wx.navigateTo({ url: '/pages/help/index' });
  },

  // 跳转管理员登录
  goAdminLogin() {
    wx.navigateTo({ url: '/pages/admin/login' });
  },

  goFeedback() { wx.navigateTo({ url: '/pages/feedback/index' }); },
  goChangelog() { wx.navigateTo({ url: '/pages/changelog/index' }); },

  // 查看隐私保护指引
  openPrivacy() {
    wx.openPrivacyContract({
      fail: () => {
        feedback.showToast(this, { title: '暂无隐私协议', icon: 'none' });
      }
    });
  }
})));
