const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const schedule = require('../utils/schedule')

function load(items) {
  let page, exportsCount = 0
  const text = [], saved = [], calls = []
  const ctx = {
    setFillStyle() {}, fillRect() {}, setFontSize() {},
    measureText: value => ({ width: Array.from(value).length * 15 }),
    fillText: value => text.push(value), setStrokeStyle() {}, setLineWidth() {},
    beginPath() {}, moveTo() {}, arc() {}, closePath() {}, fill() {},
    drawImage() { throw Error('纯图片不能绘制小程序码') },
    draw: (_, done) => done(),
  }
  const S = {
    display: schedule.display,
    all: async (action, params) => {
      calls.push(action)
      assert.equal(action, 'listByDate')
      assert.equal(params.familyId, 'family-a')
      assert.equal(params.date, '2026-11-26')
      return { items }
    },
    call: async () => { throw Error('不能调用分享链接或小程序码接口') },
  }
  vm.runInNewContext(fs.readFileSync('pages/schedule/share.js', 'utf8'), {
    Page: value => { page = value },
    require: name => name.endsWith('/schedule') ? S : name.endsWith('/api')
      ? { getFamily: async id => { assert.equal(id, 'family-a'); return { family: { name: '我的家' } } } }
      : { getCurrentFamilyId: () => 'family-a' },
    wx: {
      createCanvasContext: () => ctx,
      canvasToTempFilePath: options => options.success({ tempFilePath: 'poster-' + ++exportsCount }),
      saveImageToPhotosAlbum: options => { saved.push(options.filePath); options.success() },
      showToast() {}, showModal() {},
    }, Date, console,
  })
  page.setData = values => Object.assign(page.data, values)
  page.familyId = 'family-a'
  page.data.date = '2026-11-26'
  return { page, text, saved, calls }
}
const item = { title: '接孩子', timeStart: '16:00', place: '幼儿园一号门', childName: '小宝', ownerName: '爸爸', status: 'pending' }
test('图片直接读取家庭日程，生成无扫码文案的多张图片并可全部保存', async () => {
  const { page, text, saved, calls } = load([item, item, item])
  await page.build()
  assert.equal(page.data.error, '')
  assert.equal(page.data.loading, false)
  assert.equal(page.data.images.length, 2)
  assert.deepEqual(calls, ['listByDate'])
  assert.ok(text.some(t => t.includes('我的家')))
  assert.ok(text.some(t => t.includes('小宝') && t.includes('爸爸')))
  assert.ok(text.some(t => t.includes('生成于')))
  assert.equal(text.some(t => /扫码|链接到期/.test(t)), false)
  await page.save()
  assert.deepEqual(saved, ['poster-1', 'poster-2'])
})
test('无日程时显示空态，不生成或保存分享图片', async () => {
  const { page, text, saved } = load([])
  await page.build()
  assert.equal(page.data.empty, true)
  assert.equal(page.data.loading, false)
  assert.equal(page.data.images.length, 0)
  assert.deepEqual(text, [])
  await page.save()
  assert.deepEqual(saved, [])
})

test('分享预览可以切换图片，保存仍包含所有分页', async () => {
  const { page, saved } = load([item, item, item])
  await page.build()
  assert.equal(page.data.activeImage, 0)
  page.selectImage({ currentTarget: { dataset: { index: 1 } } })
  assert.equal(page.data.activeImage, 1)
  page.selectImage({ currentTarget: { dataset: { index: 3 } } })
  assert.equal(page.data.activeImage, 1)
  await page.save()
  assert.deepEqual(saved, ['poster-1', 'poster-2'])
})
