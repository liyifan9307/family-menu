// 云函数 login —— 静默登录 + 多家庭身份识别
// 原则：openid 只从登录态取，不接收前端传入；登录环节不弹授权、不索取头像昵称（头像昵称是进入家庭后的主动填写动作，V3.8/V3.9）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 固定雾感五色板（对齐 UI 稿 V3.6 / 需求基准 V3.8 / 技术设计 v2.1 §2.2）
const COLORS = ['#6b90b8', '#c48494', '#d0a15e', '#7a9e7e', '#9a86a8']
const EMOJIS = ['🧑', '👩', '👨', '🧒', '👵']

function memberView(m, family) {
  const idx = Math.max(0, COLORS.indexOf(m.color))
  return {
    openid: m.openid,
    name: m.nickName || '家人',      // V3.9：保留 name 字段兼容点菜页，值改为真昵称
    nickName: m.nickName || null,    // V3.9：用户主动填写的昵称
    avatarEmoji: EMOJIS[idx % EMOJIS.length],
    avatarUrl: m.avatarUrl || null,   // V3.8：真头像 fileID，未设置为空由前端 emoji 兜底
    role: m.role,
    color: m.color,
    familyId: family && family._id,
    familyName: family && family.name,
  }
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID
  if (!openid) {
    return { member: null, families: [], currentFamilyId: null, status: 'unknown', error: 'NO_OPENID' }
  }
  try {
    // 1) 查该 openid 的全部 active 归属
    const memberRes = await db.collection('co_member').where({ openid, status: 'active' }).get()
    const members = memberRes.data || []

    // 2) 有 active 归属：组装 families[] + 选当前家庭
    if (members.length > 0) {
      const ids = members.map(m => m.familyId)
      const famRes = await db.collection('co_family').where({ _id: _.in(ids) }).get()
      const famMap = {}
      ;(famRes.data || []).forEach(f => { famMap[f._id] = f })
      const families = []
      members.forEach(m => {
        const f = famMap[m.familyId]
        if (f && f.status !== 'dissolving') families.push({ familyId: m.familyId, name: f.name, role: m.role, color: m.color })
      })
      // 孤儿数据兜底：有 active 成员记录但对应家庭全被删 → 清理孤儿记录，避免卡在"ok 但无家庭"
      if (families.length === 0) {
        const orphanIds = members.filter(m => !famMap[m.familyId]).map(m => m.familyId)
        if (orphanIds.length) await db.collection('co_member').where({ openid, familyId: _.in(orphanIds) })
          .update({ data: { status: 'removed' } })
        return {
          member: { openid, name: '家人', nickName: null, avatarEmoji: EMOJIS[0], avatarUrl: null, role: 'member', color: COLORS[0] },
          families: [], currentFamilyId: null, status: 'removed',
        }
      }
      // currentFamilyId：前端带上来的若仍有效则沿用，否则取第一个
      const wanted = event.currentFamilyId
      const currentFamilyId = families.some(f => f.familyId === wanted)
        ? wanted
        : (families[0] && families[0].familyId) || null
      const curMember = members.find(m => m.familyId === currentFamilyId) || members[0]
      return {
        member: memberView(curMember, famMap[curMember.familyId]),
        families,
        currentFamilyId,
        status: 'ok',
      }
    }

    // 3) 无 active：查 removed → 状态 removed；否则全新 → unknown
    const removedRes = await db.collection('co_member').where({ openid, status: 'removed' }).get()
    const status = (removedRes.data && removedRes.data.length > 0) ? 'removed' : 'unknown'
    return {
      member: { openid, name: '家人', nickName: null, avatarEmoji: EMOJIS[0], avatarUrl: null, role: 'member', color: COLORS[0] },
      families: [],
      currentFamilyId: null,
      status,
    }
  } catch (err) {
    console.error('[login] error', err)
    return { member: null, families: [], currentFamilyId: null, status: 'unknown', error: 'SERVER_ERROR' }
  }
}
