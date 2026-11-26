const cloud=require('wx-server-sdk')
const crypto=require('crypto')
const R=require('./rules')
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV})
const db=cloud.database({throwOnNotFound:false})
const notifications=require('./notifications')(cloud,db)
const hash=s=>crypto.createHash('sha256').update(s).digest('hex')
const read=async(store,table,id)=>{const r=await store.collection(table).doc(id).get();return r.data||null}
async function context(familyId,openid,store=db) {
  if(!familyId||!openid)R.fail('BAD_PARAM','缺少家庭或身份')
  const family=await read(store,'co_family',familyId)
  if(!family)R.fail('FAMILY_NOT_FOUND','家庭不存在')
  if(family.status==='dissolving')R.fail('FAMILY_DISSOLVING','家庭正在解散')
  // Resolve member id outside transactions; transaction then rereads exact document.
  const found=await db.collection('co_member').where({familyId,openid}).limit(1).get()
  const member=found.data[0]&&await read(store,'co_member',found.data[0]._id)
  if(!member||member.status!=='active')R.fail('NOT_MEMBER','你已不属于这个家庭')
  return {family,member}
}
async function decorate(items) {
  return Promise.all(items.map(async item=>{
    const r=await db.collection('co_member').where({familyId:item.familyId,openid:item.ownerOpenid,status:'active'}).limit(1).get()
    const m=r.data[0]
    return {...item,ownerName:m?(m.nickName||'家人'):'负责人已离开，请重新安排',ownerUnavailable:!m,ownerColor:m?m.color:'#657368'}
  }))
}
async function shared(token) {
  if(typeof token!=='string'||!/^[-_A-Za-z0-9]{32}$/.test(token))R.fail('SHARE_INVALID','链接已失效，请让家人重新分享')
  const r=await db.collection('co_schedule_share').where({tokenHash:hash(token)}).limit(1).get()
  const share=r.data[0], family=share&&await read(db,'co_family',share.familyId)
  if(!share||share.expiresAt<=Date.now()||!family||family.status==='dissolving'||(family.shareEpoch||0)!==share.shareEpoch)R.fail('SHARE_INVALID','链接已失效，请让家人重新分享')
  return {share,family}
}
async function list(familyId,date,cursor,limit=20) {
  R.date(date)
  const size=Math.min(50,Math.max(1,Number(limit)||20))
  let where={familyId,date,deletedAt:null}
  if(cursor) {
    let c;try{c=JSON.parse(Buffer.from(cursor,'base64').toString())}catch(_){R.fail('BAD_PARAM','分页无效')}
    if(c.familyId!==familyId||c.date!==date||typeof c.id!=='string'||typeof c.time!=='string')R.fail('BAD_PARAM','分页无效')
    where=db.command.and(where,db.command.or({timeStart:db.command.gt(c.time)},{timeStart:c.time,_id:db.command.gt(c.id)}))
  }
  const r=await db.collection('co_schedule').where(where).orderBy('timeStart','asc').orderBy('_id','asc').limit(size+1).get()
  const more=r.data.length>size, rows=r.data.slice(0,size),last=rows[rows.length-1]
  return {items:await decorate(rows),nextCursor:more?Buffer.from(JSON.stringify({familyId,date,time:last.timeStart,id:last._id})).toString('base64'):null,serverTime:Date.now()}
}
async function mutate(e,openid) {
  if(typeof e.requestId!=='string'||!/^[-\w]{8,100}$/.test(e.requestId))R.fail('BAD_PARAM','请求标识无效')
  const payload={action:e.action,scheduleId:e.scheduleId||null,expectedVersion:e.expectedVersion||null,fields:e.fields||null,targetStatus:e.targetStatus||null,reason:e.reason||''}
  const fingerprint=hash(JSON.stringify(payload)), rid=hash(`${e.familyId}:${openid}:${e.requestId}`)
  const tx=await db.startTransaction()
  let result
  try {
    const {family,member}=await context(e.familyId,openid,tx)
    const prior=await read(tx,'co_schedule_request',rid)
    if(prior){if(prior.payloadHash!==fingerprint)R.fail('IDEMPOTENCY_CONFLICT','请勿修改待确认请求');await tx.rollback();return prior.result}
    const now=Date.now()
    let previous=null, item
    if(e.action==='create') {
      item={...R.validate(e.fields||{}),familyId:e.familyId,ownerOpenid:(e.fields||{}).ownerOpenid||openid,createdBy:openid,createdAt:now,status:'pending',deletedAt:null,version:1}
    } else {
      previous=await read(tx,'co_schedule',e.scheduleId)
      if(!previous||previous.familyId!==e.familyId||previous.deletedAt)R.fail('NOT_FOUND','日程不存在')
      const p=R.permissions(member,previous)
      if(!(e.action==='setStatus'?p.status:p.edit))R.fail('NO_PERMISSION','无权执行此操作')
      if(previous.version!==e.expectedVersion)R.fail('VERSION_CONFLICT','家人已更新这条安排，请查看最新内容')
      item={...previous,version:previous.version+1}
      if(e.action==='update')item={...item,...R.validate({...previous,...e.fields}),ownerOpenid:(e.fields||{}).ownerOpenid||previous.ownerOpenid}
      if(e.action==='setStatus') {
        if(!['pending','done','cancelled'].includes(e.targetStatus)||e.targetStatus===previous.status||(previous.status!=='pending'&&e.targetStatus!=='pending'))R.fail('BAD_PARAM','请先恢复待办，再修改状态')
        item.status=e.targetStatus
      }
      if(e.action==='delete'){item.deletedAt=now;item.deletedBy=openid}
    }
    if(e.action==='create'||e.action==='update') {
      const r=await db.collection('co_member').where({familyId:e.familyId,openid:item.ownerOpenid,status:'active'}).limit(1).get()
      const owner=r.data[0]&&await read(tx,'co_member',r.data[0]._id)
      if(!owner||owner.status!=='active')R.fail('BAD_PARAM','请选择有效负责人')
    }
    if(e.action==='create'||e.action==='update') {
      let checked
      try { checked=await cloud.openapi.security.msgSecCheck({openid,scene:2,version:2,content:[item.title,item.place,item.childName,item.note].filter(Boolean).join('；')}) }
      catch(_) { R.fail('CONTENT_CHECK_UNAVAILABLE','内容检查暂不可用，内容已保留，请重试') }
      if(!checked.result||checked.result.suggest!=='pass')R.fail('TEXT_RISK','内容未通过检查，请修改后重试')
    }
    item.updatedAt=now;item.updatedBy=openid
    if(item._id){const {_id,...data}=item;await tx.collection('co_schedule').doc(_id).set({data})}
    else {const r=await tx.collection('co_schedule').add({data:item});item._id=r._id}
    const reason=typeof e.reason==='string'?e.reason.trim():''
    if(Array.from(reason).length>200)R.fail('BAD_PARAM','原因不超过200字')
    await tx.collection('co_schedule_event').add({data:{familyId:e.familyId,scheduleId:item._id,actorOpenid:openid,action:e.action,fromStatus:previous?previous.status:null,toStatus:item.status,changedFields:Object.keys(e.fields||{}),reason,createdAt:now,version:item.version}})
    const recipients=[...new Set([item.ownerOpenid,...(e.action==='update'&&previous?[previous.ownerOpenid]:[])])].filter(id=>id!==openid)
    for(const recipientOpenid of recipients)await tx.collection('co_schedule_notify').add({data:{familyId:e.familyId,scheduleId:item._id,eventVersion:item.version,recipientOpenid,kind:e.action,status:'pending',attempts:0,nextAttemptAt:now,createdAt:now}})
    await tx.collection('co_family').doc(e.familyId).update({data:{mutationVersion:(family.mutationVersion||0)+1}})
    result={item,notificationStatus:recipients.length?'pending':'not_needed'}
    await tx.collection('co_schedule_request').doc(rid).set({data:{familyId:e.familyId,actorOpenid:openid,requestId:e.requestId,payloadHash:fingerprint,result,createdAt:now}})
    await tx.commit()
  } catch(err){try{await tx.rollback()}catch(_){}throw err}
  return result
}
exports.main=async(e={})=>{
  try {
    const openid=cloud.getWXContext().OPENID
    // Timer invocation has no user OPENID. User-supplied action cannot enter maintenance.
    if(!openid&&e.Type==='Timer'&&e.TriggerName==='scheduleMaintenance'){
      await notifications.pending()
      return {ok:true}
    }
    if(e.action==='getSharedByToken'){
      const {share,family}=await shared(e.token)
      const result=await list(share.familyId,share.date,e.cursor,e.limit)
      await shared(e.token)
      return {...result,items:result.items.map(R.publicItem),familyName:family.name,date:share.date,expiresAt:share.expiresAt}
    }
    const {family,member}=await context(e.familyId,openid)
    if(e.action==='notificationConfig')return {templateId:process.env.SCHEDULE_TEMPLATE_ID||''}
    if(['create','update','setStatus','delete'].includes(e.action)){
      const result=await mutate(e,openid)
      try {
        await notifications.pending(e.familyId,result.item._id)
        if(result.notificationStatus==='pending'){
          const tasks=await db.collection('co_schedule_notify').where({scheduleId:result.item._id,eventVersion:result.item.version}).get()
          result.notificationStatus=tasks.data.every(t=>t.status==='sent'||t.status==='cancelled')?'sent':'unavailable'
        }
      } catch(_) { result.notificationStatus='unavailable' }

      return result
    }
    if(e.action==='listByDate')return await list(e.familyId,e.date,e.cursor,e.limit)
    if(e.action==='getDetail'||e.action==='listEvents') {
      const item=await read(db,'co_schedule',e.scheduleId)
      if(!item||item.familyId!==e.familyId||item.deletedAt)R.fail('NOT_FOUND','日程不存在')
      if(e.action==='getDetail')return {item:(await decorate([item]))[0],permissions:R.permissions(member,item)}
      const offset=Math.max(0,parseInt(e.cursor,10)||0)
      const r=await db.collection('co_schedule_event').where({familyId:e.familyId,scheduleId:e.scheduleId}).orderBy('createdAt','desc').orderBy('_id','desc').skip(offset).limit(20).get()
      const events=await Promise.all(r.data.map(async event=>{
        const members=await db.collection('co_member').where({familyId:e.familyId,openid:event.actorOpenid}).limit(1).get()
        return {...event,actorName:members.data[0]?(members.data[0].nickName||'家人'):'已离开的家人'}
      }))
      return {events,nextCursor:r.data.length===20?String(offset+20):null}
    }
    if(e.action==='listRecentPlaces') {
      const places=new Set();let offset=0
      while(places.size<10){
        const r=await db.collection('co_schedule').where({familyId:e.familyId,deletedAt:null}).orderBy('updatedAt','desc').orderBy('_id','desc').skip(offset).limit(100).get()
        for(const item of r.data){if(item.place)places.add(item.place);if(places.size===10)break}
        if(r.data.length<100)break
        offset+=100
      }
      return {places:[...places]}
    }
    if(e.action==='createShareToken') {
      R.date(e.date)
      const token=crypto.randomBytes(24).toString('base64').replace(/\+/g,'-').replace(/\//g,'_'), now=Date.now(),expiresAt=now+7*86400000
      const tx=await db.startTransaction()
      try {
        const fresh=await context(e.familyId,openid,tx)
        await tx.collection('co_schedule_share').add({data:{tokenHash:hash(token),familyId:e.familyId,date:e.date,createdBy:openid,createdAt:now,expiresAt,shareEpoch:fresh.family.shareEpoch||0}})
        await tx.collection('co_family').doc(e.familyId).update({data:{mutationVersion:(fresh.family.mutationVersion||0)+1}})
        await tx.commit()
      }catch(err){try{await tx.rollback()}catch(_){}throw err}
      return {token,expiresAt,title:family.name+' '+e.date+'的接送安排',path:'/pages/schedule/readonly?token='+token}
    }
    if(e.action==='generateShareCode') {
      const {share}=await shared(e.token)
      if(share.familyId!==e.familyId)R.fail('NO_PERMISSION','无权生成此分享码')
      try {
        const r=await cloud.openapi.wxacode.getUnlimited({scene:e.token,page:'pages/schedule/readonly',checkPath:true,width:280})
        if(!r.buffer)throw {errCode:r.errCode||r.errcode}
        return {imageBase64:r.buffer.toString('base64')}
      } catch(cause) {
        const raw=cause.errCode===undefined?cause.errcode:cause.errCode
        const platformCode=/^-?\d+$/.test(String(raw))?String(raw):'UNKNOWN'
        const message=platformCode==='85412'
          ? '个人小程序尚未完成主体认证，暂时无法生成小程序码。请管理员在微信小程序后台完成主体认证（85412）'
          : '小程序码生成失败，请管理员根据平台错误码排查（'+platformCode+'）'
        throw Object.assign(new Error(message),{code:'SHARE_CODE_FAILED',platformCode})
      }
    }
    R.fail('BAD_ACTION','未知操作')
  }catch(err){console.warn('[schedule]',e.action,err.code||'SERVER_ERROR',err.platformCode||'');return {error:{code:err.code||'SERVER_ERROR',message:err.code?err.message:'服务暂时不可用，请重试',...(err.platformCode?{platformCode:err.platformCode}:{})}}}
}
