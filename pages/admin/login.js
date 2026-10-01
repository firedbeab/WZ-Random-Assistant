Page({
  data: {
    adminCode: '',
    showCode: false,
    loading: false
  },

  async onLoad() {
    // 换设备后本地缓存不存在，但同一微信号的云端角色仍然有效。
    // 已是管理员的用户自动恢复本机标记并进入后台，无需重复输入通行码。
    this.setData({ loading: true });
    try {
      const res = await wx.cloud.callFunction({ name: 'getUserInfo' });
      if (res.result && res.result.success) {
        const userInfo = res.result.data;
        const role = userInfo.role;
        if (role === 'admin' || role === 'superadmin') {
          getApp().globalData.userInfo = userInfo;
          this.saveAdminAuth(role);
          wx.redirectTo({ url: '/pages/admin/admin' });
          return;
        }
      }
    } catch (err) {
      console.warn('管理员身份恢复失败');
    } finally {
      this.setData({ loading: false });
    }
  },

  saveAdminAuth(role) {
    wx.setStorageSync('admin_auth', {
      isAdmin: true,
      isSuperAdmin: role === 'superadmin',
      role
    });
  },

  onCodeInput(e) { this.setData({ adminCode: e.detail.value }); },
  toggleShow() { this.setData({ showCode: !this.data.showCode }); },

  async handleVerify() {
    const { adminCode } = this.data;
    if (!adminCode.trim()) return wx.showToast({ title: '请输入通行码', icon: 'none' });

    this.setData({ loading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'verifyAdmin',
        data: { action: 'verify', adminCode: adminCode.trim() }
      });

      if (res.result.success) {
        const role = res.result.role || 'admin';
        const isSuperAdmin = role === 'superadmin';

        // 保存本地兼容标记；实际权限仍由云端 users.role 决定
        this.saveAdminAuth(role);

        // 同步更新全局用户数据
        const app = getApp();
        if (app.globalData.userInfo) {
          app.globalData.userInfo.role = role;
        }

        wx.showToast({ title: isSuperAdmin ? '超管验证成功' : '验证成功', icon: 'success' });
        setTimeout(() => {
          wx.redirectTo({ url: '/pages/admin/admin' });
        }, 1000);
      } else {
        wx.showToast({ title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      wx.showToast({ title: '网络异常', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  }
});
