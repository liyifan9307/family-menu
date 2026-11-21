// 小程序入口 —— 地基阶段：只负责初始化云环境与全局上下文
// 身份分流交给首页 identity 的 onShow 处理（时机更稳，避免 onLaunch 异步回调）
const { LOGIN_STATUS } = require('./utils/constants')

App({
  globalData: {
    member: null,
    families: [],
    currentFamilyId: null,
    loginStatus: LOGIN_STATUS.UNKNOWN,
    // 取当前家庭统一用 utils/auth.js 的 getCurrentFamilyId()（读缓存），此处不重复定义方法
  },

  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({ title: '基础库过低', content: '请升级微信到最新版本', showCancel: false })
      return
    }
    wx.cloud.init({ env: wx.cloud.DYNAMIC_CURRENT_ENV, traceUser: true })
  },

  // 兜底：推倒重建后旧的启动路径 / 旧扫码 path 可能指向已删除页面
  // 任何 404 都弹回首页，避免用户卡在"页面不存在"（res.path 不带前导斜杠）
  onPageNotFound(res) {
    const home = '/pages/identity/identity'
    console.warn('[app] 页面不存在，兜回首页:', res && res.path)
    // 首页本身若异常则不跳，避免死循环
    if (res && res.path && ('/' + res.path) === home) return
    wx.reLaunch({ url: home })
  },
})
