Page({
  data: {},

  goHelp() {
    wx.navigateTo({ url: '/pages/help/index' });
  },

  // 跳转管理员登录
  goAdminLogin() {
    wx.navigateTo({ url: '/pages/admin/login' });
  },

  // 意见反馈
  goFeedback() {
    wx.showModal({
      title: '意见反馈',
      content: '点击"复制"获取反馈链接，在浏览器中打开即可',
      confirmText: '复制链接',
      success: (res) => {
        if (res.confirm) {
          wx.setClipboardData({
            data: 'https://wj.qq.com/s2/26857193/13fa/',
            success: () => {
              wx.showToast({ title: '链接已复制', icon: 'success' });
            }
          });
        }
      }
    });
  },

  // 查看隐私保护指引
  openPrivacy() {
    wx.openPrivacyContract({
      fail() {
        wx.showToast({ title: '暂无隐私协议', icon: 'none' });
      }
    });
  }
});
