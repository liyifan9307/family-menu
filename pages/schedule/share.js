const schedule = require('../../utils/schedule')
const auth = require('../../utils/auth')
const api = require('../../utils/api')

const POSTER_WIDTH = 600
const CANVAS_HEIGHT = 1800
const COLORS = {
  paper: '#fffdf8', heading: '#e4eddf', ink: '#263e32',
  muted: '#536458', green: '#3d634b', line: '#e7e9de',
}
const STATUS_COLORS = {
  pending: ['#e8f0e5', '#3b5a44'],
  done: ['#eeeee7', '#536052'],
  cancelled: ['#f2e7dc', '#795036'],
}

function posterDate(value) {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return year + '年' + month + '月' + day + '日 · 周' + '日一二三四五六'[date.getUTCDay()]
}

function drawPoster(ctx, items, familyName, date, number, total, generatedAt) {
  const inset = 32
  const right = POSTER_WIDTH - inset
  const detailX = 170

  function font(size, weight) {
    ctx.setFontSize(size)
    ctx.font = weight + ' ' + size + 'px sans-serif'
  }

  // 按实际文字宽度换行，保留完整地点、姓名和负责人。
  function lines(value, width) {
    const result = []
    let line = ''
    for (const char of String(value || '').replace(/\s+/g, ' ').trim()) {
      if (line && ctx.measureText(line + char).width > width) {
        result.push(line)
        line = ''
      }
      line += char
    }
    if (line) result.push(line)
    return result
  }

  function write(value, x, y, width, size, color = COLORS.ink, weight = 400) {
    font(size, weight)
    ctx.setFillStyle(color)
    for (const line of lines(value, width)) {
      ctx.fillText(line, x, y)
      y += Math.ceil(size * 1.45)
    }
    return y
  }

  function rule(y) {
    ctx.setFillStyle(COLORS.line)
    ctx.fillRect(inset, y, right - inset, 2)
  }

  ctx.setFillStyle(COLORS.paper)
  ctx.fillRect(0, 0, POSTER_WIDTH, CANVAS_HEIGHT)

  // 先测量家庭名占几行，再铺浅绿标题底色。
  const familySize = 26
  font(familySize, 600)
  const familyLines = Math.max(1, lines(familyName, right - inset).length)
  const headerHeight = 176 + (familyLines - 1) * Math.ceil(familySize * 1.45)
  ctx.setFillStyle(COLORS.heading)
  ctx.fillRect(0, 0, POSTER_WIDTH, headerHeight)
  let y = write(familyName, inset, 54, right - inset, familySize, COLORS.green, 600)
  y = write('家庭安排', inset, y + 8, right - inset, 44, COLORS.ink, 600)
  write(posterDate(date), inset, y - 8, right - inset, 32, COLORS.muted)

  y = headerHeight + 52
  for (const [index, item] of items.entries()) {
    const next = write(item.timeStart || '当天', inset, y, detailX - inset - 12, 34, COLORS.ink, 600)
    const timeEnd = item.timeEnd
      ? write('至 ' + item.timeEnd, inset, next, detailX - inset - 12, 32, COLORS.muted)
      : next

    let detailY = write(item.title, detailX, y, right - detailX, 34, COLORS.ink, 600)
    detailY = write(item.place, detailX, detailY, right - detailX, 32, COLORS.muted)
    const owner = [item.childName, item.ownerName, item.confirmationLabel].filter(Boolean).join(' · ')
    const status = item.statusLabel
    if (status) {
      const [background, foreground] = STATUS_COLORS[item.status] || STATUS_COLORS.pending
      font(24, 500)
      const badgeWidth = ctx.measureText(status).width + 28
      font(32, 400)
      const ownerWidth = ctx.measureText(owner).width
      const fits = ownerWidth + badgeWidth + 12 <= right - detailX
      const badgeX = fits && owner ? detailX + ownerWidth + 12 : detailX
      const ownerEnd = write(owner, detailX, detailY, right - detailX, 32, COLORS.muted)
      const badgeY = fits || !owner ? detailY : ownerEnd
      ctx.setFillStyle(background)
      ctx.beginPath()
      ctx.moveTo(badgeX + 18, badgeY - 28)
      ctx.arc(badgeX + badgeWidth - 18, badgeY - 10, 18, -Math.PI / 2, Math.PI / 2)
      ctx.arc(badgeX + 18, badgeY - 10, 18, Math.PI / 2, Math.PI * 1.5)
      ctx.closePath()
      ctx.fill()
      detailY = write(status, badgeX + 14, badgeY, badgeWidth - 26, 24, foreground, 500)
      detailY = Math.max(detailY, ownerEnd)
    } else {
      detailY = write(owner, detailX, detailY, right - detailX, 32, COLORS.muted)
    }
    if (item.handoffPending) detailY = write('等待接任人答复', detailX, detailY, right - detailX, 24, COLORS.muted)
    y = Math.max(detailY, timeEnd)
    if (index < items.length - 1) rule(y)
    y += 48
  }
  rule(y - 26)
  const local = new Date(generatedAt + 8 * 3600000).toISOString()
  const stamp = '生成于 ' + Number(local.slice(5, 7)) + '月' + Number(local.slice(8, 10)) + '日 ' + local.slice(11, 16)
  write(stamp, inset, y + 12, right - inset, 24, COLORS.muted)
  if (total > 1) {
    const page = number + ' / ' + total
    font(24, 400)
    write(page, right - ctx.measureText(page).width, y + 12, right - inset, 24, COLORS.muted)
  }
  y = write('仅发给家人 · 安排有变动时请重新发送', inset, y + 52, right - inset, 24, COLORS.muted)
  return y + 8
}

Page({
  data: {
    loading: true, error: '', empty: false, images: [], activeImage: 0,
    saving: false, date: '', canvasWidth: POSTER_WIDTH, canvasHeight: CANVAS_HEIGHT,
  },

  onLoad(options) {
    this.familyId = auth.getCurrentFamilyId()
    this.setData({ date: options.date || schedule.today() })
    this.build()
  },

  onShow() {
    if (this.familyId !== auth.getCurrentFamilyId()) {
      this.invalid = true
      this.setData({ images: [], loading: false, error: '家庭已切换，请返回重新进入' })
    }
  },

  // 静态分享图只读取当前家庭日程，不创建访客链接或小程序码。
  async build() {
    if (this.invalid || this.building) return
    this.building = true
    let stage = '读取家庭事项'
    this.setData({ loading: true, error: '', empty: false, images: [], activeImage: 0 })
    try {
      const result = await schedule.all('listByDate', { familyId: this.familyId, date: this.data.date })
      if (this.invalid || this.familyId !== auth.getCurrentFamilyId()) return
      if (!result.items.length) {
        this.setData({ empty: true, loading: false })
        return
      }
      const familyResult = await api.getFamily(this.familyId)
      if (this.invalid || this.familyId !== auth.getCurrentFamilyId()) return
      stage = '绘制分享图片'
      const items = schedule.display(result.items)
      const generatedAt = Date.now()
      const total = Math.ceil(items.length / 2)
      const images = []
      for (let index = 0; index < total; index++) {
        if (this.invalid) return
        images.push(await this.draw(items.slice(index * 2, index * 2 + 2), familyResult.family.name, index + 1, total, generatedAt))
      }
      if (!this.invalid) this.setData({ images, loading: false })
    } catch (error) {
      if (!this.invalid) this.setData({ error: stage + '未完成：' + (error.message || '请重试'), loading: false })
    } finally {
      this.building = false
    }
  },

  draw(items, familyName, number, total, generatedAt) {
    return new Promise((resolve, reject) => {
      const ctx = wx.createCanvasContext('poster', this)
      const height = drawPoster(ctx, items, familyName, this.data.date, number, total, generatedAt)
      ctx.draw(false, () => wx.canvasToTempFilePath({
        canvasId: 'poster', width: POSTER_WIDTH, height,
        destWidth: POSTER_WIDTH * 2, destHeight: height * 2,
        success: result => resolve(result.tempFilePath), fail: reject,
      }, this))
    })
  },

  selectImage(event) {
    const index = Number(event.currentTarget.dataset.index)
    if (Number.isInteger(index) && index >= 0 && index < this.data.images.length) {
      this.setData({ activeImage: index })
    }
  },

  preview() {
    const { activeImage, images } = this.data
    if (images[activeImage]) wx.previewImage({ current: images[activeImage], urls: images })
  },

  async save() {
    if (this.data.saving || this.invalid || !this.data.images.length) return
    this.setData({ saving: true })
    try {
      for (const filePath of this.data.images) {
        await new Promise((resolve, reject) => wx.saveImageToPhotosAlbum({ filePath, success: resolve, fail: reject }))
      }
      wx.showToast({ title: '图片已保存，可发到微信', icon: 'none' })
    } catch (error) {
      wx.showModal({
        title: '图片未全部保存',
        content: '请检查相册权限，已生成的图片仍可预览。',
        confirmText: '打开设置',
        success: result => { if (result.confirm) wx.openSetting() },
      })
    } finally {
      this.setData({ saving: false })
    }
  },

  onUnload() {
    this.invalid = true
  },
})
