const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

function service({ beforeTransaction } = {}) {
  let openid = 'owner'
  let next = 0
  const future = new Date(Date.now() + 86400000)
  const data = {
    co_family: { f: { _id: 'f', name: '家', ownerOpenid: 'owner', inviteCode: 'OLD123', inviteExpireAt: future } },
    co_member: {
      a: { _id: 'a', familyId: 'f', openid: 'owner', status: 'active', role: 'admin' },
      b: { _id: 'b', familyId: 'f', openid: 'member', status: 'active', role: 'member' },
    },
  }
  function collection(name) {
    let filter = {}, max = Infinity
    return {
      where(value) { filter = value; return this },
      field() { return this },
      limit(value) { max = value; return this },
      async get() {
        const rows = Object.values(data[name]).filter(row => Object.entries(filter)
          .every(([key, value]) => value && value.gt ? row[key] > value.gt : row[key] === value))
        return { data: structuredClone(rows.slice(0, max)) }
      },
      doc(id) {
        return {
          get: async () => ({ data: structuredClone(data[name][id] || null) }),
          set: async ({ data: value }) => { data[name][id] = { ...structuredClone(value), _id: id } },
          update: async ({ data: value }) => Object.assign(data[name][id], structuredClone(value)),
          remove: async () => { delete data[name][id] },
        }
      },
      async add({ data: value }) {
        const id = 'new-' + ++next
        data[name][id] = { ...structuredClone(value), _id: id }
        return { _id: id }
      },
    }
  }
  const db = {
    collection, command: { gt: value => ({ gt: value }) },
    async startTransaction() {
      beforeTransaction?.(data)
      const snapshot = structuredClone(data)
      return {
        collection, commit: async () => {},
        rollback: async () => { Object.assign(data, snapshot) },
      }
    },
  }
  const cloud = { init() {}, database: () => db, getWXContext: () => ({ OPENID: openid }) }
  const exports = {}
  vm.runInNewContext(fs.readFileSync('cloudfunctions/familyService/index.js', 'utf8'), {
    require: name => name === 'wx-server-sdk' ? cloud : require(name),
    exports, console: { error() {}, warn() {} },
  })
  return { data, call: exports.main, as: value => { openid = value } }
}

test('移除成员时旧邀请码失效，持新码可重新加入', async () => {
  const s = service()
  const removed = await s.call({ action: 'removeMember', familyId: 'f', targetOpenid: 'member' })
  assert.equal(removed.ok, true)
  const newCode = s.data.co_family.f.inviteCode
  assert.notEqual(newCode, 'OLD123')
  assert.equal(s.data.co_family.f.shareEpoch, 1)
  s.as('member')
  const stale = await s.call({ action: 'joinFamily', inviteCode: 'OLD123' })
  assert.equal(stale.error.code, 'CODE_INVALID')
  assert.equal(s.data.co_member.b.status, 'removed')
  assert.equal((await s.call({ action: 'joinFamily', inviteCode: newCode })).familyId, 'f')
  assert.equal(s.data.co_member.b.status, 'active')
})

test('加入事务拒绝在初次查询之后已刷新或过期的邀请码', async () => {
  for (const mutate of [
    f => { f.inviteCode = 'NEW123' },
    f => { f.inviteExpireAt = new Date(0) },
  ]) {
    const s = service({ beforeTransaction: data => mutate(data.co_family.f) })
    s.as('guest')
    const result = await s.call({ action: 'joinFamily', inviteCode: 'OLD123' })
    assert.equal(result.error.code, 'CODE_INVALID')
    assert.equal(Object.values(s.data.co_member).some(m => m.openid === 'guest'), false)
  }
})

test('创建同一个请求只产生一个家庭和管理员成员', async () => {
  const s = service()
  const payload = { action: 'createFamily', name: '新家', requestId: 'request-abc-123' }
  const first = await s.call(payload)
  const second = await s.call(payload)
  assert.ok(first.familyId)
  assert.equal(first.familyId, second.familyId)
  assert.equal(Object.keys(s.data.co_family).length, 2)
  assert.equal(Object.values(s.data.co_member).filter(m => m.familyId === first.familyId).length, 1)
})

test('首批数据清理失败后仍确认家庭已关闭，定时任务可以续跑', async () => {
  const s = service()
  s.data.co_member.b.status = 'removed'
  // 暂无日程集合，模拟首批读取失败。
  const result = await s.call({ action: 'dissolveFamily', familyId: 'f' })
  assert.equal(result.processing, true)
  assert.equal(s.data.co_family.f.status, 'dissolving')
  for (const name of ['co_schedule', 'co_schedule_event', 'co_schedule_share', 'co_schedule_notify', 'co_schedule_request']) {
    s.data[name] = {}
  }
  for (let index = 0; index < 51; index++) {
    const id = 'schedule-' + index
    s.data.co_schedule[id] = { _id: id, familyId: 'f' }
  }
  s.as(null)
  await s.call({ Type: 'Timer', TriggerName: 'familyCleanup' })
  assert.equal(s.data.co_family.f.status, 'dissolving')
  assert.equal(Object.keys(s.data.co_schedule).length, 1)
  await s.call({ Type: 'Timer', TriggerName: 'familyCleanup' })
  assert.equal(s.data.co_family.f, undefined)
  assert.equal(Object.keys(s.data.co_member).length, 0)
})

test('移交后只有接任管理员能修改名称，原管理员保留成员身份', async () => {
  const s = service()
  const transfer = { action: 'transferAdmin', familyId: 'f', memberId: 'b' }
  const rename = { action: 'renameFamily', familyId: 'f', name: ' 新家 ' }
  assert.equal((await s.call(transfer)).ok, true)
  assert.equal(s.data.co_family.f.ownerOpenid, 'member')
  assert.equal(s.data.co_member.a.role, 'member')
  assert.equal(s.data.co_member.b.role, 'admin')
  assert.equal((await s.call(rename)).error.code, 'NO_PERMISSION')
  s.as('member')
  assert.equal((await s.call(rename)).ok, true)
  assert.equal(s.data.co_family.f.name, '新家')
  assert.equal((await s.call({ ...rename, name: ' ' })).error.code, 'BAD_NAME')
})

test('移交拒绝自己、外家及已移除成员', async () => {
  for (const overrides of [{ openid: 'owner' }, { familyId: 'another' }, { status: 'removed' }]) {
    const s = service()
    Object.assign(s.data.co_member.b, overrides)
    assert.equal((await s.call({ action: 'transferAdmin', familyId: 'f', memberId: 'b' })).error.code, 'INVALID_TARGET')
    assert.equal(s.data.co_family.f.ownerOpenid, 'owner')
    assert.equal(s.data.co_member.a.role, 'admin')
  }
})

test('每个家庭在成功改名后须等待 30 天，管理员移交不重置等待期', async () => {
  const s = service()
  const rename = name => s.call({ action: 'renameFamily', familyId: 'f', name })
  assert.equal((await rename(' 家 ')).ok, true)
  assert.equal(s.data.co_family.f.lastRenamedAt, undefined)
  assert.equal((await rename('新家')).ok, true)
  const firstRename = s.data.co_family.f.lastRenamedAt.getTime()
  assert.equal((await rename('新家')).ok, true)
  assert.equal(s.data.co_family.f.lastRenamedAt.getTime(), firstRename)
  await s.call({ action: 'transferAdmin', familyId: 'f', memberId: 'b' })
  s.as('member')
  assert.equal((await rename('另一个名字')).error.code, 'RENAME_COOLDOWN')
  assert.equal(s.data.co_family.f.name, '新家')
  s.data.co_family.f.lastRenamedAt = new Date(Date.now() - 30 * 86400000)
  assert.equal((await rename('另一个名字')).ok, true)
})
