const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
function load(file, api = {}) {
  let page; const calls = []; const app = { globalData: {} }
  const auth = { getFamilies: () => [{ familyId:'old' }], getCurrentFamilyId: () => 'old', getCachedMember: () => ({openid:'me'}), setCurrentFamily: id => calls.push(['family',id]) }
  const wx = new Proxy({}, {get: (_, key) => options => calls.push([key, options])})
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page: p => page=p, require: name => name.endsWith('/api') ? api : name.endsWith('/auth') ? auth : require(path.resolve(path.dirname(file),name)), getApp:()=>app, wx, console: {error() {}, warn() {}}, setTimeout: fn=>fn(),
  })
  page.data = {...page.data}; page.setData = values => Object.assign(page.data,values)
  return {page,calls,app}
}
for (const mode of ['create','join']) test('已有家庭可主动进入 '+mode, async()=>{
  const {page,calls}=load('pages/identity/identity.js',{login:async()=>({status:'ok',families:[{familyId:'a'}],currentFamilyId:'a'})})
  if(page.onLoad) page.onLoad({mode})
  await page.onShow()
  assert.equal(page.data.mode,mode)
  assert.equal(calls.some(c=>c[0]==='switchTab'),false)
})
test('我的页在全部家庭被移除后返回引导',async()=>{
  const {page,calls}=load('pages/my/my.js',{login:async()=>({families:[],currentFamilyId:null}),getFamilies:async()=>[],getFamily:async()=>{throw Error('无归属')}})
  await page.reload()
  assert.ok(calls.some(c=>c[0]==='reLaunch' && c[1].url==='/pages/identity/identity'))
})
test('我的页失败后隐藏旧家庭内容并允许重试',async()=>{
  const {page}=load('pages/my/my.js',{login:async()=>{throw Error('网络异常')},getFamilies:async()=>{throw Error('网络异常')},getFamily:async()=>{throw Error('网络异常')}})
  page.data.family={name:'旧家庭'}
  await page.reload()
  assert.equal(page.data.error,'网络异常')
  assert.equal(page.data.family,null)
})
test('普通启动仍进入主页',async()=>{
  const {page,calls}=load('pages/identity/identity.js',{login:async()=>({status:'ok',families:[{familyId:'a'}],currentFamilyId:'a'})})
  page.onLoad({});await page.onShow()
  assert.ok(calls.some(c=>c[0]==='switchTab' && c[1].url==='/pages/home/home'))
})
test('我的页刷新真实角色、头像与成员摘要',async()=>{
  const {page}=load('pages/my/my.js',{
    login:async()=>({member:{openid:'me'},families:[{familyId:'b'}],currentFamilyId:'b'}),
    getFamily:async id=>{assert.equal(id,'b');return {family:{name:'爸妈家'},members:[{_id:'m',openid:'me',role:'member',nickName:'小凡',avatarUrl:'cloud://avatar'},{_id:'a',openid:'other',role:'admin'}]}},
  })
  await page.reload();assert.equal(page.data.me.name,'小凡');assert.equal(page.data.me.avatarUrl,'cloud://avatar');assert.equal(page.data.isAdmin,false);assert.equal(page.data.members.length,2);assert.equal(page.data.otherMemberCount,1)
})
test('主页切换家庭写入选择并刷新，不接受未知家庭',async()=>{
  const {page,calls}=load('pages/home/home.js')
  page.data.families=[{familyId:'b'}];page.data.showSwitcher=true
  let reloaded=0;page.reload=async()=>reloaded++
  await page.switchFamily({detail:{familyId:'b'}})
  assert.ok(calls.some(c=>c[0]==='family'&&c[1]==='b'));assert.equal(page.data.showSwitcher,false);assert.equal(reloaded,1)
  await page.switchFamily({detail:{familyId:'unknown'}});assert.equal(reloaded,1)
})
test('管理弹层打开隐藏 Tab，关闭后恢复',()=>{
  const {page,calls}=load('pages/my/my.js')
  page.openPanel({currentTarget:{dataset:{panel:'invite'}}})
  assert.equal(page.data.panel,'invite');assert.ok(calls.some(c=>c[0]==='hideTabBar'))
  page.closePanel();assert.equal(page.data.panel,'');assert.ok(calls.some(c=>c[0]==='showTabBar'))
})
test('切换组件创建与加入跳往对应表单',()=>{
  let component;const calls=[]
  vm.runInNewContext(fs.readFileSync('components/family-switcher/family-switcher.js','utf8'),{Component:c=>component=c,wx:{navigateTo:o=>calls.push(o.url)}})
  const instance={...component.methods,triggerEvent:name=>calls.push(name)}
  instance.create();instance.join()
  assert.deepEqual(calls,['close','/pages/identity/identity?mode=create','close','/pages/identity/identity?mode=join'])
})
test('选择头像暂时离开页面时保留资料草稿，回来仍隐藏底部栏',async()=>{
  const {page,calls}=load('pages/my/my.js')
  page.data.showProfile=true;page.data.pendingAvatarPath='tmp/avatar.png';page.data.draftNickName='新昵称'
  page.onHide()
  assert.equal(page.data.showProfile,true)
  page.reload=async()=>{}
  await page.onShow()
  assert.equal(page.data.pendingAvatarPath,'tmp/avatar.png');assert.equal(page.data.draftNickName,'新昵称');assert.equal(calls.at(-1)[0],'hideTabBar')
})
