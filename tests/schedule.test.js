const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const rules = fs.existsSync('cloudfunctions/scheduleService/rules.js') ? require('../cloudfunctions/scheduleService/rules') : {}
test('字段验证拒绝无效日期和跨日时间', () => {
  assert.equal(typeof rules.validate, 'function')
  assert.throws(() => rules.validate({date:'2026-02-30',timeStart:'12:00',title:'接娃'}))
  assert.throws(() => rules.validate({date:'2026-11-25',timeStart:'12:00',timeEnd:'11:00',title:'接娃'}))
  assert.equal(rules.validate({date:'2026-11-25',timeStart:'12:00',title:' 接娃 '}).title,'接娃')
})
test('负责人可完成但不能编辑他人创建日程',()=>{
  assert.equal(typeof rules.permissions,'function')
  const p=rules.permissions({openid:'b',role:'member'},{createdBy:'a',ownerOpenid:'b'})
  assert.equal(p.edit,false);assert.equal(p.status,true)
})
test('分享白名单不泄露内部身份和备注',()=>{
  assert.equal(typeof rules.publicItem,'function')
  const item=rules.publicItem({_id:'x',title:'接娃',createdBy:'secret',ownerOpenid:'secret',note:'private',date:'2026-11-25'})
  assert.equal(item.createdBy,undefined);assert.equal(item.ownerOpenid,undefined);assert.equal(item.note,undefined)
})
