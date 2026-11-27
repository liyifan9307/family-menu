// 云函数调用统一封装
// 地基红线：家庭数据不走 mock —— 云端失败就明确报错，不造假数据
const { ensureLogin, getCurrentFamilyId, getCachedMember, saveSession } = require('./auth')

async function call(name, data = {}) {
  const res = await wx.cloud.callFunction({ name, data })
  const result = res && res.result
  if (!result) throw new Error('云函数无返回')
  if (result.error) {
    const err = new Error(result.error.message || '操作失败')
    err.code = result.error.code
    throw err
  }
  return result
}

const api = {
  // 登录 / 家庭列表
  async login(forceRefresh = false) {
    return ensureLogin(forceRefresh)
  },
  async getFamilies() {
    const r = await call('familyService', { action: 'getFamilies' })
    // 刷新后同步缓存
    saveSession({ families: r.families })
    return r.families
  },
  // 入口动作（无 familyId 上下文）
  async createFamily(name, requestId) {
    return call('familyService', { action: 'createFamily', name, requestId })
  },
  async joinFamily(inviteCode) {
    return call('familyService', { action: 'joinFamily', inviteCode })
  },
  // 以下均已存在家庭上下文，familyId 默认取当前家庭，且云函数侧强制归属校验
  async getFamily(familyId) {
    return call('familyService', { action: 'getFamily', familyId: familyId || getCurrentFamilyId() })
  },
  async listMembers(familyId) {
    return call('familyService', { action: 'listMembers', familyId: familyId || getCurrentFamilyId() })
  },
  async removeMember(familyId, targetOpenid) {
    return call('familyService', { action: 'removeMember', familyId, targetOpenid })
  },
  renameFamily(familyId, name) {
    return call('familyService', { action: 'renameFamily', familyId, name })
  },
  transferAdmin(familyId, memberId) {
    return call('familyService', { action: 'transferAdmin', familyId, memberId })
  },
  async refreshInvite(familyId) {
    return call('familyService', { action: 'refreshInvite', familyId: familyId || getCurrentFamilyId() })
  },
  // V3.10 解散家庭：仅 admin 且仅剩自己时可解散（云端强校验），带 familyId
  async dissolveFamily(familyId) {
    return call('familyService', { action: 'dissolveFamily', familyId: familyId || getCurrentFamilyId() })
  },
  // —— V3.8 真头像 ——
  // 1) 选头像后拿到的临时路径上传云存储，换成持久 fileID（临时链接会过期，必须转存）
  // 2) 再把 fileID 写入 co_member（云函数按 openid 跨家庭共用）
  async uploadAvatar(tempFilePath) {
    if (!tempFilePath) throw new Error('没有选择头像')
    const cached = getCachedMember()
    const openid = (cached && cached.openid) || 'anon'
    const cloudPath = 'avatars/' + openid + '-' + Date.now() + '.png'
    const up = await wx.cloud.uploadFile({ cloudPath, filePath: tempFilePath })
    if (!up || !up.fileID) throw new Error('头像上传失败')
    return up.fileID
  },
  async updateAvatar(fileID) {
    return call('familyService', { action: 'updateAvatar', fileID })
  },
  // 一步到位：上传 + 落库
  async changeAvatar(tempFilePath) {
    const fileID = await this.uploadAvatar(tempFilePath)
    return this.updateAvatar(fileID)
  },
  // V3.9 昵称：走 checkText 预埋钩子 + 按 openid 跨家庭共用
  async updateProfile(nickName) {
    return call('familyService', { action: 'updateProfile', nickName })
  },
}

module.exports = api
