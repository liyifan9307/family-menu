const auth=require('./auth')
// 业务日期按北京时间计算，避免设备时区改变日程归属日期。
function today(){return new Date(Date.now()+8*3600000).toISOString().slice(0,10)}
function shift(date,days){return new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10)}
function requestId(){return Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)}
// familyId 默认取当前家庭，跨页异步流程可显式传入打开页面时的家庭。
async function call(action,data={}) {
  const r=await wx.cloud.callFunction({name:'scheduleService',data:{familyId:auth.getCurrentFamilyId(),...data,action}})
  const result=r&&r.result
  if(!result)throw Error('服务无返回，请重试')
  if(result.error)throw Object.assign(new Error(result.error.message),{code:result.error.code})
  return result
}
// 列表和图片需要完整日程，按服务端返回的游标逐页读取。
async function all(action,data){let items=[],cursor;do{const r=await call(action,{...data,cursor,limit:50});items=items.concat(r.items);cursor=r.nextCursor;if(!cursor)return {...r,items}}while(cursor)}
const labels={pending:'待办',done:'已完成',cancelled:'已取消'}
function display(items){return items.map(i=>({...i,statusLabel:labels[i.status]||i.status}))}
function lost(err){return ['NOT_MEMBER','FAMILY_NOT_FOUND','FAMILY_DISSOLVING'].includes(err.code)}
function handleLost(){wx.reLaunch({url:'/pages/identity/identity'})}
module.exports={today,shift,requestId,call,all,display,lost,handleLost}
