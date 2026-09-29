// The approved v14 visual system, measured on the real Hub: the same checks
// exercise-v14.cjs makes against the prototype, taken from the production pages
// in both themes.
import { test, expect, signIn } from './fixtures.mjs'

const PAGES = [
  ['public cards', () => '/'],
  ['public list', () => '/', async (page) => page.getByRole('button', { name: '列表', exact: true }).click()],
  ['public detail', (hub) => `/node/${hub.first}`],
  // Before the admin pages: once signed in, /admin/ shows the panel instead.
  ['admin login', () => '/admin/'],
  ['admin nodes', () => '/admin/nodes', null, true],
  ['admin detail', (hub) => `/admin/node/${hub.first}`, null, true],
  ['admin probes', () => '/admin/ping', null, true],
  ['admin notifications', () => '/admin/notify', null, true],
  ['admin data', () => '/admin/data', null, true],
  ['admin security', () => '/admin/security', null, true],
  ['admin settings', () => '/admin/settings', null, true],
]
const named = (name) => PAGES.find(([label]) => label === name)

async function seed(hub) {
  hub.first = await hub.node('东京 · edge-01', true)
  await hub.node('新加坡 · core-02', true)
  await hub.node('法兰克福 · eu-01', false)
  await hub.request('/api/settings', { method: 'PUT', body: { public_page: 'on' } })
  await hub.request('/api/ping-tasks', { method: 'POST', body: { name: '主站 HTTPS', target: 'status.example.invalid:443', interval: 60, nodes: [hub.first] } })
}

async function visit(page, hub, [, path, step, admin], theme) {
  await page.addInitScript((value) => localStorage.setItem('theme', value), theme)
  // Once per page: a second sign-in would find the panel, not the form.
  if (admin && !page.signedIn) {
    await signIn(page)
    page.signedIn = true
  }
  await page.goto(path(hub))
  await page.locator('main, .login-screen').first().waitFor()
  if (step) await step(page)
  await page.waitForLoadState('networkidle')
}

test('square and flat in both themes, with one monospace face and one focus ring', async ({ page, hub }) => {
  test.slow()
  await seed(hub)
  for (const entry of PAGES) {
    for (const theme of ['light', 'dark']) {
      await visit(page, hub, entry, theme)
      const offenders = await page.evaluate(() => {
        const out = []
        for (const el of document.querySelectorAll('body *')) {
          const s = getComputedStyle(el)
          if (!el.getClientRects().length) continue
          const rounded = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']
            .some((k) => parseFloat(s[k]) > 0)
          if (rounded || s.boxShadow !== 'none') out.push(`${el.tagName}.${el.className}: ${rounded ? 'radius' : s.boxShadow}`)
        }
        return out
      })
      expect(offenders, `${entry[0]} / ${theme}`).toEqual([])
    }
  }

  // The whole interface is set in the monospace face; figures in tabular digits.
  await visit(page, hub, named('public cards'), 'light')
  const faces = await page.evaluate(() => ({
    body: getComputedStyle(document.body).fontFamily,
    figure: getComputedStyle(document.querySelector('.usage-number')).fontVariantNumeric,
  }))
  expect(faces.body.split(',')[0]).toMatch(/Mono/)
  expect(faces.figure).toContain('tabular-nums')

  // One focus treatment: a 2px solid ring.
  await visit(page, hub, named('admin nodes'), 'light')
  await page.getByLabel('搜索节点').focus()
  for (const target of [page.getByLabel('搜索节点'), page.getByRole('button', { name: '全部', exact: true })]) {
    await target.focus()
    const ring = await target.evaluate((el) => ({ style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth }))
    expect(ring).toEqual({ style: 'solid', width: '2px' })
  }
})

test('nothing overflows from 320 to 1440 and the admin list stays level', async ({ page, hub }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'widths are set explicitly')
  test.slow()
  await seed(hub)
  for (const entry of PAGES) {
    await visit(page, hub, entry, 'light')
    for (const width of [320, 390, 768, 1100, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      expect(overflow, `${entry[0]} at ${width}`).toBeLessThanOrEqual(0)
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await visit(page, hub, named('admin nodes'), 'light')
  const rows = await page.evaluate(() => [...document.querySelectorAll('.admin-node-table tbody tr')].map((tr) =>
    [...tr.children].map((td) => Math.round([...td.children].find((el) => el.getBoundingClientRect().height > 0).getBoundingClientRect().top))))
  expect(rows.length).toBe(3)
  for (const tops of rows) expect(new Set(tops).size, `first lines ${tops}`).toBe(1)
})

test('every control on a phone is at least 44px tall', async ({ page, hub }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'touch sizing')
  await seed(hub)
  for (const entry of PAGES) {
    await visit(page, hub, entry, 'light')
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('button, a[href], input, [role="combobox"], [role="tab"]')]
        .filter((el) => {
          const r = el.getBoundingClientRect()
          return r.width && r.height && getComputedStyle(el).visibility !== 'hidden' && !el.matches('.public-node-card, .skip-link')
        })
        // A checkbox or switch is pressed through the row that labels it.
        .map((el) => (el.matches('input[type="checkbox"], [role="switch"]') && el.closest('label')) || el)
        .filter((el) => el.getBoundingClientRect().height < 44)
        .map((el) => `${el.tagName} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 20)}" ${Math.round(el.getBoundingClientRect().height)}px`))
    expect(small, entry[0]).toEqual([])
  }
})

test('a dialog is a title bar over its body, and a bottom sheet on a phone', async ({ page, hub }, testInfo) => {
  await seed(hub)
  await signIn(page)
  await page.goto('/admin/nodes')
  await page.getByRole('button', { name: /^编辑菜单/ }).first().click()
  await page.getByRole('button', { name: '编辑节点', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const measure = () => dialog.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const head = el.querySelector('[data-slot="dialog-header"]')
    const bar = head.getBoundingClientRect()
    const close = el.querySelector('[data-slot="dialog-close"]').getBoundingClientRect()
    return {
      left: box.left, right: box.right, bottom: box.bottom, width: box.width, vw: innerWidth, vh: innerHeight,
      barOffset: Math.round(bar.top - box.top), barHeight: bar.height, rule: getComputedStyle(head).borderBottomStyle,
      closeInBar: close.top >= bar.top && close.bottom <= bar.bottom,
    }
  })
  const opened = await measure()
  expect(opened.rule).toBe('solid')
  expect(opened.barHeight).toBeGreaterThanOrEqual(48)
  expect(opened.closeInBar).toBe(true)
  if (testInfo.project.name === 'mobile') {
    expect(opened.left).toBe(0)
    expect(opened.width).toBe(opened.vw)
    expect(Math.abs(opened.bottom - opened.vh)).toBeLessThanOrEqual(1)
  } else {
    expect(opened.width).toBeLessThanOrEqual(560)
    // A floating box clear of both edges. Not an exact centre: the scroll lock
    // leaves a scrollbar gutter, so the box centres on the page, not the window.
    expect(opened.left).toBeGreaterThan(0)
    expect(opened.right).toBeLessThan(opened.vw)
  }
  // The bar and its close button stay put while the long form scrolls.
  await dialog.evaluate((el) => { el.scrollTop = el.scrollHeight })
  const scrolled = await measure()
  expect(scrolled.barOffset).toBe(opened.barOffset)
  expect(scrolled.closeInBar).toBe(true)
})
