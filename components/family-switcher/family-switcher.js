Component({
  properties: {
    visible: { type: Boolean, value: false, observer(value) {
      if (value) wx.hideTabBar({ animation: false })
      else wx.showTabBar({ animation: false })
    } },
    families: { type: Array, value: [] },
    current: { type: String, value: '' },
  },
  methods: {
    noop() {},
    close() { this.triggerEvent('close') },
    select(e) { this.triggerEvent('select', { familyId: e.currentTarget.dataset.id }) },
    create() { this.openEntry('create') },
    join() { this.openEntry('join') },
    openEntry(mode) {
      this.close()
      wx.navigateTo({ url: '/pages/identity/identity?mode=' + mode })
    },
  },
})
