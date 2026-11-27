const cloud=require('wx-server-sdk')
const crypto=require('crypto')
const R=require('./rules')
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV})
const db=cloud.database({throwOnNotFound:false})
const notifications=require('./notifications')(cloud,db)
const hash=s=>crypto.createHash('sha256').update(s).digest('hex')
const read=async(store,table,id)=>{const r=await store.collection(table).doc(id).get();return r.data||null}
// 普通日程请求先校验家庭状态和有效成员关系，写事务内重新校验。
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
async function activeMember(familyId,openid,store=db) {
  if(!openid)return null
  const r=await db.collection('co_member').where({familyId,openid,status:'active'}).limit(1).get()
  const found=r.data[0]
  const member=found&&(store===db?found:await read(store,'co_member',found._id))
  return member&&member.status==='active'?member:null
}

const joinedAt=member=>member.joinedAt?new Date(member.joinedAt).getTime():0

async function pendingHandoff(item,store=db) {
  const invite=item.handoff
  if(!invite)return null
  const target=await activeMember(item.familyId,invite.targetOpenid,store)
  // 重新加入不能恢复上一次成员关系中的旧邀请。
  return target&&joinedAt(target)===invite.joinedAt?{...invite,targetName:target.nickName||'家人'}:null
}

async function decorate(items) {
  return Promise.all(items.map(async item=>{
    const [owner,handoff]=await Promise.all([activeMember(item.familyId,item.ownerOpenid),pendingHandoff(item)])
    return {...item,handoff,handoffPending:!!handoff,
      ownerName:owner?(owner.nickName||'家人'):item.ownerOpenid?'负责人已离开，请重新安排':'未指定负责人',
      ownerUnavailable:!!item.ownerOpenid&&!owner,ownerColor:owner?owner.color:'#657368'}
  }))
}

async function applyOwnership(item,previous,fields,tx) {
  if(fields.ownerOpenid!==undefined&&typeof fields.ownerOpenid!=='string')R.fail('BAD_PARAM','负责人格式无效')
  if(fields.requiresConfirmation!==undefined&&typeof fields.requiresConfirmation!=='boolean')R.fail('BAD_PARAM','确认设置无效')
  const owner=fields.ownerOpenid??previous?.ownerOpenid??''
  const required=fields.requiresConfirmation??previous?.requiresConfirmation??false
  if(previous?.requiresConfirmation&&owner!==(previous.ownerOpenid||''))R.fail('HANDOFF_REQUIRED','请在事项详情发起换人')
  if(!required&&previous?.requiresConfirmation&&await pendingHandoff(previous,tx))R.fail('HANDOFF_PENDING','请先处理或撤回换人邀请')
  if(required&&!owner)R.fail('BAD_PARAM','开启确认时须指定负责人')
  if(required&&!previous?.requiresConfirmation&&item.status!=='pending')R.fail('BAD_PARAM','请先恢复待处理，再开启确认')
  if(owner&&(!previous||owner!==previous.ownerOpenid||required&&!previous.requiresConfirmation)&&
      !await activeMember(item.familyId,owner,tx))R.fail('BAD_PARAM','请选择有效负责人')
  item.ownerOpenid=owner
  item.requiresConfirmation=required
  item.ownerConfirmed=required&&previous?.requiresConfirmation===true&&previous.ownerConfirmed===true
  if(!required)item.handoff=null
}

async function applyHandoff(e,item,member,permissions,tx) {
  if(!item.requiresConfirmation||item.status!=='pending')R.fail('HANDOFF_UNAVAILABLE','当前事项无法确认或交接')
  if(e.action==='confirmOwner'){
    if(!permissions.confirmOwner)R.fail('NO_PERMISSION','仅当前负责人可确认')
    item.ownerConfirmed=true
    return
  }
  const invite=await pendingHandoff(item,tx)
  if(e.action==='requestHandoff'){
    if(!permissions.requestHandoff)R.fail('NO_PERMISSION','无权发起换人')
    if(invite)R.fail('HANDOFF_PENDING','已有待答复的换人邀请')
    if(typeof e.targetOpenid!=='string'||e.targetOpenid===item.ownerOpenid)R.fail('BAD_PARAM','请选择其他家庭成员')
    const target=await activeMember(item.familyId,e.targetOpenid,tx)
    if(!target)R.fail('BAD_PARAM','请选择有效家庭成员')
    item.handoff={targetOpenid:e.targetOpenid,requestedBy:member.openid,joinedAt:joinedAt(target)}
    return
  }
  if(!invite)R.fail('HANDOFF_UNAVAILABLE','换人邀请已失效')
  if(e.action==='withdrawHandoff'){
    if(invite.requestedBy!==member.openid)R.fail('NO_PERMISSION','仅发起人可撤回邀请')
  }else{
    if(invite.targetOpenid!==member.openid)R.fail('NO_PERMISSION','仅接任人可答复')
    if(e.action==='acceptHandoff'){
      item.ownerOpenid=member.openid
      item.ownerConfirmed=true
    }
  }
  item.handoff=null
}

const handoffActions=['confirmOwner','requestHandoff','acceptHandoff','declineHandoff','withdrawHandoff']
// 数据库只保存分享凭证的摘要。家庭分享版本递增后，旧凭证会一并失效。
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
  // 游标绑定家庭和日期，同一时间的日程再按文档 ID 排序，避免翻页漏项。
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
  const payload={action:e.action,scheduleId:e.scheduleId||null,expectedVersion:e.expectedVersion||null,fields:e.fields||null,targetStatus:e.targetStatus||null,reason:e.reason||'',...(e.targetOpenid?{targetOpenid:e.targetOpenid}:{})}
  const fingerprint=hash(JSON.stringify(payload)), rid=hash(`${e.familyId}:${openid}:${e.requestId}`)
  const tx=await db.startTransaction()
  let result
  try {
    const {family,member}=await context(e.familyId,openid,tx)
    // 网络中断后可能已经提交。相同请求编号和内容直接复用原结果。
    const prior=await read(tx,'co_schedule_request',rid)
    if(prior){if(prior.payloadHash!==fingerprint)R.fail('IDEMPOTENCY_CONFLICT','请勿修改待确认请求');await tx.rollback();return prior.result}
    const now=Date.now()
    let previous=null, item
    if(e.action==='create') {
      item={...R.validate(e.fields||{}),familyId:e.familyId,createdBy:openid,createdAt:now,status:'pending',deletedAt:null,version:1}
    } else {
      previous=await read(tx,'co_schedule',e.scheduleId)
      if(!previous||previous.familyId!==e.familyId||previous.deletedAt)R.fail('NOT_FOUND','事项不存在')
      const p=R.permissions(member,previous)
      if(!handoffActions.includes(e.action)&&!(e.action==='setStatus'?(e.targetStatus==='done'?p.complete:p.status):p.edit))R.fail('NO_PERMISSION','无权执行此操作')
      // 拒绝覆盖家人刚保存的新版本，客户端可保留草稿供核对。
      if(previous.version!==e.expectedVersion)R.fail('VERSION_CONFLICT','家人已更新这条安排，请查看最新内容')
      item={...previous,version:previous.version+1}
      if(e.action==='update')item={...item,...R.validate({...previous,...e.fields})}
      if(handoffActions.includes(e.action))await applyHandoff(e,item,member,p,tx)
      if(e.action==='setStatus') {
        if(!['pending','done','cancelled'].includes(e.targetStatus)||e.targetStatus===previous.status||(previous.status!=='pending'&&e.targetStatus!=='pending'))R.fail('BAD_PARAM','请先恢复待处理，再修改状态')
        item.status=e.targetStatus
        item.handoff=null
        if(item.status==='pending')item.ownerConfirmed=false
      }
      if(e.action==='delete'){item.deletedAt=now;item.deletedBy=openid;item.handoff=null}
    }
    if(e.action==='create'||e.action==='update') {
      await applyOwnership(item,previous,e.fields||{},tx)
      // 新增和编辑必须通过微信内容检查。接口异常时中止写入，客户端保留草稿。
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
    // 通知涉及的负责人、接任人和发起人，排除重复收件人与操作者。
    const recipients=[...new Set([item.ownerOpenid,previous?.ownerOpenid,item.handoff?.targetOpenid,previous?.handoff?.requestedBy])]
      .filter(id=>id&&id!==openid)
    for(const recipientOpenid of recipients)await tx.collection('co_schedule_notify').add({data:{familyId:e.familyId,scheduleId:item._id,eventVersion:item.version,recipientOpenid,kind:e.action,status:'pending',attempts:0,nextAttemptAt:now,createdAt:now}})
    // 与成员变更和解散操作更新同一家庭文档，让并发事务发生冲突。
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
    // 定时维护由云端触发，普通用户调用带有 OPENID。
    if(!openid&&e.Type==='Timer'&&e.TriggerName==='scheduleMaintenance'){
      await notifications.pending()
      return {ok:true}
    }
    if(e.action==='getSharedByToken'){
      const {share,family}=await shared(e.token)
      const result=await list(share.familyId,share.date,e.cursor,e.limit)
      // 查询期间成员可能被移除，返回数据前再次验证分享凭证。
      await shared(e.token)
      return {...result,items:result.items.map(R.publicItem),familyName:family.name,date:share.date,expiresAt:share.expiresAt}
    }
    const {family,member}=await context(e.familyId,openid)
    if(e.action==='notificationConfig')return {templateId:process.env.SCHEDULE_TEMPLATE_ID||''}
    if(['create','update','setStatus','delete',...handoffActions].includes(e.action)){
      // 先提交日程与通知任务。发送失败仅影响通知结果，不撤销日程。
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
      if(!item||item.familyId!==e.familyId||item.deletedAt)R.fail('NOT_FOUND','事项不存在')
      if(e.action==='getDetail'){
        const view=(await decorate([item]))[0]
        return {item:view,permissions:{
          ...R.permissions(member,item),
          replyHandoff:view.handoff?.targetOpenid===openid,
          withdrawHandoff:view.handoff?.requestedBy===openid,
        }}
      }
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
        // 日程写入也会更新家庭版本，避免在最后一条安排被删除时生成空链接。
        const rows=await db.collection('co_schedule').where({familyId:e.familyId,date:e.date,deletedAt:null}).limit(1).get()
        if(!rows.data.length)R.fail('EMPTY_DAY','当天没有可分享的安排')
        await tx.collection('co_schedule_share').add({data:{tokenHash:hash(token),familyId:e.familyId,date:e.date,createdBy:openid,createdAt:now,expiresAt,shareEpoch:fresh.family.shareEpoch||0}})
        await tx.collection('co_family').doc(e.familyId).update({data:{mutationVersion:(fresh.family.mutationVersion||0)+1}})
        await tx.commit()
      }catch(err){try{await tx.rollback()}catch(_){}throw err}
      return {token,expiresAt,title:family.name+' '+e.date+'的家庭安排',path:'/pages/schedule/readonly?token='+token}
    }
    // 保留带码分享接口供后续使用。当前纯图片流程直接读取家庭日程。
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
