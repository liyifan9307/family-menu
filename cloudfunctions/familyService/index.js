// 云函数 familyService —— 家庭创建/加入/成员管理（地基核心）
// 安全：openid 只从登录态取；familyId 由前端传但必须经 requireMember 归属校验；入口动作例外
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
// throwOnNotFound:false —— doc.get() 找不到记录时不抛异常（事务文档建议），由代码显式判断
const db = cloud.database({ throwOnNotFound: false })
const _ = db.command

const FAMILY = 'co_family'
const MEMBER = 'co_member'

// 固定雾感五色板（对齐 UI 稿 V3.6 / 需求基准 V3.8 / 技术设计 v2.1 §2.2）——系统按加入顺序分配，无分配界面
const COLORS = ['#6b90b8', '#c48494', '#d0a15e', '#7a9e7e', '#9a86a8']
const EMOJIS = ['🧑', '👩', '👨', '🧒', '👵']
const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 邀请码 30 天有效（自用够长）

function memberView(m) {
  const idx = Math.max(0, COLORS.indexOf(m.color))
  return {
    _id: m._id,
    familyId: m.familyId,
    openid: m.openid,
    role: m.role,
    color: m.color,
    avatarEmoji: EMOJIS[idx % EMOJIS.length],
    avatarUrl: m.avatarUrl || null,   // V3.8：真头像 fileID，未设置为空由前端 emoji 兜底
    nickName: m.nickName || null,     // V3.9：主动填写的昵称，未设置为空由前端兜底"家人"
    name: m.nickName || '家人',       // 兼容旧字段：前端 name 直接用真昵称
    status: m.status,
  }
}

// 提审预埋（技术设计 §11.1）：本期直通，将来只改这里接 security.msgSecCheck
async function checkText(text, openid) {
  return { pass: true }
}

function genInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去掉易混淆的 0/O/1/I
  let code = ''
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)]
  return code
}

// 取该家庭最少使用的固定色（新成员分配）
async function pickColor(familyId) {
  const used = await db.collection(MEMBER).where({ familyId, status: 'active' }).field({ color: true }).get()
  const counts = {}
  ;(used.data || []).forEach(m => { counts[m.color] = (counts[m.color] || 0) + 1 })
  let best = COLORS[0]
  let bestN = Infinity
  COLORS.forEach(c => {
    const n = counts[c] || 0
    if (n < bestN) { bestN = n; best = c }
  })
  return best
}

// 归属校验（核心·双参数）：必须 active 成员，否则拒绝
async function requireMember(openid, familyId) {
  if (!openid || !familyId) throw Object.assign(new Error('身份或家庭参数缺失'), { code: 'BAD_PARAM' })
  const res = await db.collection(MEMBER).where({ openid, familyId, status: 'active' }).get()
  if (!res.data || res.data.length === 0) {
    throw Object.assign(new Error('你不属于这个家庭'), { code: 'NOT_MEMBER' })
  }
  return res.data[0]
}

// 入口动作例外：createFamily / joinFamily 此刻无家庭上下文，不调 requireMember
async function createFamily(openid, name) {
  const nameStr = typeof name === 'string' ? name.trim() : ''
  if (!nameStr) throw Object.assign(new Error('请填写家庭名称'), { code: 'NAME_REQUIRED' })
  if (nameStr.length > 20) throw Object.assign(new Error('家庭名称不超过 20 字'), { code: 'NAME_TOO_LONG' })
  const safe = await checkText(nameStr, openid)
  if (!safe.pass) throw Object.assign(new Error('家庭名称含违规内容'), { code: 'TEXT_RISK' })

  const inviteCode = genInviteCode()
  const now = Date.now()
  const nowDate = new Date(now)
  // 事务：建家庭 + 建管理员成员必须原子，否则中途失败会留"无管理员的孤儿家庭"
  // 注：事务内不用 db.serverDate()（兼容风险），改用 new Date()，自用场景毫秒差无所谓
  const transaction = await db.startTransaction()
  try {
    const famRes = await transaction.collection(FAMILY).add({
      data: {
        name: nameStr,
        ownerOpenid: openid,
        inviteCode,
        inviteExpireAt: new Date(now + INVITE_TTL_MS),
        createdAt: nowDate,
      },
    })
    const familyId = famRes._id
    await transaction.collection(MEMBER).add({
      data: {
        familyId, openid, role: 'admin', color: COLORS[0], status: 'active',
        joinedAt: nowDate,
      },
    })
    await transaction.commit()
    // memberView 用内存对象构造，不依赖数据库回读（事务 add 不返回 data）
    return {
      familyId, inviteCode,
      member: memberView({ familyId, openid, role: 'admin', color: COLORS[0], status: 'active' }),
    }
  } catch (e) {
    try { await transaction.rollback() } catch (_) { /* rollback 失败不掩盖原始错误 */ }
    throw e
  }
}

async function joinFamily(openid, inviteCode) {
  const code = typeof inviteCode === 'string' ? inviteCode.trim().toUpperCase() : ''
  if (!code) throw Object.assign(new Error('请输入邀请码'), { code: 'CODE_REQUIRED' })
  const famRes = await db.collection(FAMILY).where({
    inviteCode: code,
    inviteExpireAt: _.gt(new Date()),
  }).get()
  if (!famRes.data || famRes.data.length === 0) {
    throw Object.assign(new Error('邀请码无效或已过期'), { code: 'CODE_INVALID' })
  }
  const familyId = famRes.data[0]._id

  // 同一家庭重复加入拒绝（复合唯一索引 (openid,familyId) 也兜底）
  const dup = await db.collection(MEMBER).where({ openid, familyId, status: 'active' }).get()
  if (dup.data && dup.data.length > 0) {
    throw Object.assign(new Error('你已在该家庭中'), { code: 'ALREADY_JOINED' })
  }
  // 曾被移除 → 复用原记录重新激活，颜色重新分配
  const removed = await db.collection(MEMBER).where({ openid, familyId, status: 'removed' }).get()
  const color = await pickColor(familyId)
  let memberId
  if (removed.data && removed.data.length > 0) {
    memberId = removed.data[0]._id
    await db.collection(MEMBER).doc(memberId).update({
      data: { status: 'active', role: 'member', color, joinedAt: db.serverDate() },
    })
  } else {
    const addRes = await db.collection(MEMBER).add({
      data: {
        familyId, openid, role: 'member', color, status: 'active', joinedAt: db.serverDate(),
      },
    })
    memberId = addRes._id
  }
  return {
    familyId,
    member: memberView({
      _id: memberId, familyId, openid, role: 'member', color, status: 'active',
    }),
  }
}

async function getFamilies(openid) {
  const res = await db.collection(MEMBER).where({ openid, status: 'active' }).get()
  const members = res.data || []
  if (members.length === 0) return { families: [] }
  const ids = members.map(m => m.familyId)
  const famRes = await db.collection(FAMILY).where({ _id: _.in(ids) }).get()
  const famMap = {}
  ;(famRes.data || []).forEach(f => { famMap[f._id] = f })
  const families = members.filter(m => famMap[m.familyId]).map(m => ({
    familyId: m.familyId,
    name: famMap[m.familyId].name,
    role: m.role,
    color: m.color,
  }))
  return { families }
}

async function getFamily(openid, familyId) {
  await requireMember(openid, familyId)
  let fam
  try {
    fam = await db.collection(FAMILY).doc(familyId).get()
  } catch (e) {
    throw Object.assign(new Error('家庭信息不存在，请切换或重新加入'), { code: 'FAMILY_NOT_FOUND' })
  }
  // throwOnNotFound:false 时找不到记录返回空 data，不抛异常，需显式判断
  if (!fam || !fam.data) {
    throw Object.assign(new Error('家庭信息不存在，请切换或重新加入'), { code: 'FAMILY_NOT_FOUND' })
  }
  const members = await listMembers(openid, familyId)
  return {
    family: {
      familyId: fam.data._id,
      name: fam.data.name,
      ownerOpenid: fam.data.ownerOpenid,
      inviteCode: fam.data.inviteCode,
      inviteExpireAt: fam.data.inviteExpireAt,
    },
    members: members.members,
  }
}

async function listMembers(openid, familyId) {
  await requireMember(openid, familyId)
  const res = await db.collection(MEMBER).where({ familyId, status: 'active' }).get()
  return { members: (res.data || []).map(memberView) }
}

async function removeMember(openid, familyId, targetOpenid) {
  const me = await requireMember(openid, familyId)
  if (me.role !== 'admin') {
    throw Object.assign(new Error('只有管理员可以移除成员'), { code: 'NO_PERMISSION' })
  }
  if (!targetOpenid || targetOpenid === openid) {
    throw Object.assign(new Error('不能移除自己'), { code: 'REMOVE_SELF' })
  }
  // 目标必须同家庭（防越权跨家庭移除）
  const target = await db.collection(MEMBER).where({
    familyId, openid: targetOpenid, status: 'active',
  }).get()
  if (!target.data || target.data.length === 0) {
    throw Object.assign(new Error('该成员不在此家庭'), { code: 'TARGET_NOT_FOUND' })
  }
  await db.collection(MEMBER).doc(target.data[0]._id).update({
    data: { status: 'removed' },
  })
  return { ok: true }
}

async function refreshInvite(openid, familyId) {
  const me = await requireMember(openid, familyId)
  if (me.role !== 'admin') {
    throw Object.assign(new Error('只有管理员可以刷新邀请码'), { code: 'NO_PERMISSION' })
  }
  const inviteCode = genInviteCode()
  const expireAt = new Date(Date.now() + INVITE_TTL_MS)
  await db.collection(FAMILY).doc(familyId).update({
    data: { inviteCode, inviteExpireAt: expireAt },
  })
  return { inviteCode, expireAt }
}

// V3.8：更新真头像 —— 按 openid 更新该用户全部家庭记录（跨家庭共用）
// 安全：openid 从登录态取、不接收前端传；fileID 由前端 wx.cloud.uploadFile 换取，这里只校验格式
// 归属：本动作只改自己的头像，不涉及他人，无需 requireMember；但必须已有至少一个 active 归属才允许写入
async function updateAvatar(openid, fileID) {
  if (typeof fileID !== 'string' || fileID.indexOf('cloud://') !== 0) {
    throw Object.assign(new Error('头像文件地址无效'), { code: 'BAD_FILEID' })
  }
  // 归属校验：uploadAvatar 生成的 cloudPath 为 avatars/<openid>-<ts>.png
  // fileID 必须含本人的 openid 段，防止传他人的 fileID 改自己的头像
  if (fileID.indexOf('avatars/' + openid + '-') === -1) {
    throw Object.assign(new Error('头像文件不属于当前用户'), { code: 'FILEID_OWNER_MISMATCH' })
  }
  const owned = await db.collection(MEMBER).where({ openid, status: 'active' }).get()
  if (!owned.data || owned.data.length === 0) {
    throw Object.assign(new Error('你还没有加入任何家庭'), { code: 'NO_FAMILY' })
  }
  // 收集旧头像 fileID（去重），更新成功后删除，避免云存储长期堆积垃圾
  const oldFiles = []
  ;(owned.data || []).forEach(m => {
    if (m.avatarUrl && m.avatarUrl !== fileID && oldFiles.indexOf(m.avatarUrl) === -1) {
      oldFiles.push(m.avatarUrl)
    }
  })
  // 批量更新该 openid 的全部记录（含 removed 的历史记录，重新加入时头像仍在）
  const r = await db.collection(MEMBER).where({ openid }).update({
    data: { avatarUrl: fileID },
  })
  // 删除旧文件失败不影响主流程（头像已落库）
  if (oldFiles.length > 0) {
    try {
      await cloud.deleteFile({ fileList: oldFiles })
    } catch (e) {
      console.warn('[familyService] 旧头像清理失败:', e && e.message)
    }
  }
  return { ok: true, updated: (r.stats && r.stats.updated) || owned.data.length }
}

// V3.9：更新昵称 —— 与头像一致，按 openid 更新该用户全部家庭记录（跨家庭共用）
// 安全：昵称是 UGC，写入前走 checkText() 预埋钩子（本期直通，提审接 msgSecCheck）；openid 从登录态取
async function updateProfile(openid, nickName) {
  const name = typeof nickName === 'string' ? nickName.trim() : ''
  if (!name) throw Object.assign(new Error('请输入昵称'), { code: 'NICKNAME_REQUIRED' })
  if (name.length > 20) throw Object.assign(new Error('昵称不超过 20 字'), { code: 'NICKNAME_TOO_LONG' })
  const safe = await checkText(name, openid)
  if (!safe.pass) throw Object.assign(new Error('昵称含违规内容'), { code: 'TEXT_RISK' })
  const owned = await db.collection(MEMBER).where({ openid, status: 'active' }).get()
  if (!owned.data || owned.data.length === 0) {
    throw Object.assign(new Error('你还没有加入任何家庭'), { code: 'NO_FAMILY' })
  }
  // 批量更新该 openid 的全部记录（含 removed 历史记录，重新加入时昵称仍在）
  const r = await db.collection(MEMBER).where({ openid }).update({
    data: { nickName: name },
  })
  return { ok: true, updated: (r.stats && r.stats.updated) || owned.data.length, nickName: name }
}

// V3.10：解散家庭 —— 仅 admin、且家庭内除自己外无其他 active 成员时才允许
// 安全：requireMember 双参数归属校验 + role=admin；防一人解散牵连全家
// 事务：微信云开发事务不支持 where 批量操作（官方文档），先查出全部 _id，再在事务内逐条 doc().remove()
async function dissolveFamily(openid, familyId) {
  const me = await requireMember(openid, familyId)
  if (me.role !== 'admin') {
    throw Object.assign(new Error('只有管理员可以解散家庭'), { code: 'NO_PERMISSION' })
  }
  // 统计家庭内 active 成员：除自己外还有别人则拒绝，须先移除
  const activeRes = await db.collection(MEMBER).where({ familyId, status: 'active' }).get()
  const activeList = activeRes.data || []
  const others = activeList.filter(m => m.openid !== openid)
  if (others.length > 0) {
    throw Object.assign(new Error('请先移除其他成员，再解散家庭'), { code: 'OTHER_MEMBERS_EXIST' })
  }
  // 找出该家庭全部成员记录（含 removed 历史），一并删除，避免残留孤儿
  const allRes = await db.collection(MEMBER).where({ familyId }).get()
  const allIds = (allRes.data || []).map(m => m._id)
  // 事务原子删：家庭文档 + 全部成员记录。事务内只支持 doc() 单记录操作
  const transaction = await db.startTransaction()
  try {
    await transaction.collection(FAMILY).doc(familyId).remove()
    for (const id of allIds) {
      await transaction.collection(MEMBER).doc(id).remove()
    }
    await transaction.commit()
  } catch (e) {
    try { await transaction.rollback() } catch (_) { /* rollback 失败不掩盖原始错误 */ }
    throw e
  }
  return { ok: true, familyId }
}

exports.main = async (event = {}) => {
  const { action } = event
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { error: { code: 'NO_OPENID', message: '无法识别身份' } }
  try {
    switch (action) {
      case 'createFamily': return await createFamily(openid, event.name)
      case 'joinFamily': return await joinFamily(openid, event.inviteCode)
      case 'getFamilies': return await getFamilies(openid)
      case 'getFamily': return await getFamily(openid, event.familyId)
      case 'listMembers': return await listMembers(openid, event.familyId)
      case 'removeMember': return await removeMember(openid, event.familyId, event.targetOpenid)
      case 'refreshInvite': return await refreshInvite(openid, event.familyId)
      case 'updateAvatar': return await updateAvatar(openid, event.fileID)
      case 'updateProfile': return await updateProfile(openid, event.nickName)
      case 'dissolveFamily': return await dissolveFamily(openid, event.familyId)
      default: throw Object.assign(new Error('未知操作: ' + action), { code: 'BAD_ACTION' })
    }
  } catch (err) {
    console.error('[familyService] ' + action + ' error', err)
    return { error: { code: err.code || 'SERVER_ERROR', message: err.message || '操作失败' } }
  }
}
