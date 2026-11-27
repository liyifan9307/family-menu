const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs')
function load(file,S){let page;let family='a';vm.runInNewContext(fs.readFileSync(file,'utf8'),{Page:p=>page=p,require:n=>n.endsWith('/schedule')?S:n.endsWith('/auth')?{getCurrentFamilyId:()=>family}:{},wx:{hideShareMenu(){},showShareMenu(){},showToast(){},showModal(){}},Date,console});page.setData=d=>Object.assign(page.data,d);return {page,family:id=>family=id}}
test('分享准备的旧响应不能覆盖切换后的日期',async()=>{let resolve;const {page}=load('pages/schedule/schedule.js',{call:()=>new Promise(r=>resolve=r)});Object.assign(page.data,{date:'2026-11-25',items:[{}],loading:false});page.seq=1;const pending=page.prepareShare();page.seq=2;page.data.date='2026-11-26';resolve({path:'old',token:'old'});await pending;assert.equal(page.data.shareReady,false)})

test('无安排、加载中和加载失败都不能触发分享', async () => {
  const {page}=load('pages/schedule/schedule.js',{call:()=>assert.fail('不应生成分享链接')})
  for (const state of [
    {items:[],loading:false,error:''},
    {items:[{}],loading:true,error:''},
    {items:[{}],loading:false,error:'加载失败'},
  ]) {
    page.setData(state)
    await page.prepareShare()
    page.image()
    assert.equal(page.data.shareReady,false)
  }
})
