function fail(code,message) { throw Object.assign(new Error(message),{code}) }
// 用日期往返校验，拒绝被 JavaScript 自动归到下个月的日期。
function date(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value) fail('BAD_PARAM','日期无效')
  return value
}
// 只返回允许保存的字段，并按 Unicode 字符计数。
function validate(input) {
  const out={date:date(input.date)}
  for(const [key,max,required] of [['title',30,true],['place',50],['childName',20],['note',200]]) {
    const value=input[key]===undefined?'':input[key]
    if(typeof value!=='string') fail('BAD_PARAM','字段格式错误')
    out[key]=value.trim()
    if((required&&!out[key])||Array.from(out[key]).length>max) fail('BAD_PARAM',`${key==='title'?'事项':key}不能为空或超过${max}字`)
  }
  for(const key of ['timeStart','timeEnd']) {
    out[key]=input[key]===undefined?'':input[key]
    if(typeof out[key]!=='string'||(out[key]&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(out[key]))) fail('BAD_PARAM','时间格式无效')
  }
  if(out.timeEnd&&!out.timeStart) fail('BAD_PARAM','请先选择开始时间')
  if(out.timeEnd&&out.timeEnd<=out.timeStart) fail('BAD_PARAM','结束时间须晚于开始时间，跨天请拆分')
  return out
}
// 负责人可更新状态，编辑和删除则由创建人或管理员操作。
function permissions(member,item) {
  const edit=member.role==='admin'||item.createdBy===member.openid
  const owner=item.ownerOpenid===member.openid
  return {
    edit,delete:edit,status:edit||owner,
    complete:item.requiresConfirmation ? owner&&item.ownerConfirmed===true : edit||owner,
    confirmOwner:item.status==='pending'&&item.requiresConfirmation===true&&owner&&!item.ownerConfirmed,
    requestHandoff:item.status==='pending'&&item.requiresConfirmation===true&&(edit||owner),
  }
}
// 显式列出访客可见字段，避免返回成员标识和内部备注。
function publicItem(item) {
  const out={}
  for(const key of ['_id','date','timeStart','timeEnd','title','childName','place','ownerName','ownerUnavailable','requiresConfirmation','ownerConfirmed','handoffPending','status','updatedAt']) if(item[key]!==undefined)out[key]=item[key]
  return out
}
module.exports={fail,date,validate,permissions,publicItem}
