// 我的：个人资料、家庭切换与成员管理
const api = require('../../utils/api')
const auth = require('../../utils/auth')
const { MEMBER_EMOJIS, MEMBER_COLORS, LOGIN_STATUS } = require('../../utils/constants')

const app = getApp()


Page({
  data: {
    loading: true,
    error: '',
    panel: '',
    me: null,
    previewMembers: [],
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
    if (this.data.showProfile || this.data.panel) wx.hideTabBar({ animation: false })
  },

  async reload() {
    this.setData({ loading: true, error: '', family: null, members: [], me: null, previewMembers: [] })
    try {
      const session = await api.login(true)
      const families = session.families || []
      const currentFamilyId = session.currentFamilyId
      if (!families.length || !currentFamilyId) {
        this.setData({ showProfile: false, showSwitcher: false, panel: '' })
        wx.showTabBar({ animation: false })
        wx.reLaunch({ url: '/pages/identity/identity' })
        return
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

      app.globalData.member = session.member
      app.globalData.families = families
      app.globalData.currentFamilyId = currentFamilyId
      app.globalData.loginStatus = LOGIN_STATUS.OK

      this.setData({
        loading: false,
        families,
        family: familyRes.family,
        renameAvailableLabel: this.getRenameAvailableLabel(familyRes.family),
        members,
        me: members.find(m => m.isMe) || null,
        previewMembers: members.slice(0, 4),
        currentFamilyId,
        isAdmin,
        myOpenid,
        otherMemberCount: members.filter(m => !m.isMe).length,  // V3.10：有其他成员则不允许解散
      })
    } catch (err) {
      this.setData({ loading: false, error: err.message || '加载失败，请稍后重试' })
      console.error('[my] 加载失败', err)
    } finally {
      this.setData({ loading: false })
    }
  },

  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh())
  },

  onHide() {
    this.setData({ showSwitcher: false, panel: '' })
    wx.showTabBar({ animation: false })
  },
  closeSwitcher() {
    this.setData({ showSwitcher: false })
    if (!this.data.panel && !this.data.showProfile) wx.showTabBar({ animation: false })
  },
  openPanel(e) {
    const panel = e.currentTarget.dataset.panel
    if (!['members', 'invite', 'settings', 'transfer'].includes(panel)) return
    this.setData({ panel, inviteVisible: false })
    wx.hideTabBar({ animation: false })
  },
  getRenameAvailableLabel(family) {
    const next = family && family.nextRenameAt
    return next > Date.now() ? new Date(next + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : ''
  },
  async renameFamily() {
    if (!this.data.isAdmin || this.settingBusy) return
    const { currentFamilyId, family } = this.data
    if (!family) return
    const available = this.getRenameAvailableLabel(family)
    this.setData({ renameAvailableLabel: available })
    if (available) {
      wx.showModal({ title: '暂不能修改家庭名称', content: '下次可修改时间为 ' + available + '（北京时间）', showCancel: false })
      return
    }
    await this.confirmSetting({
      title: '修改家庭名称', editable: true, content: family.name, placeholderText: '输入 1 到 20 个字', confirmText: '保存',
    }, async result => {
      const name = (result.content || '').trim()
      if (!name || name.length > 20) throw new Error('家庭名称须为 1 到 20 个字')
      await api.renameFamily(currentFamilyId, name)
    }, '家庭名称已更新')
  },
  async transferAdmin(e) {
    if (!this.data.isAdmin || this.settingBusy) return
    const { currentFamilyId, members } = this.data
    const target = members.find(m => m._id === e.currentTarget.dataset.id && !m.isMe)
    if (!target) return
    await this.confirmSetting({
      title: '移交管理员', content: '确认将管理员移交给「' + target.displayLabel + '」？对方将接管家庭设置和解散权限，你将成为普通成员。', confirmText: '确认移交',
    }, () => api.transferAdmin(currentFamilyId, target._id), '管理员已移交')
  },
  async confirmSetting(options, save, successTitle) {
    this.settingBusy = true
    try {
      const result = await new Promise((resolve, reject) => wx.showModal({ ...options, success: resolve, fail: reject }))
      if (!result.confirm) return
      await save(result)
      this.setData({ panel: 'settings' })
      wx.showToast({ title: successTitle, icon: 'success' })
      await this.reload()
    } catch (err) {
      wx.showToast({ title: err.message || '操作失败，请重试', icon: 'none' })
    } finally {
      this.settingBusy = false
    }
  },
  closePanel() {
    if (this.data.dissolving) return
    this.setData({ panel: '' })
    wx.showTabBar({ animation: false })
  },
  toggleSwitcher() {
    if (this.data.showSwitcher) {
      this.closeSwitcher()
      return
    }
    wx.hideTabBar({ animation: false })
    this.setData({ showSwitcher: true })
  },

  async switchFamily(e) {
    const familyId = e.detail.familyId
    if (!familyId || familyId === this.data.currentFamilyId) {
      this.closeSwitcher()
      return
    }
    if (!this.data.families.some(f => f.familyId === familyId)) return
    this.setData({ panel: '', inviteVisible: false })
    auth.setCurrentFamily(familyId)   // 只切本地指针
    app.globalData.currentFamilyId = familyId
    this.closeSwitcher()
    this.setData({ loading: true })
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
        content: '确定移除「' + name + '」吗？移除后旧邀请码和日程分享链接会失效。对方需要新邀请码才能重新加入。',
        confirmColor: '#c0392b',
        success: resolve,
      })
    })
    if (!res.confirm) return
    wx.showLoading({ title: '处理中' })
    try {
      await api.removeMember(this.data.currentFamilyId, targetOpenid)
      wx.hideLoading()
      wx.showToast({ title: '已移除，邀请码已更新', icon: 'success' })
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
        content: '确定解散「' + familyName + '」吗？家庭、成员关系、邀请码和日程将被永久删除，无法恢复。',
        confirmText: '确认解散',
        confirmColor: '#c0392b',
        success: resolve,
      })
    })
    if (!res.confirm || this.data.dissolving) return
    this.setData({ dissolving: true })
    wx.showLoading({ title: '解散中' })
    let result, failure
    try {
      result = await api.dissolveFamily(this.data.currentFamilyId)
    } catch (err) {
      failure = err
    } finally {
      wx.hideLoading()
      this.setData({ dissolving: false })
    }

    if (failure) {
      console.error('[my] 解散家庭失败', failure)
      wx.showToast({ title: failure.message || '解散失败', icon: 'none', duration: 2500 })
      return
    }
    this.setData({ panel: '', family: null, members: [], previewMembers: [] })
    wx.showTabBar({ animation: false })
    if (result.processing) {
      wx.showToast({ title: '家庭已关闭，数据正在后台清理', icon: 'none', duration: 2500 })
    } else {
      wx.showToast({ title: '家庭已解散', icon: 'success' })
    }
    // 重新识别可用家庭，避免旧家庭仍被选中。
    await this.reload()
  },

  // ——— V3.9 编辑我的资料（头像 + 昵称一起填，浮层内本地暂存、保存时一起提交）———
  openProfile() {
    wx.hideTabBar({ animation: false })
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
    wx.showTabBar({ animation: false })
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
      wx.showTabBar({ animation: false })
      wx.showToast({ title: '资料已保存', icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      this.setData({ profileSaving: false })
      console.error('[home] 资料保存失败', err)
      wx.showToast({ title: err.message || '保存失败', icon: 'none', duration: 2500 })
    }
  },
})
