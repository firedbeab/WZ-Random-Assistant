// app.js
const { PROD_ENV_ID, runtimeInfo } = require('./utils/runtime');
const theme = require('./utils/theme');

App({
  onLaunch() {
    theme.start();
    // 初始化云开发环境
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    } else {
      wx.cloud.init({
        env: PROD_ENV_ID,
        traceUser: true,
      });
    }

    const runtime = runtimeInfo();
    this.globalData.runtime = runtime;
    this.globalData.isTestMode = runtime.isTestMode;
    console.info(`[运行环境] ${runtime.isTestMode ? 'TEST' : 'PRODUCTION'} / ${runtime.envVersion}`);

    // 隐私协议授权监听
    // 当隐私 API 被调用且用户尚未同意时触发
    if (wx.onNeedPrivacyAuthorization) {
      wx.onNeedPrivacyAuthorization((resolve) => {
        const pages = getCurrentPages();
        const currentPage = pages[pages.length - 1];

        // 优先使用页面上的隐私弹窗组件
        if (currentPage && currentPage.selectComponent) {
          const popup = currentPage.selectComponent('#privacyPopup');
          if (popup) {
            popup.show(resolve);
            return;
          }
        }

        // 回退方案：页面尚未加载或组件不可用时，使用原生弹窗
        // 这种情况通常发生在 app.js onLaunch 阶段
        wx.showModal({
          title: '隐私保护指引',
          content: '在使用本小程序前，请阅读并同意《隐私保护指引》。继续使用即表示你已同意。',
          confirmText: '同意',
          cancelText: '拒绝',
          success(res) {
            // 同意与拒绝都必须回调，否则隐私授权会一直处于 pending，相关接口后续直接挂住。
            resolve(res.confirm
              ? { buttonId: 'modal-agree', event: 'agree' }
              : { buttonId: 'modal-disagree', event: 'disagree' });
          },
          fail() {
            resolve({ event: 'disagree' });
          }
        });
      });
    }
  },

  onShow() { theme.refreshSystem(); },

  globalData: {
    systemInfo: null,
    userInfo: null,
    runtime: null,
    isTestMode: true
  }
});
