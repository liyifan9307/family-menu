// 登录态与多家庭身份缓存
// 保持向后兼容：getCachedMember() 读 member 基础字段的写法不变（第 2 步点菜重建时复用）
const { STORAGE_KEYS, LOGIN_STATUS } = require('./constants')

function read(key, fallback) {
  const v = wx.getStorageSync(key)
  return v === '' || v === undefined || v === null ? fallback : v
}

function write(key, value) {
  wx.setStorageSync(key, value)
}

// 静默登录：调 login 云函数拿 openid 身份 + 家庭列表，写入缓存
// 返回 res.result 原始结构（member / families / currentFamilyId / status）
async function ensureLogin(forceRefresh = false) {
  const cached = getCachedMember()
  if (cached && !forceRefresh) {
    // 已有缓存：结构里带上家庭信息直接返回，避免每次开屏都调云函数
    return {
      member: cached,
      families: getFamilies(),
      currentFamilyId: getCurrentFamilyId(),
      status: read(STORAGE_KEYS.LOGIN_STATUS, LOGIN_STATUS.UNKNOWN),
      fromCache: true,
    }
  }
  const res = await wx.cloud.callFunction({
    name: 'login',
    data: { currentFamilyId: getCurrentFamilyId() },
  })
  const result = res && res.result
  if (!result || result.error) {
    const code = result && result.error
    const ERR_MSG = {
      NO_OPENID: '无法识别微信身份，请稍后重试',
      SERVER_ERROR: '服务暂时不可用，请稍后重试',
    }
    throw new Error(ERR_MSG[code] || '登录失败，请检查网络后重试')
  }
  saveSession(result)
  return result
}

function saveSession(result) {
  if (result.member) write(STORAGE_KEYS.MEMBER, result.member)
  if (Array.isArray(result.families)) write(STORAGE_KEYS.FAMILIES, result.families)
  // 关键：区分"字段没传"（部分更新，如 getFamilies）与"显式传 null"（被移除，须清旧值）
  // 只传 families 时不能误删 currentFamilyId，否则当前家庭指针丢失
  if (Object.prototype.hasOwnProperty.call(result, 'currentFamilyId')) {
    if (result.currentFamilyId) write(STORAGE_KEYS.CURRENT_FAMILY, result.currentFamilyId)
    else wx.removeStorageSync(STORAGE_KEYS.CURRENT_FAMILY)
  }
  if (result.status) write(STORAGE_KEYS.LOGIN_STATUS, result.status)
}

// 兼容旧调用：点菜页读 res.result.member 的写法保持不变
function getCachedMember() {
  return read(STORAGE_KEYS.MEMBER, null)
}

function getFamilies() {
  return read(STORAGE_KEYS.FAMILIES, [])
}

function getCurrentFamilyId() {
  return read(STORAGE_KEYS.CURRENT_FAMILY, null)
}

// 切换当前家庭：写缓存，数据由各页面 onShow 按新 familyId 重拉
function setCurrentFamily(familyId) {
  write(STORAGE_KEYS.CURRENT_FAMILY, familyId)
}

function getLoginStatus() {
  return read(STORAGE_KEYS.LOGIN_STATUS, LOGIN_STATUS.UNKNOWN)
}

// 预留：第 2 步"退出登录/切换微信号"入口调用，当前地基阶段无入口，故暂未使用
function clearLogin() {
  Object.keys(STORAGE_KEYS).forEach(k => wx.removeStorageSync(STORAGE_KEYS[k]))
}

module.exports = {
  ensureLogin,
  saveSession,
  getCachedMember,
  getFamilies,
  getCurrentFamilyId,
  setCurrentFamily,
  getLoginStatus,
  clearLogin,
}
