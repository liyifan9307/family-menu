const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs')
function setup(){
 const data={co_family:{f:{_id:'f',name:'家',ownerOpenid:'a'}},co_member:{a:{_id:'a',familyId:'f',openid:'a',role:'admin',status:'active'},b:{_id:'b',familyId:'f',openid:'b',role:'member',status:'active'}}};let next=0,openid='a'
 function matches(row,query){return Object.entries(query).every(([k,v])=>v&&typeof v==='object'&&v.op?v.op==='lte'?row[k]<=v.value:row[k]>v.value:row[k]===v)}
 function collection(name){data[name] ||= {};let query={},limit=100,offset=0,sort=[];const api={
  doc(id){return {get:async()=>({data:structuredClone(data[name][id]||null)}),set:async({data:d})=>{data[name][id]={...structuredClone(d),_id:id}},update:async({data:d})=>{Object.assign(data[name][id],structuredClone(d))},remove:async()=>{delete data[name][id]}}},
  where(q){query=q;return api},limit(n){limit=n;return api},skip(n){offset=n;return api},orderBy(k,dir){sort.push([k,dir]);return api},
  async get(){let rows=Object.values(data[name]).filter(r=>matches(r,query));rows.sort((a,b)=>{for(const [k,d]of sort){if(a[k]!==b[k])return(a[k]<b[k]?-1:1)*(d==='desc'?-1:1)}return 0});return {data:structuredClone(rows.slice(offset,offset+limit))}},
  async add({data:d}){const id='id'+ ++next;data[name][id]={...structuredClone(d),_id:id};return {_id:id}}
 };return api}
 const db={collection,command:{lte:value=>({op:'lte',value}),gt:value=>({op:'gt',value})},async startTransaction(){const before=structuredClone(data);return {collection,commit:async()=>{},rollback:async()=>{for(const k of Object.keys(data))delete data[k];Object.assign(data,before)}}}}
 const cloud={DYNAMIC_CURRENT_ENV:'test',init(){},database:()=>db,getWXContext:()=>({OPENID:openid}),openapi:{security:{msgSecCheck:async()=>({result:{suggest:'pass'}})},subscribeMessage:{send:async()=>({errCode:0})}}}
 const module={exports:{}};vm.runInNewContext(fs.readFileSync('cloudfunctions/scheduleService/index.js','utf8'),{require:n=>n==='wx-server-sdk'?cloud:n==='./rules'?require('../cloudfunctions/scheduleService/rules'):n==='./notifications'?require('../cloudfunctions/scheduleService/notifications'):require(n),exports:module.exports,console,Buffer,process:{env:{}},Date})
 return {data,cloud,call:module.exports.main,as:id=>openid=id}
}
const fields={date:'2026-11-25',timeStart:'08:00',title:'接娃',ownerOpenid:'a'}
test('同请求重试只产生一条日程和事件；不同内容拒绝',async()=>{const s=setup();const event={action:'create',familyId:'f',requestId:'request-001',fields};const a=await s.call(event),b=await s.call(event);assert.equal(a.item._id,b.item._id);assert.equal(Object.keys(s.data.co_schedule).length,1);assert.equal(Object.keys(s.data.co_schedule_event).length,1);const c=await s.call({...event,fields:{...fields,title:'修改'}});assert.equal(c.error.code,'IDEMPOTENCY_CONFLICT')})
test('并发版本不匹配不覆盖已有内容',async()=>{const s=setup();const a=await s.call({action:'create',familyId:'f',requestId:'request-001',fields});const r=await s.call({action:'update',familyId:'f',requestId:'request-002',scheduleId:a.item._id,expectedVersion:9,fields:{title:'覆盖'}});assert.equal(r.error.code,'VERSION_CONFLICT');assert.equal(s.data.co_schedule[a.item._id].title,'接娃')})
test('非成员不能列出数据，普通成员不能编辑他人数据',async()=>{const s=setup();const a=await s.call({action:'create',familyId:'f',requestId:'request-001',fields});s.as('outsider');assert.equal((await s.call({action:'listByDate',familyId:'f',date:fields.date})).error.code,'NOT_MEMBER');s.as('b');assert.equal((await s.call({action:'update',familyId:'f',requestId:'request-002',scheduleId:a.item._id,expectedVersion:1,fields:{title:'改'}})).error.code,'NO_PERMISSION')})
test('访客只读取绑定日期，成员移除撤销旧链接',async()=>{const s=setup();await s.call({action:'create',familyId:'f',requestId:'request-001',fields});const share=await s.call({action:'createShareToken',familyId:'f',date:fields.date});s.as('visitor');const r=await s.call({action:'getSharedByToken',token:share.token,date:'2099-01-01'});assert.equal(r.items.length,1);assert.equal(r.items[0].ownerOpenid,undefined);s.data.co_family.f.shareEpoch=1;assert.equal((await s.call({action:'getSharedByToken',token:share.token})).error.code,'SHARE_INVALID')})
test('通知模板缺失不回滚保存',async()=>{const s=setup();const r=await s.call({action:'create',familyId:'f',requestId:'request-001',fields:{...fields,ownerOpenid:'b'}});assert.ok(r.item);assert.equal(r.notificationStatus,'unavailable');assert.equal(Object.keys(s.data.co_schedule).length,1)})
test('已提交后通知查询失败仍返回保存成功',async()=>{const s=setup();const r=await s.call({action:'create',familyId:'f',requestId:'request-001',fields:{...fields,ownerOpenid:'b'}});assert.ok(r.item);delete s.data.co_schedule_notify;const retry=await s.call({action:'create',familyId:'f',requestId:'request-001',fields:{...fields,ownerOpenid:'b'}});assert.ok(retry.item)})

test('内容校验不通过不写入日程',async()=>{const s=setup();s.cloud.openapi.security.msgSecCheck=async()=>({result:{suggest:'risky'}});const r=await s.call({action:'create',familyId:'f',requestId:'request-001',fields});assert.equal(r.error.code,'TEXT_RISK');assert.equal(Object.keys(s.data.co_schedule||{}).length,0)})

test('小程序码接口失败时返回明确阶段与平台错误码',async()=>{
 const s=setup()
 s.cloud.openapi.wxacode={getUnlimited:async()=>{throw Object.assign(new Error('platform failure'),{errCode:41030})}}
 await s.call({action:'create',familyId:'f',requestId:'request-001',fields})
 const share=await s.call({action:'createShareToken',familyId:'f',date:fields.date})
 const r=await s.call({action:'generateShareCode',familyId:'f',token:share.token})
 assert.equal(r.error.code,'SHARE_CODE_FAILED')
 assert.equal(r.error.platformCode,'41030')
 assert.match(r.error.message,/小程序码/)
 assert.equal(JSON.stringify(r).includes(share.token),false)
})

test('85412明确提示主体认证，不误导检查页面发布',async()=>{
 const s=setup()
 s.cloud.openapi.wxacode={getUnlimited:async()=>{throw {errCode:85412}}}
 await s.call({action:'create',familyId:'f',requestId:'request-001',fields})
 const share=await s.call({action:'createShareToken',familyId:'f',date:fields.date})
 const r=await s.call({action:'generateShareCode',familyId:'f',token:share.token})
 assert.match(r.error.message,/主体认证/)
 assert.doesNotMatch(r.error.message,/页面发布/)
 assert.equal(r.error.platformCode,'85412')
})

test('空日期不能生成分享链接，已删除的安排不计入',async()=>{
 const s=setup()
 const share={action:'createShareToken',familyId:'f',date:fields.date}
 assert.equal((await s.call(share)).error.code,'EMPTY_DAY')
 const created=await s.call({action:'create',familyId:'f',requestId:'request-001',fields})
 s.data.co_schedule[created.item._id].deletedAt=Date.now()
 assert.equal((await s.call(share)).error.code,'EMPTY_DAY')
 assert.equal(Object.keys(s.data.co_schedule_share||{}).length,0)
})

test('家庭事项允许只写标题与日期，可直接完成并分享给家人',async()=>{
 const s=setup()
 const task=await s.call({action:'create',familyId:'f',requestId:'simple-task',fields:{date:fields.date,title:'买牛奶'}})
 assert.equal(task.item.timeStart,'')
 assert.equal(task.item.ownerOpenid,'')
 assert.equal(task.item.requiresConfirmation,false)
 const done=await s.call({action:'setStatus',familyId:'f',requestId:'simple-done',scheduleId:task.item._id,expectedVersion:1,targetStatus:'done'})
 assert.equal(done.item.status,'done')
 const share=await s.call({action:'createShareToken',familyId:'f',date:fields.date})
 const result=await s.call({action:'getSharedByToken',token:share.token})
 assert.equal(result.items[0].ownerName,'未指定负责人')
 assert.equal(result.items[0].status,'done')
})

test('负责人确认与完成分开，只有接任人接受才能更换负责人',async()=>{
 const s=setup()
 const task=await s.call({action:'create',familyId:'f',requestId:'confirm-task',fields:{...fields,requiresConfirmation:true}})
 const mutate=(action,expectedVersion,values={})=>s.call({familyId:'f',scheduleId:task.item._id,requestId:action+'-'+expectedVersion,action,expectedVersion,...values})
 assert.equal((await mutate('setStatus',1,{targetStatus:'done'})).error.code,'NO_PERMISSION')
 assert.equal((await mutate('confirmOwner',1)).item.ownerConfirmed,true)
 assert.equal((await mutate('update',2,{fields:{ownerOpenid:'b'}})).error.code,'HANDOFF_REQUIRED')
 const requested=await mutate('requestHandoff',2,{targetOpenid:'b'})
 assert.equal(requested.item.ownerOpenid,'a')
 assert.equal(requested.item.ownerConfirmed,true)
 assert.equal((await mutate('update',3,{fields:{requiresConfirmation:false}})).error.code,'HANDOFF_PENDING')
 assert.equal((await mutate('acceptHandoff',3)).error.code,'NO_PERMISSION')
 const share=await s.call({action:'createShareToken',familyId:'f',date:fields.date})
 const publicView=await s.call({action:'getSharedByToken',token:share.token})
 assert.equal(publicView.items[0].handoffPending,true)
 assert.equal(publicView.items[0].handoff,undefined)
 s.as('b')
 assert.equal((await mutate('declineHandoff',3)).item.ownerOpenid,'a')
 s.as('a')
 await mutate('requestHandoff',4,{targetOpenid:'b'})
 s.as('b')
 const accepted=await mutate('acceptHandoff',5)
 assert.equal(accepted.item.ownerOpenid,'b')
 assert.equal(accepted.item.ownerConfirmed,true)
 assert.equal(accepted.item.status,'pending')
 assert.equal((await mutate('acceptHandoff',5)).item.version,accepted.item.version)
 s.as('a')
 assert.equal((await mutate('setStatus',6,{targetStatus:'done'})).error.code,'NO_PERMISSION')
 s.as('b')
 const done=await mutate('setStatus',6,{targetStatus:'done'})
 assert.equal(done.item.status,'done')
 assert.equal(done.item.ownerConfirmed,true)
})

test('接任人退出再加入和原负责人先完成都会使旧邀请失效',async()=>{
 const s=setup()
 const task=await s.call({action:'create',familyId:'f',requestId:'expire-task',fields:{...fields,requiresConfirmation:true}})
 const mutate=(action,expectedVersion,values={})=>s.call({familyId:'f',scheduleId:task.item._id,requestId:action+'-'+expectedVersion,action,expectedVersion,...values})
 await mutate('confirmOwner',1)
 await mutate('requestHandoff',2,{targetOpenid:'b'})
 s.data.co_member.b.joinedAt=new Date()
 s.as('b')
 assert.equal((await mutate('acceptHandoff',3)).error.code,'HANDOFF_UNAVAILABLE')
 s.as('a')
 assert.equal((await mutate('requestHandoff',3,{targetOpenid:'b'})).item.ownerOpenid,'a')
 await mutate('setStatus',4,{targetStatus:'done'})
 s.as('b')
 assert.equal((await mutate('acceptHandoff',5)).error.code,'HANDOFF_UNAVAILABLE')
})
