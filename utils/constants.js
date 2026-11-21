// 全局常量 —— 地基阶段：身份体系固定色板与状态
// 对齐 UI 稿 V3.6 / 需求基准 V3.8 / 技术设计 v2.1 §2.2

// 雾感五色板（系统按加入顺序分配，co_member.color 是唯一色源）
const MEMBER_COLORS = ['#6b90b8', '#c48494', '#d0a15e', '#7a9e7e', '#9a86a8']
const MEMBER_EMOJIS = ['🧑', '👩', '👨', '🧒', '👵']

// 登录状态：ok=有家庭 / unknown=全新 / removed=全被移除
const LOGIN_STATUS = {
  OK: 'ok',
  UNKNOWN: 'unknown',
  REMOVED: 'removed',
}

// 本地缓存 key
const STORAGE_KEYS = {
  MEMBER: 'fm_member',
  FAMILIES: 'fm_families',
  CURRENT_FAMILY: 'fm_current_family',
  LOGIN_STATUS: 'fm_login_status',
}

module.exports = {
  MEMBER_COLORS,
  MEMBER_EMOJIS,
  LOGIN_STATUS,
  STORAGE_KEYS,
}
