const api = require('../../utils/api')
const auth = require('../../utils/auth')
const schedule = require('../../utils/schedule')

Page({
  data: { loading: true, familyName: '', error: '', families: [], currentFamilyId: '', showSwitcher: false, scheduleLoading: false, scheduleSummary: '', scheduleError: '', todayLabel: '', scheduleCount: 0, nextSchedule: null },
  onShow() { return this.reload() },
  onHide() { this.closeSwitcher() },
  toggleSwitcher() { this.setData({ showSwitcher: true }) },
  closeSwitcher() { this.setData({ showSwitcher: false }) },
  async switchFamily(e) {
    const id = e.detail.familyId
    if (!this.data.families.some(f => f.familyId === id)) return
    this.closeSwitcher()
    auth.setCurrentFamily(id)
    await this.reload()
  },
  async reload() {
    const sequence = this.sequence = (this.sequence || 0) + 1
    this.setData({ loading: true, error: '', familyName: '' })
    try {
      const session = await api.login(true)
      if (sequence !== this.sequence) return
      Object.assign(getApp().globalData, {
        member: session.member, families: session.families,
        currentFamilyId: session.currentFamilyId, loginStatus: session.status,
      })
      if (!session.currentFamilyId || !session.families.length) {
        wx.reLaunch({ url: '/pages/identity/identity' })
        return
      }
      if (sequence !== this.sequence) return
      const family = session.families.find(f => f.familyId === session.currentFamilyId)
      this.setData({ familyName: family ? family.name : '我的家', families: session.families, currentFamilyId: session.currentFamilyId })
      this.loadSchedule(session.currentFamilyId, sequence)
    } catch (err) {
      if (sequence !== this.sequence) return
      this.setData({ error: err.message || '加载失败，请稍后重试' })
    } finally {
      if (sequence === this.sequence) this.setData({ loading: false })
    }
  },
  async loadSchedule(familyId, sequence) {
    this.setData({ scheduleLoading: true, scheduleSummary: '', scheduleError: '', nextSchedule:null, scheduleCount:0, todayLabel:schedule.today().slice(5).replace('-', '月')+'日' })
    try {
      const r = await schedule.all('listByDate', {familyId, date:schedule.today()})
      if(sequence !== this.sequence || familyId !== this.data.currentFamilyId) return
      const time = new Date(Date.now()+8*3600000).toISOString().slice(11,16)
      // 优先显示还没到时间的待办，没有时再显示较早的未完成安排。
      const pending = schedule.display(r.items).filter(i=>i.status==='pending')
      const next = pending.find(i=>i.timeStart>=time)||pending[0]
      this.setData({nextSchedule:next||null,scheduleCount:r.items.length,scheduleSummary:next?(next.timeStart||'当天')+' '+next.title+' · '+next.ownerName:r.items.length?'今天的安排已结束':'今天还没有安排',scheduleLoading:false})
    } catch(e) { if(sequence===this.sequence)this.setData({scheduleError:e.message,scheduleLoading:false}) }
  },
  gotoSchedule() { wx.navigateTo({url:'/pages/schedule/schedule'}) },
  onPullDownRefresh() { return this.reload().finally(() => wx.stopPullDownRefresh()) },
  gotoMy() { wx.switchTab({ url: '/pages/my/my' }) },
  gotoDish() { wx.showToast({ title: '点菜功能即将开放', icon: 'none' }) },
})
