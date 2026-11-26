const S=require('../../utils/schedule'),auth=require('../../utils/auth'),api=require('../../utils/api')
Page({data:{loading:true,error:'',images:[],saving:false,date:'',height:1200},onLoad(o){this.familyId=auth.getCurrentFamilyId();this.setData({date:o.date||S.today()});this.build()},onShow(){if(this.familyId!==auth.getCurrentFamilyId()){this.invalid=true;this.setData({images:[],error:'家庭已切换，请返回重新进入'})}},
 // 静态图片使用当前家庭的成员权限读取日程，无需创建访客链接或调用小程序码。
 async build(){let stage='读取家庭日程';this.setData({loading:true,error:'',images:[]});try{
  const familyId=this.familyId
  const [r, familyResult]=await Promise.all([
    S.all('listByDate',{familyId,date:this.data.date}),
    api.getFamily(familyId),
  ])
  if(this.invalid||familyId!==auth.getCurrentFamilyId())return
  stage='绘制分享图片'
  // 同一批图片使用相同生成时间，按日程数量分页方便发送和查看。
  const generatedAt=Date.now()
  const chunks=[];for(let i=0;i<r.items.length;i+=2)chunks.push(r.items.slice(i,i+2));if(!chunks.length)chunks.push([])
  const images=[]
  for(let i=0;i<chunks.length;i++)images.push(await this.draw(S.display(chunks[i]),familyResult.family.name,i+1,chunks.length,generatedAt))
  if(!this.invalid)this.setData({images,loading:false})
 }catch(e){this.setData({error:stage+'未完成：'+(e.message||'请重试'),loading:false})}},
 draw(items,name,number,total,generatedAt){return new Promise((resolve,reject)=>{
  const ctx=wx.createCanvasContext('poster',this), width=600
  let y=50
  ctx.setFillStyle('#ffffff');ctx.fillRect(0,0,width,1800)
  // 按画布测量的宽度换行，保留完整的孩子姓名和接送地点。
  function lines(value,size){ctx.setFontSize(size);const result=[];let line='';for(const char of Array.from(String(value||''))){if(char==='\n'||ctx.measureText(line+char).width>512){result.push(line);line=char==='\n'?'':char}else line+=char}if(line)result.push(line);return result}
  function text(value,size,color='#263e32'){ctx.setFontSize(size);ctx.setFillStyle(color);for(const line of lines(value,size)){ctx.fillText(line,44,y);y+=size+12}}
  const heading=name+' · 接送安排'
  const headerHeight=44+lines(heading,34).length*46+52
  ctx.setFillStyle('#46765a');ctx.fillRect(0,0,width,headerHeight)
  y=48;text(heading,34,'#ffffff');text(this.data.date+(total>1?' · '+number+'/'+total:''),24,'#e6efe8')
  y=headerHeight+44
  for(let index=0;index<items.length;index++){
    const item=items[index]
    text(item.timeStart+(item.timeEnd?' — '+item.timeEnd:''),30)
    text(item.title+' · '+item.statusLabel,30,item.status==='pending'?'#263e32':'#657368')
    if(item.place)text(item.place,28,'#657368')
    text((item.childName?item.childName+' · ':'')+item.ownerName,28,'#657368')
    y+=12
    if(index<items.length-1){ctx.setStrokeStyle('#e3e8e4');ctx.setLineWidth(1);ctx.beginPath();ctx.moveTo(44,y);ctx.lineTo(556,y);ctx.stroke();y+=36}
  }
  if(!items.length)text('这一天没有安排',28)
  y+=12;ctx.setStrokeStyle('#e3e8e4');ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke();y+=24
  const centered=(value,size,color='#657368')=>{ctx.setFontSize(size);ctx.setFillStyle(color);ctx.fillText(value,(width-ctx.measureText(value).width)/2,y);y+=size+12}
  centered('安排有变动时，请家人重新发送图片',24,'#46765a')
  centered('图片为生成时快照 · 请仅转发给家人',22)
  centered('生成：'+new Date(generatedAt+8*3600000).toISOString().slice(0,16).replace('T',' '),20)
  ctx.draw(false,()=>wx.canvasToTempFilePath({canvasId:'poster',width:600,height:y+20,destWidth:1200,destHeight:(y+20)*2,success:r=>resolve(r.tempFilePath),fail:reject},this))
 })},
 preview(e){wx.previewImage({current:e.currentTarget.dataset.src,urls:this.data.images})},
 async save(){if(this.data.saving||this.invalid)return;this.setData({saving:true});try{for(const filePath of this.data.images)await new Promise((resolve,reject)=>wx.saveImageToPhotosAlbum({filePath,success:resolve,fail:reject}));wx.showToast({title:'图片已保存，可发到微信',icon:'none'})}catch(e){wx.showModal({title:'图片未全部保存',content:'请检查相册权限，已生成的图片仍可预览。',confirmText:'打开设置',success:r=>{if(r.confirm)wx.openSetting()}})}finally{this.setData({saving:false})}},
 onUnload(){this.invalid=true},
})
