const S=require('../../utils/schedule')
const auth=require('../../utils/auth')
Page({
 data:{date:'',items:[],loading:true,error:'',detail:null,permissions:{},events:[],eventCursor:null,sharing:false,shareReady:false,busy:false,templateId:''},
 onLoad(){this.setData({date:S.today()});wx.hideShareMenu();S.call('notificationConfig').then(r=>this.setData({templateId:r.templateId})).catch(()=>{})},
 subscribe(){if(!this.data.templateId){wx.showToast({title:'通知服务尚未配置',icon:'none'});return}wx.requestSubscribeMessage({tmplIds:[this.data.templateId],success:r=>wx.showToast({title:r[this.data.templateId]==='accept'?'已授权接收通知':'未开启通知',icon:'none'}),fail:()=>wx.showToast({title:'授权未完成，请重试',icon:'none'})})},
 onShow(){this.reload()},
 onHide(){this.seq=(this.seq||0)+1},
 async reload(){
  const seq=this.seq=(this.seq||0)+1,familyId=auth.getCurrentFamilyId(),date=this.data.date||S.today()
  this.setData({loading:true,error:'',items:[],detail:null,shareReady:false});this.share=null;wx.hideShareMenu()
  try{const r=await S.all('listByDate',{date,familyId});if(seq!==this.seq||familyId!==auth.getCurrentFamilyId())return;this.setData({items:S.display(r.items),loading:false})}
  catch(e){if(seq!==this.seq)return;this.setData({error:e.message,loading:false});if(S.lost(e))S.handleLost()}
 },
 onPullDownRefresh(){return this.reload().finally(()=>wx.stopPullDownRefresh())},
 changeDate(e){this.setData({date:S.shift(this.data.date,Number(e.currentTarget.dataset.days))});this.reload()},
 today(){this.setData({date:S.today()});this.reload()},
 add(){wx.navigateTo({url:'/pages/schedule/edit?date='+this.data.date})},
 async open(e){try{const seq=this.seq;const r=await S.call('getDetail',{scheduleId:e.currentTarget.dataset.id});if(seq!==this.seq)return;this.setData({detail:S.display([r.item])[0],permissions:r.permissions,events:[],eventCursor:null});this.moreEvents()}catch(e){wx.showToast({title:e.message,icon:'none'})}},
 close(){if(!this.data.busy)this.setData({detail:null})},
 noop(){},
 edit(){wx.navigateTo({url:'/pages/schedule/edit?id='+this.data.detail._id})},
 async moreEvents(){const id=this.data.detail&&this.data.detail._id;if(!id)return;try{const r=await S.call('listEvents',{scheduleId:id,cursor:this.data.eventCursor});if(!this.data.detail||this.data.detail._id!==id)return;const names={create:'新增',update:'修改',setStatus:'状态变更',delete:'删除'};this.setData({events:this.data.events.concat(r.events.map(e=>({...e,label:names[e.action],time:new Date(e.createdAt+8*3600000).toISOString().slice(0,16).replace('T',' ')}))),eventCursor:r.nextCursor})}catch(e){wx.showToast({title:e.message,icon:'none'})}},
 action(e){const action=e.currentTarget.dataset.action,targetStatus=e.currentTarget.dataset.status;wx.showModal({title:action==='delete'?'删除这条安排？':'确认修改状态？',content:action==='delete'?'删除后不再显示，无法在页面恢复。':'家人将看到更新后的状态。',success:r=>{if(r.confirm)this.mutate(action,targetStatus)}})},
 async mutate(action,targetStatus){if(this.data.busy)return;const item=this.data.detail;this.setData({busy:true});const payload={action,scheduleId:item._id,expectedVersion:item.version,targetStatus};const key=JSON.stringify(payload);if(!this.pending||this.pending.key!==key)this.pending={key,id:S.requestId()};try{const r=await S.call(action,{...payload,requestId:this.pending.id});this.pending=null;wx.showToast({title:r.notificationStatus==='unavailable'?'已保存，部分家人未收到通知，可分享安排':'已保存',icon:'none'});await this.reload()}catch(e){wx.showModal({title:'操作未完成',content:e.message,showCancel:false});if(S.lost(e))S.handleLost()}finally{this.setData({busy:false})}},
 async prepareShare(){if(this.data.sharing)return;const seq=this.seq,date=this.data.date,familyId=auth.getCurrentFamilyId();this.setData({sharing:true});try{const share=await S.call('createShareToken',{date,familyId});if(seq!==this.seq||date!==this.data.date||familyId!==auth.getCurrentFamilyId())return;this.share=share;this.setData({shareReady:true});wx.showShareMenu({menus:['shareAppMessage']})}catch(e){wx.showToast({title:e.message,icon:'none'})}finally{this.setData({sharing:false})}},
 onShareAppMessage(){return this.share?{title:this.share.title||this.data.date+'的接送安排',path:this.share.path}:{title:'我的家',path:'/pages/home/home'}},
 image(){wx.navigateTo({url:'/pages/schedule/share?date='+this.data.date})},
})
