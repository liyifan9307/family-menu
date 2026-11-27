// 身份引导页 —— 冷启动入口：创建家庭 / 加入家庭二选一
// 已归属用户 onShow 自动跳 home；全新/被移除用户留本页走创建或加入
const api = require('../../utils/api')
const auth = require('../../utils/auth')
const { LOGIN_STATUS } = require('../../utils/constants')
const { requestId } = require('../../utils/schedule')

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

  doCreate() {
    return this.submitFamily('create', (this.data.familyName || '').trim())
  },

  doJoin() {
    return this.submitFamily('join', (this.data.inviteCode || '').trim().toUpperCase())
  },

  async submitFamily(mode, value) {
    const creating = mode === 'create'
    if (!value) {
      wx.showToast({ title: creating ? '请填写家庭名称' : '请输入邀请码', icon: 'none' })
      return
    }
    if (this.data.submitting) return
    this.setData({ submitting: true })

    // 微信跳转失败时，保留已经完成的操作，下一次点击只重试进入首页。
    const completed = this.completedSubmission
    if (completed && completed.mode === mode && completed.value === value) {
      this.enterHome()
      return
    }

    wx.showLoading({ title: creating ? '创建中' : '加入中' })
    let result
    let failure
    try {
      if (creating) {
        if (!this.createRequest || this.createRequest.name !== value) {
          this.createRequest = { name: value, id: requestId() }
        }
        result = await api.createFamily(value, this.createRequest.id)
      } else {
        result = await api.joinFamily(value)
      }
    } catch (error) {
      failure = error
    } finally {
      wx.hideLoading()
    }

    if (failure) {
      this.setData({ submitting: false })
      wx.showToast({
        title: failure.message || (creating ? '创建失败' : '加入失败'),
        icon: 'none',
        duration: 2500,
      })
      return
    }

    // 云端已确认结果。先合并到已有会话，由首页独立重拉完整家庭列表。
    this.completedSubmission = { mode, value }
    if (creating) this.createRequest = null
    const member = result.member
    const previousFamilies = auth.getFamilies()
    const existing = previousFamilies.find(family => family.familyId === result.familyId)
    const current = {
      ...existing,
      familyId: result.familyId,
      name: result.familyName || (existing && existing.name) || (creating ? value : '我的家'),
      role: member.role,
      color: member.color,
    }
    const families = previousFamilies.filter(family => family.familyId !== result.familyId).concat(current)
    auth.saveSession({ member, families, currentFamilyId: result.familyId, status: LOGIN_STATUS.OK })
    Object.assign(app.globalData, {
      member, families, currentFamilyId: result.familyId, loginStatus: LOGIN_STATUS.OK,
    })
    wx.showToast({ title: creating ? '家庭创建成功' : '加入成功', icon: 'success' })
    this.enterHome()
  },

  enterHome() {
    setTimeout(() => wx.switchTab({
      url: '/pages/home/home',
      fail: () => this.setData({ submitting: false }),
    }), 600)
  },
})
