// components/privacy-popup/privacy-popup.js

// 用模块级变量存储 resolve 回调函数
// 不能放在 data 里（函数会被序列化丢失）
// 不能放在 Component 顶层属性里（可能无法作为实例属性可靠访问）
let _resolveFn = null;

Component({
  data: {
    visible: false
  },

  methods: {
    /**
     * 外部调用：显示隐私弹窗
     * @param {Function} resolve - 微信隐私授权的回调，用户同意后调用以放行被拦截的 API
     */
    show(resolve) {
      _resolveFn = resolve;
      this.setData({ visible: true });
    },

    /**
     * 用户点击"同意"按钮后触发
     * 调用 resolve 回调，让被拦截的隐私 API 继续执行
     */
    onAgreePrivacy() {
      if (typeof _resolveFn === 'function') {
        _resolveFn({
          buttonId: 'agree-btn',
          event: 'agree'
        });
      }
      _resolveFn = null;
      this.setData({ visible: false });
    },

    /**
     * 打开完整隐私协议页面
     */
    openContract() {
      wx.openPrivacyContract({
        fail(err) {
          console.warn('打开隐私协议失败', err);
        }
      });
    },

    /**
     * 点击拒绝 - 仅关闭弹窗，不调用 resolve
     * 被拦截的隐私 API 将不会执行
     */
    onReject() {
      if (typeof _resolveFn === 'function') {
        _resolveFn({ event: 'disagree' });
      }
      _resolveFn = null;
      this.setData({ visible: false });
    }
  }
});
