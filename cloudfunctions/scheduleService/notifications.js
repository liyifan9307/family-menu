// The template mapping is deployment configuration, never accepted from a caller.
module.exports=function(cloud,db){
 const read=async(table,id)=>(await db.collection(table).doc(id).get()).data
 async function sendTask(id){
  const tx=await db.startTransaction();let task
  try{task=(await tx.collection('co_schedule_notify').doc(id).get()).data;if(!task||task.status!=='pending'||task.nextAttemptAt>Date.now()){await tx.rollback();return}
   await tx.collection('co_schedule_notify').doc(id).update({data:{status:'sending',attempts:task.attempts+1,startedAt:Date.now()}});await tx.commit()
  }catch(e){try{await tx.rollback()}catch(_){}return}
  const update=data=>db.collection('co_schedule_notify').doc(id).update({data})
  try{
   const family=await read('co_family',task.familyId),item=await read('co_schedule',task.scheduleId)
   const members=await db.collection('co_member').where({familyId:task.familyId,openid:task.recipientOpenid,status:'active'}).limit(1).get()
   if(!family||family.status==='dissolving'||!members.data.length||!item)return await update({status:'cancelled'})
   if(!process.env.SCHEDULE_TEMPLATE_ID)return await update({status:'unavailable',lastError:'TEMPLATE_NOT_CONFIGURED'})
   let mapping;try{mapping=JSON.parse(process.env.SCHEDULE_TEMPLATE_FIELDS||'{}')}catch(_){mapping={}}
   if(!mapping.title||!mapping.time||!mapping.place)return await update({status:'unavailable',lastError:'TEMPLATE_FIELDS_NOT_CONFIGURED'})
   const kind={create:'新增',update:'变更',setStatus:'状态更新',delete:'删除'};const data={};data[mapping.title]={value:Array.from((kind[task.kind]||'更新')+'：'+item.title).slice(0,20).join('')};data[mapping.time]={value:item.date+' '+item.timeStart};data[mapping.place]={value:Array.from(item.place||'未填写地点').slice(0,20).join('')}
   const r=await cloud.openapi.subscribeMessage.send({touser:task.recipientOpenid,templateId:process.env.SCHEDULE_TEMPLATE_ID,page:'pages/schedule/schedule',data,miniprogramState:process.env.SCHEDULE_MESSAGE_STATE||'formal',lang:'zh_CN'})
   if(r.errCode&&r.errCode!==0)throw Object.assign(Error('send failed'),{errCode:r.errCode})
   await update({status:'sent',sentAt:Date.now()})
  }catch(e){const code=Number(e.errCode||e.errcode);const attempt=task.attempts+1
   // Unknown transport outcomes are never blindly resent.
   const retry=[-1,45009].includes(code)&&attempt<=3
   await update({status:retry?'pending':Number.isFinite(code)?'failed':'unknown',lastError:String(code||'UNKNOWN_RESULT'),nextAttemptAt:Date.now()+[60000,300000,1800000][Math.min(attempt-1,2)]})
  }
 }
 return {process:sendTask,async pending(familyId,scheduleId){
  const stalled=await db.collection('co_schedule_notify').where({status:'sending',startedAt:db.command.lte(Date.now()-300000)}).limit(20).get()
  for(const task of stalled.data)await db.collection('co_schedule_notify').doc(task._id).update({data:{status:'unknown',lastError:'INTERRUPTED_SEND'}})
const where={status:'pending',nextAttemptAt:db.command.lte(Date.now())};if(familyId)where.familyId=familyId;if(scheduleId)where.scheduleId=scheduleId;const r=await db.collection('co_schedule_notify').where(where).limit(20).get();for(const t of r.data)await sendTask(t._id)}}
}
