// Measures revision v15 in a real browser and captures its text for the content
// inventory. Every assertion is taken live from the rendered page.
//
//   node designs/preview.mjs 4311
//   node designs/romi-next/revision-v15/exercise.cjs [base]
//
// CHROME=<path> uses an installed Chrome instead of Playwright's own browser.
// ONLY=2,3 runs just those numbered checks; captures are written by check 1,
// in Chinese and in English.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('@playwright/test')

const BASE = process.argv[2] || 'http://127.0.0.1:4311/romi-next/revision-v15'
const CAPTURES = path.join(__dirname, 'captures')
const collector = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '..', '.agents', 'skills', 'prototype-first-ui', 'scripts', 'collect_dom_content.js'),
  'utf8',
)
const BACKUP = path.resolve(__dirname, '..', 'fixtures', 'sample-backup.tgz')

const click = (sel) => async (p) => { await p.click(sel); await p.waitForTimeout(450) }
const steps = (...fns) => async (p) => { for (const fn of fns) await fn(p) }
const wait = (ms) => async (p) => p.waitForTimeout(ms)
const fill = (sel, text) => async (p) => p.fill(sel, text)
const press = (key) => async (p) => { await p.keyboard.press(key); await p.waitForTimeout(300) }
const scroll = (sel) => async (p) => { await p.locator(sel).first().scrollIntoViewIfNeeded(); await p.waitForTimeout(300) }
const hover = (sel, ms = 1400) => async (p) => { await p.hover(sel); await p.waitForTimeout(ms) }
// Typed sample text in the page's language.
const typed = (sel, zh, en) => async (p) => p.fill(sel, (await p.evaluate(() => document.documentElement.lang)) === 'en' ? en : zh)
const inspect = (row, tab) => steps(click(`tbody tr:nth-child(${row}) .at-actions button`), tab ? click(`#inspect-${tab}`) : wait(0))
const addToInstall = steps(typed('#add-node-form input', '东京 · edge-02', 'Tokyo · edge-02'), click('.dialog-foot .btn-primary'), wait(900))

// name → [page, step]
const STATES = {
  'public-cards': ['public.html'],
  'public-list': ['public.html', click('[role=radio][data-value=list]')],
  'public-globe': ['public.html', hover('.region-row[data-code="JP"]')],
  'public-globe-pinned': ['public.html', steps(click('.region-row[data-code="US"]'), wait(1400))],
  'public-palette': ['public.html', steps(press('/'), fill('.palette-input input', 'e'))],
  'public-detail': ['public.html#/node/1'],
  'public-detail-traffic': ['public.html#/node/2', steps(click('#history-traffic'), wait(600))],
  'public-detail-latency': ['public.html#/node/1', steps(click('#history-latency'), wait(600))],
  'public-detail-table': ['public.html#/node/1', steps(click('[role=radio][data-value=table]'), wait(600))],
  'public-detail-never': ['public.html#/node/10'],
  'public-detail-offline': ['public.html#/node/5'],
  'public-history-error': ['public.html?state=history-error#/node/1'],
  'public-notfound': ['public.html#/node/99'],
  'public-loading': ['public.html?state=loading'],
  'public-empty': ['public.html?state=empty'],
  'public-error': ['public.html?state=error'],
  'public-offline': ['public.html?state=offline'],
  'public-closed': ['public.html?state=closed'],
  login: ['index.html?state=login'],
  'login-error': ['index.html?state=login', steps(fill('input[autocomplete=username]', 'admin'), fill('input[autocomplete=current-password]', 'not-this-one'), click('.login-submit'), wait(900))],
  'admin-nodes': ['index.html#/nodes'],
  'admin-inspector': ['index.html#/nodes', inspect(4)],
  'admin-inspector-settings': ['index.html#/nodes', inspect(1, 'settings')],
  'admin-inspector-billing': ['index.html#/nodes', steps(inspect(1, 'billing'), click('.disclosure summary'))],
  'admin-inspector-install': ['index.html#/nodes', steps(inspect(1, 'install'), click('.danger-zone .btn'))],
  'admin-inspector-token': ['index.html#/nodes', steps(inspect(1, 'install'), click('.danger-zone .btn'), click('.dialog-sm .btn-danger'), wait(900))],
  'admin-delete': ['index.html#/nodes', steps(inspect(1, 'settings'), click('.danger-zone .btn'))],
  'admin-add': ['index.html?open=add'],
  'admin-add-install': ['index.html?open=add', addToInstall],
  'admin-add-joined': ['index.html?open=add', steps(addToInstall, click('.field .code-block .btn'), wait(7200))],
  'admin-register': ['index.html?open=register'],
  'admin-register-open': ['index.html?open=register', steps(click('.window-closed .btn'), wait(11500))],
  'admin-detail': ['index.html#/node/1'],
  'admin-probes': ['index.html#/probes'],
  'admin-probe-dialog': ['index.html#/probes', steps(click('.toolbar-end .btn-primary'), fill('#probe-form input.mono', 'nohost'), click('.dialog-foot .btn-primary'))],
  'admin-probe-delete': ['index.html#/probes', click('.probe-card:first-child .probe-actions button:last-child')],
  'admin-notify': ['index.html#/notify'],
  'admin-notify-dirty': ['index.html#/notify', steps(fill('.channel input.mono', '@not valid'), fill('.template textarea', '{{title}}'))],
  'admin-data': ['index.html#/data'],
  'admin-restore': ['index.html#/data', async (p) => { await p.setInputFiles('input[type=file]', BACKUP); await p.waitForTimeout(400) }],
  'admin-restore-progress': ['index.html#/data', async (p) => { await p.setInputFiles('input[type=file]', BACKUP); await p.waitForTimeout(300); await p.click('.dialog .check-row'); await p.click('.dialog-foot .btn-danger'); await p.waitForTimeout(150) }],
  'admin-maintenance': ['index.html#/data', click('#maintenance ~ * .btn, .card:has(#maintenance) .maint-row:last-child .btn')],
  'admin-security': ['index.html#/security'],
  'admin-security-refused': ['index.html#/security', steps(fill('#current-password', 'wrong-password'), fill('input[autocomplete=new-password]', 'a-new-password-1'), click('.card:first-child .btn-primary'), wait(900))],
  'admin-security-saved': ['index.html#/security', steps(fill('#current-password', 'romi-prototype'), fill('input[autocomplete=new-password]', 'a-new-password-1'), click('.card:first-child .btn-primary'), wait(900))],
  'admin-sessions-error': ['index.html?state=sessions-error#/security'],
  'admin-settings': ['index.html#/settings', typed('.card input', 'romi · 节点', 'romi · nodes')],
  'admin-geo': ['index.html#/settings', steps(click('#geo ~ * .btn, .card:has(#geo) .inspector-actions .btn'), wait(500))],
  'admin-palette': ['index.html#/nodes', steps(press('Control+k'), fill('.palette-input input', 'a'))],
  'admin-loading': ['index.html?state=loading'],
  'admin-empty': ['index.html?state=empty'],
  'admin-error': ['index.html?state=error'],
  'admin-offline': ['index.html?state=offline'],
  'admin-permission': ['index.html?state=permission'],
  'admin-nodist': ['index.html?state=no-dist&open=add'],
  system: ['system.html'],
}
const WIDTHS = [320, 390, 768, 1100, 1440]
const OVERFLOW_PAGES = ['public-cards', 'public-list', 'public-detail', 'public-detail-latency', 'login', 'admin-nodes', 'admin-inspector-billing', 'admin-add-install', 'admin-notify', 'admin-data', 'admin-security', 'admin-settings', 'system']
const TOUCH_PAGES = ['public-cards', 'public-list', 'public-detail', 'login', 'admin-nodes', 'admin-inspector-settings', 'admin-notify', 'admin-settings', 'admin-probe-dialog']
const LANGS = ['zh-CN', 'en']
const ONLY = process.env.ONLY ? process.env.ONLY.split(',').map(Number) : [1, 2, 3, 4, 5, 6, 7, 8]
// Admin-only facts that must never reach an anonymous page, in either language.
const PRIVATE = /192\.0\.2\.|198\.51\.100\.|2001:db8|node-\d+|香港 · relay-03|前端入口|API 与队列|中转，仅内部|构建与备份|镜像源|免费实例|Hong Kong · relay-03|Front door|API and queue|Relay, internal only|Builds and backups|Package mirror|Free instance|sample-token|register-key/
// Chinese left on an English page. The language switch names its target in
// that language and is marked up with lang="zh-CN".
const CJK = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/
const ENDONYMS = new Set(['中文', '中'])

// One long-lived browser accumulates enough to crash a renderer after a few
// hundred pages, so it is replaced every twenty.
let opened = 0
let shared = null
async function freshBrowser() {
  if (shared && opened % 20 !== 0) return shared
  if (shared) await shared.close()
  shared = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
  return shared
}

async function open(_, name, options = {}) {
  try {
    return await openOnce(name, options)
  } catch (e) {
    if (!/crash/i.test(e.message)) throw e
    // A crashed renderer takes its browser with it; start again once.
    opened = 0
    await shared.close().catch(() => {})
    shared = null
    return openOnce(name, options)
  }
}

async function openOnce(name, { width = 1440, height = 900, theme = 'light', mobile = false, reduced = false, lang = 'zh-CN' } = {}) {
  if (process.env.TRACE) console.error(`open ${name} ${theme} ${lang} ${width}`)
  const browser = await freshBrowser()
  opened++
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: mobile,
    hasTouch: mobile,
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    locale: lang === 'en' ? 'en-US' : 'zh-CN',
  })
  const page = await context.newPage()
  const errors = []
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(e.message))
  const [file, step] = STATES[name]
  const [base, hash] = file.split('#')
  const url = `${BASE}/${base}${base.includes('?') ? '&' : '?'}theme=${theme}&lang=${lang}${hash ? `#${hash}` : ''}`
  await page.goto(url)
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, null, { timeout: 15000 })
  await page.waitForTimeout(1600)
  if (step) await step(page)
  await page.waitForTimeout(250)
  return { context, page, errors }
}

async function capture(page, name, lang) {
  await page.addScriptTag({ content: collector })
  const report = await page.evaluate(() => window.__prototypeFirstUICollectDOMContent())
  fs.writeFileSync(path.join(CAPTURES, `v15-${name}${lang === 'en' ? '.en' : ''}.json`), JSON.stringify(report, null, 2) + '\n')
  return report
}

module.exports = { STATES }
if (require.main !== module) return

// 1. Every state loads without errors in both themes and both languages; text
// is captured once per language, and the English pages carry no Chinese.
async function loads() {
  fs.mkdirSync(CAPTURES, { recursive: true })
  for (const f of fs.readdirSync(CAPTURES)) if (f.startsWith('v15-')) fs.unlinkSync(path.join(CAPTURES, f))
  for (const name of Object.keys(STATES)) {
    for (const [theme, lang] of [['light', 'zh-CN'], ['dark', 'zh-CN'], ['light', 'en']]) {
      const { context, page, errors } = await open(null, name, { theme, lang })
      assert.deepEqual(errors, [], `${name} (${theme}, ${lang}) logged errors`)
      // An open dialog or sheet holds all of its content inside its own surface.
      const spill = await page.evaluate(() => [...document.querySelectorAll('.dialog')].filter((d) => getComputedStyle(d).overflowY === 'visible').map((d) => [...d.children].filter((c) => !/absolute|fixed/.test(getComputedStyle(c).position)).reduce((t, c) => t + c.getBoundingClientRect().height, 0) - d.getBoundingClientRect().height).filter((over) => over > 1))
      assert.deepEqual(spill, [], `${name} (${theme}, ${lang}): dialog content runs out of its surface`)
      if (theme === 'light') {
        const report = await capture(page, name, lang)
        if (name.startsWith('public')) {
          const leaked = report.items.map((i) => i.text).filter((t) => PRIVATE.test(t))
          assert.deepEqual(leaked, [], `${name} (${lang}) shows panel-only data`)
        }
        if (lang === 'en') {
          const left = report.items.map((i) => i.text).filter((t) => CJK.test(t) && !ENDONYMS.has(t))
          assert.deepEqual(left, [], `${name} shows untranslated text in English`)
          assert.equal(await page.evaluate(() => document.documentElement.lang), 'en', `${name} marks the document as English`)
        }
      }
      await context.close()
    }
  }
  return `${Object.keys(STATES).length} states load cleanly in light and dark, in Chinese and English; dialogs hold their content; English pages carry no untranslated text; public states show no panel-only data`
}

// 2. No horizontal overflow from 320 to 1440, in either language.
async function overflow() {
  for (const name of OVERFLOW_PAGES) {
    for (const width of WIDTHS) for (const lang of LANGS) {
      const { context, page } = await open(null, name, { width, height: 860, mobile: width < 768, lang })
      const over = await page.evaluate(() => {
        const w = document.documentElement.clientWidth
        return {
          scroll: document.documentElement.scrollWidth - w,
          items: [...document.querySelectorAll('body *')]
            .filter((el) => {
              const r = el.getBoundingClientRect()
              if (!r.width || getComputedStyle(el).position === 'fixed') return false
              if (el.closest('.table-card, .node-list-wrap, .history-table-wrap, .tabs, .segmented, .attention-list, .region-list, .joined-burst')) return false
              if (r.right <= w + 1) return false
              // Clipped by a box that itself fits: cut off, not overflowing. A scroll
              // box does not count, since it would let the page scroll sideways.
              for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
                if (/hidden|clip/.test(getComputedStyle(a).overflowX) && a.getBoundingClientRect().right <= w + 1) return false
              }
              return true
            })
            .slice(0, 5)
            .map((el) => el.className || el.tagName),
        }
      })
      assert.ok(over.scroll <= 0 && !over.items.length, `${name} (${lang}) at ${width}px overflows: ${JSON.stringify(over)}`)
      await context.close()
    }
  }
  return `${OVERFLOW_PAGES.length} surfaces stay inside the viewport at ${WIDTHS.join(', ')} px in Chinese and English`
}

// 3. Touch targets on a phone are at least 44px.
async function touch() {
  for (const name of TOUCH_PAGES) {
    const { context, page } = await open(null, name, { width: 390, height: 844, mobile: true })
    // Measure once entrance animations have settled; looping ones never finish.
    await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))))
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('button, a[href], input:not([type=checkbox]):not([type=file]), select, [role=tab], [role=radio], [role=switch]')]
        .filter((el) => {
          const r = el.getBoundingClientRect()
          if (!r.width || !r.height || el.closest('[hidden], .sr-only, .skip, .copy-value.is-empty')) return false
          if (r.bottom < 0 || r.top > innerHeight * 3) return false
          const after = getComputedStyle(el, '::after')
          if (after.position === 'absolute' && after.content !== 'none') return false
          const label = el.closest('.switch-row, .check-row')
          const box = label ? label.getBoundingClientRect() : r
          return box.height < 43.5
        })
        .map((el) => `${el.tagName}.${el.className}:${Math.round(el.getBoundingClientRect().height)}`),
    )
    assert.deepEqual(small, [], `${name} has touch targets under 44px`)
    await context.close()
  }
  return `${TOUCH_PAGES.length} phone surfaces keep every control at 44px or taller`
}

// 4. Keyboard: skip link, visible focus, search palette, dialog return focus, tabs.
async function keyboard() {
  {
    const { context, page } = await open(null, 'public-detail')
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement.className), 'skip', 'first Tab reaches the skip link')
    await page.keyboard.press('Tab')
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle)
    assert.notEqual(ring, 'none', 'focus is visible')
    await page.focus('#history-resources')
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.evaluate(() => document.activeElement.id), 'history-traffic', 'arrow keys move between history tabs')
    await page.keyboard.press('End')
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-selected')), 'true')
    await page.evaluate(() => document.activeElement.blur())
    await page.keyboard.press('/')
    await page.waitForTimeout(250)
    assert.ok(await page.$('.palette'), '/ opens search')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    assert.equal(await page.$('.palette'), null, 'Escape closes search')
    await context.close()
  }
  {
    const { context, page } = await open(null, 'admin-nodes')
    const trigger = page.locator('tbody tr:nth-child(2) .at-actions button')
    await trigger.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
    assert.ok(await page.$('.inspector'), 'Enter opens the inspector')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    assert.equal(await page.$('.inspector'), null, 'Escape closes the inspector')
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), await trigger.getAttribute('aria-label'), 'focus returns to the control that opened it')
    const unnamed = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label')).length)
    assert.equal(unnamed, 0, 'every icon button has a name')
    await context.close()
  }
  return 'skip link, visible focus, history tab arrows, search open/close, inspector focus return and icon names hold'
}

// A fingerprint of what a canvas shows: how many pixels are painted, and a sum
// that changes when anything on it moves.
const canvasPrint = (sel) => (page) =>
  page.evaluate((sel) => {
    const c = document.querySelector(sel)
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height)
    let painted = 0, sum = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) { painted++; sum = (sum + data[i - 3] * 3 + data[i - 2] * 5 + data[i - 1] * 7 + i) % 1e9 }
    return { painted: painted / (c.width * c.height), sum }
  }, sel)
// Distinct frames among four samples a quarter second apart. A live globe
// differs every time; a still one changes only when a report redraws it.
async function frames(page, sel) {
  const print = canvasPrint(sel)
  const seen = []
  for (let i = 0; i < 4; i++) {
    if (i) await page.waitForTimeout(250)
    seen.push(await print(page))
  }
  return { painted: seen[0].painted, distinct: new Set(seen.map((p) => p.sum)).size }
}

// 5. Reduced motion stops the ambient motion, the globe included.
async function reducedMotion() {
  const { context, page } = await open(null, 'public-cards', { reduced: true })
  const moving = await page.evaluate(() =>
    [...document.querySelectorAll('.status-ripple, .mark-beat, .live-dot, .status-dot')]
      .filter((el) => getComputedStyle(el).display !== 'none' && parseFloat(getComputedStyle(el).animationDuration) > 0.01).length,
  )
  assert.equal(moving, 0, 'no ambient animation under reduced motion')
  const still = await frames(page, '.globe-hero canvas')
  assert.ok(still.painted > 0.05, 'the globe still draws under reduced motion')
  assert.ok(still.distinct <= 2, `the globe holds still under reduced motion (${still.distinct} of 4 frames differ)`)
  await context.close()
  return 'reduced motion leaves no ambient animation running and holds the globe still'
}

// 6. Alignment: marks sit on the middle of the text beside them, status tiles
// fill their rows evenly, and a card title stays on one line.
async function alignment() {
  const out = []
  for (const lang of LANGS) {
    for (const width of [1440, 1100, 390]) {
      const { context, page } = await open(null, 'public-cards', { width, height: 900, mobile: width < 768, lang })
      await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))))
      const report = await page.evaluate(() => {
        const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 }
        // The middle of the first line box of the text, not of its element.
        const textMid = (el) => {
          const range = document.createRange()
          range.selectNodeContents(el)
          const rects = [...range.getClientRects()].filter((r) => r.width)
          return rects.length ? rects[0].top + rects[0].height / 2 : mid(el)
        }
        const off = []
        const pair = (what, mark, text) => {
          if (!mark || !text || !mark.getBoundingClientRect().width) return
          const d = Math.abs(mid(mark) - textMid(text))
          if (d > 1.5) off.push(`${what} ${d.toFixed(1)}px`)
        }
        for (const v of document.querySelectorAll('.dir-value')) pair('direction mark', v.querySelector('.dir'), v.querySelector('.dir ~ *'))
        for (const l of document.querySelectorAll('.status-tile-label')) pair('tile dot', l.querySelector('.status-dot'), l.lastElementChild)
        for (const r of document.querySelectorAll('.region-row')) pair('region dot', r.querySelector('.status-dot'), r.querySelector('.region-row-name'))
        for (const b of document.querySelectorAll('.nc-head .status')) pair('status dot', b.querySelector('.status-dot'), b.lastElementChild)
        const tiles = [...document.querySelectorAll('.status-tile')]
        const tops = tiles.map((t) => Math.round(t.getBoundingClientRect().top))
        const perRow = Object.values(tops.reduce((m, t) => ({ ...m, [t]: (m[t] || 0) + 1 }), {}))
        const heights = new Set(tiles.map((t) => Math.round(t.getBoundingClientRect().height)))
        const wrapped = [...document.querySelectorAll('.nc-title h3')].filter((h) => h.getBoundingClientRect().height > parseFloat(getComputedStyle(h).lineHeight) * 1.5 + 2).length
        return { off: off.slice(0, 6), perRow, heights: heights.size, wrapped }
      })
      assert.deepEqual(report.off, [], `public-cards (${lang}) at ${width}px: marks off the text centre`)
      assert.equal(new Set(report.perRow).size, 1, `public-cards (${lang}) at ${width}px: status tiles fill rows unevenly (${report.perRow.join('+')})`)
      assert.equal(report.heights, 1, `public-cards (${lang}) at ${width}px: status tiles differ in height`)
      assert.equal(report.wrapped, 0, `public-cards (${lang}) at ${width}px: a card title wraps`)
      out.push(report.perRow.join('+'))
      await context.close()
    }
  }
  // Two-column grids pair their cards: each row holds two of equal height, or
  // one that spans the row. No card is left alone beside an empty column.
  const GRIDS = '.chart-grid, .data-layout, .notify-layout, .security-layout, .settings-layout, .probe-grid'
  for (const lang of LANGS) {
    for (const name of ['public-detail', 'public-detail-latency', 'admin-data', 'admin-notify', 'admin-security', 'admin-settings', 'admin-probes']) {
      const { context, page } = await open(null, name, { width: 1440, height: 900, lang })
      await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))))
      const bad = await page.evaluate((sel) => {
        const out = []
        for (const grid of document.querySelectorAll(sel)) {
          const width = grid.getBoundingClientRect().width
          const rows = {}
          for (const c of grid.children) {
            const r = c.getBoundingClientRect()
            if (!r.width || getComputedStyle(c).position === 'fixed') continue
            ;(rows[Math.round(r.top)] ||= []).push(r)
          }
          for (const row of Object.values(rows)) {
            if (row.length === 1 && row[0].width < width * 0.9) out.push(`${grid.className}: a card alone in its row`)
            if (row.length === 2 && Math.abs(row[0].height - row[1].height) > 1) out.push(`${grid.className}: paired cards differ in height (${Math.round(row[0].height)} / ${Math.round(row[1].height)})`)
          }
        }
        return out
      }, GRIDS)
      assert.deepEqual(bad, [], `${name} (${lang}): unpaired cards`)
      await context.close()
    }
  }
  // Switching the inspector's tabs leaves the sheet where it is, at its size.
  for (const width of [1440, 390]) {
    const { context, page } = await open(null, 'admin-inspector', { width, height: 900, mobile: width < 768 })
    const boxes = []
    for (const tab of ['overview', 'settings', 'billing', 'install', 'overview']) {
      await page.click(`#inspect-${tab}`)
      await page.waitForTimeout(250)
      boxes.push(await page.evaluate(() => { const r = document.querySelector('.inspector').getBoundingClientRect(); return [r.x, r.width, r.height].map(Math.round).join(',') }))
    }
    assert.equal(new Set(boxes).size, 1, `inspector at ${width}px changes geometry across tabs: ${boxes.join(' / ')}`)
    await context.close()
  }
  return `marks centre on their text within 1.5px, status tiles fill rows evenly (${[...new Set(out)].join(', ')}), card titles stay on one line, grid cards pair up, the inspector keeps its geometry across tabs`
}

// 7. Computed type and radius stay on the scale on the busiest surfaces.
async function scale() {
  const SIZES = [11, 12, 13, 14, 16, 18, 24, 32, 48, 64]
  const EM = [0.75, 0.92, 1]
  const allowed = new Set(SIZES.flatMap((s) => EM.map((k) => Math.round(s * k * 100) / 100)))
  const RADII = new Set(['0px', '4px', '6px', '10px', '16px', '20px', '50%'])
  for (const name of ['public-cards', 'public-detail', 'admin-nodes', 'admin-inspector', 'admin-notify', 'admin-data']) {
    const { context, page } = await open(null, name)
    const found = await page.evaluate(() => {
      const sizes = new Set(), radii = new Set()
      for (const el of document.querySelectorAll('body *')) {
        if (!el.getBoundingClientRect().width) continue
        const cs = getComputedStyle(el)
        if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) sizes.add(Math.round(parseFloat(cs.fontSize) * 100) / 100)
        for (const r of [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomLeftRadius, cs.borderBottomRightRadius]) radii.add(r)
      }
      return { sizes: [...sizes], radii: [...radii] }
    })
    const offSize = found.sizes.filter((s) => !allowed.has(s))
    // A radius is a token, or large enough to read as a pill.
    const offRadius = found.radii.filter((r) => !RADII.has(r) && !(parseFloat(r) >= 999))
    assert.deepEqual(offSize, [], `${name}: font sizes off the scale`)
    assert.deepEqual(offRadius, [], `${name}: radii off the scale`)
    await context.close()
  }
  return 'computed font sizes and radii on six busy surfaces all come from the scale'
}

// 8. The globe draws in both themes and moves while the page is live; the
// flows grow with the traffic they stand for.
async function globe() {
  const out = []
  for (const theme of ['light', 'dark']) {
    const { context, page } = await open(null, 'public-cards', { theme })
    const live = await frames(page, '.globe-hero canvas')
    assert.ok(live.painted > 0.05, `the hero globe draws in ${theme}`)
    assert.equal(live.distinct, 4, `the hero globe moves in ${theme}`)
    out.push(`${theme} ${(live.painted * 100).toFixed(0)}% painted`)
    const levels = await page.evaluate(() => [1e3, 60e3, 2e6, 60e6].map((r) => window.rateLevel(r)))
    assert.ok(levels.every((v, i) => i === 0 || v > levels[i - 1]), `flow level rises with the rate: ${levels.join(', ')}`)
    await context.close()
  }
  {
    const { context, page } = await open(null, 'public-detail')
    const a = await canvasPrint('.globe-detail canvas')(page)
    assert.ok(a.painted > 0.05, 'the detail globe draws')
    await context.close()
  }
  {
    const { context, page } = await open(null, 'system')
    const count = await page.evaluate(() => document.querySelectorAll('.sys-col:first-child .sys-globe canvas').length)
    assert.equal(count, 3, 'the system page shows three flow levels')
    await context.close()
  }
  return `the globe draws and moves (${out.join(', ')}), the detail and system globes draw, and flow level rises with the rate`
}

;(async () => {
  const checks = [loads, overflow, touch, keyboard, reducedMotion, alignment, scale, globe]
  const results = []
  for (const [i, check] of checks.entries()) if (ONLY.includes(i + 1)) results.push(await check())
  await shared?.close()
  console.log(results.map((r) => `✓ ${r}`).join('\n'))
  if (ONLY.includes(1)) console.log(`captures: ${fs.readdirSync(CAPTURES).filter((f) => f.startsWith('v15-')).length} files in ${path.relative(process.cwd(), CAPTURES)}`)
})().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
