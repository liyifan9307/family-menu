const S=require('../../utils/schedule'),api=require('../../utils/api'),auth=require('../../utils/auth')
Page({
 data:{loading:true,error:'',form:{date:'',timeStart:'',timeEnd:'',title:'',place:'',childName:'',note:'',ownerOpenid:''},members:[],ownerIndex:0,places:[],more:false,saving:false,fieldError:'',conflict:false,unknown:false},
 onLoad(options){this.id=options.id;this.familyId=auth.getCurrentFamilyId();this.initialDate=options.date||S.today();this.load()},
 onShow(){if(this.familyId&&this.familyId!==auth.getCurrentFamilyId()){this.setData({form:{},error:'家庭已切换，请返回重新进入'});this.invalid=true}},
 async load(){const seq=this.seq=(this.seq||0)+1;const valid=()=>seq===this.seq&&!this.invalid&&this.familyId===auth.getCurrentFamilyId();try{const f=await api.getFamily(this.familyId);if(!valid())return;let form=this.data.form;const now=new Date(Date.now()+8*3600000),hour=now.getUTCHours();form={...form,date:this.initialDate,timeStart:hour===23?'23:59':String(hour+1).padStart(2,'0')+':00',ownerOpenid:(auth.getCachedMember()||{}).openid};if(this.id){const r=await S.call('getDetail',{familyId:this.familyId,scheduleId:this.id});if(!r.permissions.edit)throw Error('无权编辑此安排');if(!valid())return;form=r.item;this.version=r.item.version}this.setData({form,members:f.members,ownerIndex:Math.max(0,f.members.findIndex(m=>m.openid===form.ownerOpenid)),loading:false,error:''});const r=await S.call('listRecentPlaces',{familyId:this.familyId});if(valid())this.setData({places:r.places})}catch(e){if(!valid())return;this.setData({loading:false,error:e.message});if(S.lost(e))S.handleLost()}},
 input(e){this.setData({['form.'+e.currentTarget.dataset.field]:e.detail.value,fieldError:''})},
 selectOwner(e){this.owner({detail:{value:e.currentTarget.dataset.index}})},
 owner(e){const index=Number(e.detail.value);this.setData({ownerIndex:index,'form.ownerOpenid':this.data.members[index].openid})},
 place(e){this.setData({'form.place':e.currentTarget.dataset.place})},
 more(){this.setData({more:!this.data.more})},
 async save(){if(this.data.saving||this.invalid)return;const f=this.data.form;const max={title:30,place:50,childName:20,note:200};let message='';for(const key of Object.keys(max))if(Array.from((f[key]||'').trim()).length>max[key])message='内容超出字数限制';if(!f.title.trim())message='请填写事项';if(!f.date||!f.timeStart)message='请选择日期和开始时间';if(f.timeEnd&&f.timeEnd<=f.timeStart)message='结束时间须晚于开始时间';if(message){this.setData({fieldError:message});return}
 const fields={};for(const k of ['date','timeStart','timeEnd','title','place','childName','note','ownerOpenid'])fields[k]=f[k]||''
 const payload={familyId:this.familyId,fields,scheduleId:this.id,expectedVersion:this.version},key=JSON.stringify(payload)
 if(this.pending&&this.pending.key!==key){this.setData({fieldError:'上次保存结果待确认，请先恢复原内容重试，避免重复创建'});return}
 if(!this.pending)this.pending={key,id:S.requestId(),payload}
 this.setData({saving:true,fieldError:''})
 try{const r=await S.call(this.id?'update':'create',{...payload,requestId:this.pending.id});this.pending=null;wx.showToast({title:r.notificationStatus==='unavailable'?'已保存，部分家人未收到通知，可分享安排':'已保存',icon:'none'});wx.navigateBack()}
 catch(e){if(e.code&&e.code!=='SERVER_ERROR')this.pending=null;this.setData({fieldError:e.message||'保存失败，内容已保留',conflict:e.code==='VERSION_CONFLICT',unknown:!!this.pending});if(S.lost(e))S.handleLost()}
 finally{this.setData({saving:false})}
 },
 async confirmPending(){if(!this.pending||this.data.saving)return;this.setData({saving:true});try{const r=await S.call(this.id?'update':'create',{...this.pending.payload,requestId:this.pending.id});this.pending=null;this.setData({unknown:false});wx.showModal({title:'已确认保存成功',content:'上次提交的安排已保存。当前后来修改的内容未提交，可返回列表后再次编辑。',showCancel:false,success:()=>wx.navigateBack()})}catch(e){if(e.code&&e.code!=='SERVER_ERROR'){this.pending=null;this.setData({unknown:false})}this.setData({fieldError:e.message})}finally{this.setData({saving:false})}},
 async latest(){try{const r=await S.call('getDetail',{familyId:this.familyId,scheduleId:this.id});if(this.invalid)return;wx.showModal({title:'家人更新后的安排',content:r.item.date+' '+r.item.timeStart+' '+r.item.title+'；'+(r.item.place||'未填写地点')+'。确认后保留你的草稿，下一次保存将覆盖这些字段。',confirmText:'保留草稿',success:answer=>{if(answer.confirm){this.version=r.item.version;this.pending=null;this.setData({conflict:false,fieldError:'已读取最新版本，请核对草稿后保存'})}}})}catch(e){this.setData({fieldError:e.message})}}
})
