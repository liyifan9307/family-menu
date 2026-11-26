function fail(code,message) { throw Object.assign(new Error(message),{code}) }
function date(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value) fail('BAD_PARAM','日期无效')
  return value
}
function validate(input) {
  const out={date:date(input.date)}
  for(const [key,max,required] of [['title',30,true],['place',50],['childName',20],['note',200]]) {
    const value=input[key]===undefined?'':input[key]
    if(typeof value!=='string') fail('BAD_PARAM','字段格式错误')
    out[key]=value.trim()
    if((required&&!out[key])||Array.from(out[key]).length>max) fail('BAD_PARAM',`${key==='title'?'事项':key}不能为空或超过${max}字`)
  }
  for(const key of ['timeStart','timeEnd']) {
    out[key]=input[key]||''
    if((key==='timeStart'||out[key])&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(out[key])) fail('BAD_PARAM','时间格式无效')
  }
  if(out.timeEnd&&out.timeEnd<=out.timeStart) fail('BAD_PARAM','结束时间须晚于开始时间，跨天请拆分')
  return out
}
function permissions(member,item) {
  const edit=member.role==='admin'||item.createdBy===member.openid
  return {edit,delete:edit,status:edit||item.ownerOpenid===member.openid}
}
function publicItem(item) {
  const out={}
  for(const key of ['_id','date','timeStart','timeEnd','title','childName','place','ownerName','ownerUnavailable','status','updatedAt']) if(item[key]!==undefined)out[key]=item[key]
  return out
}
module.exports={fail,date,validate,permissions,publicItem}
