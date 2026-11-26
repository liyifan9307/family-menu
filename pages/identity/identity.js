// 身份引导页 —— 冷启动入口：创建家庭 / 加入家庭二选一
// 已归属用户 onShow 自动跳 home；全新/被移除用户留本页走创建或加入
const api = require('../../utils/api')
const auth = require('../../utils/auth')
const { LOGIN_STATUS } = require('../../utils/constants')

const app = getApp()

Page({
  data: {
    checking: true,      // 正在识别身份
    mode: 'choose',      // choose / create / join
    familyName: '',
    inviteCode: '',
    submitting: false,
    status: LOGIN_STATUS.UNKNOWN,
  },

  onLoad(options = {}) {
    this.explicitEntry = options.mode === 'create' || options.mode === 'join'
    if (this.explicitEntry) this.setData({ mode: options.mode })
  },

  async onShow() {
    await this.checkIdentity()
  },

  async checkIdentity() {
    this.setData({ checking: true })
    try {
      const result = await api.login()
      app.globalData.member = result.member
      app.globalData.families = result.families || []
      app.globalData.currentFamilyId = result.currentFamilyId
      app.globalData.loginStatus = result.status
      this.setData({ status: result.status })

      if (!this.explicitEntry && result.status === LOGIN_STATUS.OK && (result.families || []).length > 0) {
        // 已归属 → 直接进家庭首页
        wx.switchTab({ url: '/pages/home/home' })
        return
      }
      // unknown / removed → 留本页（removed 给个提示）
      if (result.status === LOGIN_STATUS.REMOVED) {
        wx.showToast({ title: '你已被移出家庭，可重新加入或创建', icon: 'none', duration: 2500 })
      }
    } catch (err) {
      console.error('[identity] 身份识别失败', err)
      wx.showToast({ title: '网络连接失败，请检查网络后重试', icon: 'none', duration: 2500 })
    } finally {
      this.setData({ checking: false })
    }
  },

  onFamilyNameInput(e) {
    this.setData({ familyName: e.detail.value })
  },
  onInviteCodeInput(e) {
    this.setData({ inviteCode: e.detail.value })
  },

  showCreate() { this.setData({ mode: 'create' }) },
  showJoin() { this.setData({ mode: 'join' }) },
  backToChoose() { this.setData({ mode: 'choose', familyName: '', inviteCode: '' }) },

  async doCreate() {
    const name = (this.data.familyName || '').trim()
    if (!name) {
      wx.showToast({ title: '请填写家庭名称', icon: 'none' })
      return
    }
    if (this.data.submitting) return
    this.setData({ submitting: true })
    wx.showLoading({ title: '创建中' })
    let succeeded = false
    try {
      const r = await api.createFamily(name)
      // 关键：全量重拉家庭列表，不能手动拼数组——否则会覆盖掉用户已加入的其他家庭（一人多家庭）
      const families = await api.getFamilies()
      // 写入会话 + 全局上下文
      auth.saveSession({
        member: r.member,
        families,
        currentFamilyId: r.familyId,
        status: LOGIN_STATUS.OK,
      })
      app.globalData.member = r.member
      app.globalData.families = auth.getFamilies()
      app.globalData.currentFamilyId = r.familyId
      app.globalData.loginStatus = LOGIN_STATUS.OK
      succeeded = true // 成功后保持 submitting 锁定，防止 600ms 跳转窗口内重复创建
      wx.hideLoading()
      wx.showToast({ title: '家庭创建成功', icon: 'success' })
      setTimeout(() => wx.switchTab({
        url: '/pages/home/home',
        fail: () => this.setData({ submitting: false }), // 跳转失败则解锁，允许重试
      }), 600)
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '创建失败', icon: 'none', duration: 2500 })
    } finally {
      // 只在失败时解锁；成功时保持锁定直到跳转（跳转失败由 fail 回调解锁）
      if (!succeeded) this.setData({ submitting: false })
    }
  },

  async doJoin() {
    const code = (this.data.inviteCode || '').trim()
    if (!code) {
      wx.showToast({ title: '请输入邀请码', icon: 'none' })
      return
    }
    if (this.data.submitting) return
    this.setData({ submitting: true })
    wx.showLoading({ title: '加入中' })
    let succeeded = false
    try {
      const r = await api.joinFamily(code)
      const families = await api.getFamilies()
      auth.saveSession({
        member: r.member,
        families,
        currentFamilyId: r.familyId,
        status: LOGIN_STATUS.OK,
      })
      app.globalData.member = r.member
      app.globalData.families = families
      app.globalData.currentFamilyId = r.familyId
      app.globalData.loginStatus = LOGIN_STATUS.OK
      succeeded = true // 成功后保持 submitting 锁定，防止 600ms 跳转窗口内重复加入
      wx.hideLoading()
      wx.showToast({ title: '加入成功', icon: 'success' })
      setTimeout(() => wx.switchTab({
        url: '/pages/home/home',
        fail: () => this.setData({ submitting: false }), // 跳转失败则解锁，允许重试
      }), 600)
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '加入失败', icon: 'none', duration: 2500 })
    } finally {
      if (!succeeded) this.setData({ submitting: false })
    }
  },
})
