// 家庭首页 —— 地基阶段验收页：当前家庭 / 成员列表 / 邀请码 / 家庭切换
// 点菜等功能第 2 步重建后在此接入
const api = require('../../utils/api')
const auth = require('../../utils/auth')
const { MEMBER_EMOJIS, MEMBER_COLORS, LOGIN_STATUS } = require('../../utils/constants')

const app = getApp()
const APP_KEYS = ['fm_member', 'fm_families', 'fm_current_family', 'fm_login_status']

Page({
  data: {
    loading: true,
    families: [],
    family: null,       // { familyId, name, inviteCode, inviteExpireAt }
    members: [],
    currentFamilyId: null,
    isAdmin: false,
    myOpenid: null,
    showSwitcher: false,
    inviteVisible: false, // 邀请码默认折叠，点开才显示
    // V3.9 编辑我的资料（头像 + 昵称浮层）
    showProfile: false,
    draftAvatarUrl: '',   // 浮层内头像预览（选完是本地临时路径，保存时才上传）
    pendingAvatarPath: '',// 待上传的本地临时路径，空表示未改头像
    draftNickName: '',
    profileSaving: false,
    // V3.10 解散家庭
    dissolving: false,
    otherMemberCount: 0,   // 除自己外的 active 成员数，>0 时前端拦截解散并提示先移除
  },

  async onShow() {
    await this.reload()
  },

  async reload() {
    this.setData({ loading: true })
    try {
      // 先确保身份缓存就绪（首次可能还没登录）
      let families = auth.getFamilies()
      let currentFamilyId = auth.getCurrentFamilyId()
      if (!families.length || !currentFamilyId) {
        await api.login()
        families = auth.getFamilies()
        currentFamilyId = auth.getCurrentFamilyId()
      }
      if (!families.length || !currentFamilyId) {
        wx.redirectTo({ url: '/pages/identity/identity' })
        return
      }
      // 进页拉云端最新家庭列表：别只用缓存，否则家庭改名/新增后切换器显示旧名
      // 失败时用缓存兜底，不阻断页面（沿用"进页刷新、无实时通道"口径）
      try {
        families = await api.getFamilies()
        if (families.length && !families.some(f => f.familyId === currentFamilyId)) {
          // 当前家庭已被移除 → 切到第一个有效家庭
          currentFamilyId = families[0].familyId
          auth.setCurrentFamily(currentFamilyId)
        }
      } catch (e) {
        console.warn('[home] 家庭列表刷新失败，使用缓存', e)
      }

      // getFamily 云函数已返回 members，不再单独调 listMembers（省一次云函数调用 + 数据库往返）
      const familyRes = await api.getFamily(currentFamilyId)
      const allMembers = familyRes.members || []
      // 只读一次缓存，避免重复调用 getCachedMember
      const cachedMember = auth.getCachedMember()
      const myOpenid = cachedMember && cachedMember.openid
      const me = allMembers.find(m => m.openid === myOpenid)
      const isAdmin = !!(me && me.role === 'admin')

      // 给成员补展示用的固定色 emoji（云函数已带 avatarEmoji，前端兜底）
      // V3.9：昵称来自 co_member.nickName，未设置兜底"家人"；移除确认框用真昵称辨识
      const members = allMembers.map(m => {
        const idx = Math.max(0, MEMBER_COLORS.indexOf(m.color))
        const emoji = m.avatarEmoji || MEMBER_EMOJIS[idx % MEMBER_EMOJIS.length]
        const nm = m.nickName || m.name || '家人'
        return Object.assign({}, m, {
          avatarEmoji: emoji,
          name: nm,
          isMe: m.openid === myOpenid,
          // 有真昵称就用昵称，否则用"emoji + 角色"兜底区分
          displayLabel: (m.nickName ? nm : emoji + ' ' + (m.role === 'admin' ? '管理员' : '成员')),
        })
      })

      app.globalData.families = families
      app.globalData.currentFamilyId = currentFamilyId
      app.globalData.loginStatus = LOGIN_STATUS.OK

      this.setData({
        loading: false,
        families,
        family: familyRes.family,
        members,
        currentFamilyId,
        isAdmin,
        myOpenid,
        otherMemberCount: members.filter(m => !m.isMe).length,  // V3.10：有其他成员则不允许解散
      })
    } catch (err) {
      this.setData({ loading: false })
      console.error('[home] 加载失败', err)
      wx.showToast({ title: err.message || '加载失败，请检查网络', icon: 'none', duration: 2500 })
    }
  },

  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh())
  },

  toggleSwitcher() {
    this.setData({ showSwitcher: !this.data.showSwitcher })
  },

  async switchFamily(e) {
    const familyId = e.currentTarget.dataset.id
    if (!familyId || familyId === this.data.currentFamilyId) {
      this.setData({ showSwitcher: false })
      return
    }
    auth.setCurrentFamily(familyId)   // 只切本地指针
    app.globalData.currentFamilyId = familyId
    this.setData({ showSwitcher: false, loading: true })
    await this.reload()               // 按新 familyId 全量重拉，无旧家庭残留
  },

  toggleInvite() {
    this.setData({ inviteVisible: !this.data.inviteVisible })
  },

  async refreshInvite() {
    if (!this.data.isAdmin) return
    wx.showLoading({ title: '刷新中' })
    try {
      const r = await api.refreshInvite(this.data.currentFamilyId)
      await this.reload()
      wx.hideLoading()
      wx.showToast({ title: '邀请码已刷新，旧码失效', icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '刷新失败', icon: 'none' })
    }
  },

  copyInvite() {
    const code = this.data.family && this.data.family.inviteCode
    if (!code) return
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'success' }),
    })
  },

  async removeMember(e) {
    if (!this.data.isAdmin) return
    const target = e.currentTarget.dataset
    const targetOpenid = target.openid
    const name = target.name || '该成员'
    const res = await new Promise(resolve => {
      wx.showModal({
        title: '移除成员',
        content: '确定移除「' + name + '」吗？移除后其将无法看到本家庭数据（不影响其加入的其他家庭）。',
        confirmColor: '#c0392b',
        success: resolve,
      })
    })
    if (!res.confirm) return
    wx.showLoading({ title: '处理中' })
    try {
      await api.removeMember(this.data.currentFamilyId, targetOpenid)
      wx.hideLoading()
      wx.showToast({ title: '已移除', icon: 'success' })
      await this.reload()
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '移除失败', icon: 'none' })
    }
  },

  // ——— V3.10 解散家庭（仅 admin 且仅剩自己时可解散）———
  async dissolveFamily() {
    if (!this.data.isAdmin || this.data.dissolving) return
    // 前端软拦截：有其他成员先提示移除（与云端强校验一致，体验更早反馈）
    if (this.data.otherMemberCount > 0) {
      wx.showToast({
        title: '请先移除其他 ' + this.data.otherMemberCount + ' 位成员',
        icon: 'none',
        duration: 2500,
      })
      return
    }
    const familyName = (this.data.family && this.data.family.name) || '该家庭'
    const res = await new Promise(resolve => {
      wx.showModal({
        title: '解散家庭',
        content: '确定解散「' + familyName + '」吗？家庭、邀请码和成员关系将被永久删除，无法恢复。',
        confirmText: '确认解散',
        confirmColor: '#c0392b',
        success: resolve,
      })
    })
    if (!res.confirm) return
    this.setData({ dissolving: true })
    wx.showLoading({ title: '解散中' })
    try {
      await api.dissolveFamily(this.data.currentFamilyId)
      // 关键：解散后本地缓存仍指向已删家庭，必须强制重登覆盖缓存
      // （有新家庭→云端返回并自动选第一个；无家庭→status=unknown、currentFamilyId=null）
      await api.login(true)
      wx.hideLoading()
      wx.showToast({ title: '家庭已解散', icon: 'success' })
      // reload 内部会按最新 families 自动跳引导页或显示其他家庭
      await this.reload()
      this.setData({ dissolving: false })
    } catch (err) {
      wx.hideLoading()
      this.setData({ dissolving: false })
      console.error('[home] 解散家庭失败', err)
      wx.showToast({ title: err.message || '解散失败', icon: 'none', duration: 2500 })
    }
  },

  // 第 2 步点菜重建后的入口占位；现在提示功能在建设中
  gotoDish() {
    wx.showToast({ title: '点菜功能将在下一步接入', icon: 'none' })
  },

  // ——— V3.9 编辑我的资料（头像 + 昵称一起填，浮层内本地暂存、保存时一起提交）———
  openProfile() {
    const me = (this.data.members || []).find(m => m.isMe)
    this.setData({
      showProfile: true,
      draftAvatarUrl: (me && me.avatarUrl) || '',
      pendingAvatarPath: '',
      draftNickName: (me && me.nickName) || '',
      profileSaving: false,
    })
  },

  closeProfile() {
    if (this.data.profileSaving) return // 保存中不允许关闭，避免中途状态错乱
    this.setData({ showProfile: false })
  },

  // 浮层内部点击拦截：防止冒泡到遮罩导致误关闭
  noop() {},

  // 浮层内选头像：只本地预览，不立即上传（等点保存时和昵称一起提交）
  onDraftAvatar(e) {
    const avatarUrl = e && e.detail && e.detail.avatarUrl
    if (!avatarUrl) return
    this.setData({ draftAvatarUrl: avatarUrl, pendingAvatarPath: avatarUrl })
  },

  // 昵称输入：input type="nickname" 用户点输入框可一键填微信昵称，也可手动改
  onNickInput(e) {
    this.setData({ draftNickName: (e && e.detail && e.detail.value) || '' })
  },

  async saveProfile() {
    if (this.data.profileSaving) return
    const nickName = (this.data.draftNickName || '').trim()
    const pendingAvatar = this.data.pendingAvatarPath
    if (!nickName && !pendingAvatar) {
      wx.showToast({ title: '没有改动', icon: 'none' })
      return
    }
    this.setData({ profileSaving: true })
    wx.showLoading({ title: '保存中' })
    try {
      // 头像：本地临时路径上传云存储 + 落库（有改动才做）
      if (pendingAvatar) await api.changeAvatar(pendingAvatar)
      // 昵称：走 checkText 预埋 + 按 openid 跨家庭共用（有改动才做）
      if (nickName) await api.updateProfile(nickName)
      // 刷新本地 member 缓存 + 成员列表，头像昵称立即生效、跨家庭一致
      await api.login(true).catch(() => {})
      await this.reload()
      wx.hideLoading()
      this.setData({ showProfile: false, profileSaving: false })
      wx.showToast({ title: '资料已保存', icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      this.setData({ profileSaving: false })
      console.error('[home] 资料保存失败', err)
      wx.showToast({ title: err.message || '保存失败', icon: 'none', duration: 2500 })
    }
  },
})
