// The approved v15 status page, measured on the real Hub: the checks
// revision-v15/exercise.cjs makes against the prototype, taken from the
// production pages. The node detail and the admin panel follow in later slices.
import { test, expect } from './fixtures.mjs'

const NAMES = ['Tokyo edge-01', 'Singapore core-02', 'Frankfurt eu-01']
// A test Hub has no country database, so the stream is given places to put the
// globe's dots on. Everything else is the Hub's own answer.
const PLACES = ['JP', 'SG', 'DE']
const locate = (body) => ({ ...body, nodes: body.nodes.map((node, i) => ({ ...node, country: node.country || PLACES[i % PLACES.length] })) })

async function seed(hub) {
  for (const name of NAMES) await hub.node(name, true)
  await hub.node('Private eu-02', false)
  await hub.request('/api/settings', { method: 'PUT', body: { public_page: 'on' } })
}

async function located(page) {
  await page.route('**/api/nodes', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: locate(await response.json()) })
  })
  await page.routeWebSocket('**/api/ws', (ws) => {
    const server = ws.connectToServer()
    server.onMessage((message) => ws.send(JSON.stringify(locate(JSON.parse(message)))))
  })
}

async function open(page, { theme = 'light', lang = 'zh-CN', list = false, reduced = false } = {}) {
  await page.addInitScript(([t, l]) => {
    localStorage.setItem('theme', t)
    localStorage.setItem('lang', l)
  }, [theme, lang])
  if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.locator('.hero, .closed-card, .empty').first().waitFor()
  if (list) await page.getByRole('radio', { name: lang === 'en' ? 'List' : '列表', exact: true }).click()
  await settle(page)
}

// Entrance animations have finished; looping ones never do.
const settle = (page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))))

// How much of a canvas is painted, and a sum that changes when anything on it
// moves: four samples a quarter second apart, from its first drawn frame.
async function frames(page, selector) {
  const print = () => page.locator(selector).evaluate((canvas) => {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
    let painted = 0, sum = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) { painted++; sum = (sum + data[i - 3] * 3 + data[i - 2] * 5 + data[i - 1] * 7 + i) % 1e9 }
    return { painted: painted / (canvas.width * canvas.height), sum }
  })
  await expect.poll(async () => (await print()).painted, { message: `${selector} draws` }).toBeGreaterThan(0)
  const seen = []
  for (let i = 0; i < 4; i++) {
    if (i) await page.waitForTimeout(250)
    seen.push(await print())
  }
  return { painted: seen[0].painted, distinct: new Set(seen.map((p) => p.sum)).size }
}

// The closed page last: it is the same Hub with the status page turned off.
const PAGES = [
  ['cards', {}],
  ['list', { list: true }],
  ['closed', { closed: true }],
]
const close = (hub) => hub.request('/api/settings', { method: 'PUT', body: { public_page: 'off' } })

test('the status page reads in either language and keeps the panel out', async ({ page, hub }) => {
  await seed(hub)
  for (const [theme, lang] of [['light', 'zh-CN'], ['dark', 'zh-CN'], ['light', 'en']]) {
    for (const list of [false, true]) {
      await open(page, { theme, lang, list })
      const report = await page.evaluate(() => {
        // The language button names its target in that language, marked as such.
        const own = (el) => !el.closest('[lang]:not(html)')
        const text = [...document.querySelectorAll('body *')].filter(own).flatMap((el) => [
          ...[...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()),
          ...['aria-label', 'title', 'placeholder'].map((a) => el.getAttribute(a) || ''),
        ]).filter(Boolean)
        return { text, lang: document.documentElement.lang, dark: document.documentElement.classList.contains('dark') }
      })
      expect(report.lang).toBe(lang)
      expect(report.dark).toBe(theme === 'dark')
      expect(report.text.filter((t) => /Private eu-02|node-\d+|romi\.test/.test(t))).toEqual([])
      if (lang === 'en') expect(report.text.filter((t) => /[㐀-鿿＀-￯　-〿]/.test(t)), 'Chinese left on an English page').toEqual([])
    }
  }
})

test('the language follows the browser until the visitor picks one, which survives a reload', async ({ page, hub }) => {
  await seed(hub)
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('节点状态')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Node status')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Node status')
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '中文', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('节点状态')
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
})

test('nothing overflows from 320 to 1440 in either language', async ({ page, hub }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'widths are set explicitly')
  test.slow()
  await seed(hub)
  for (const [name, { closed, ...options }] of PAGES) {
    if (closed) await close(hub)
    for (const lang of ['zh-CN', 'en']) {
      await open(page, { ...options, lang })
      for (const width of [320, 390, 768, 1100, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        const over = await page.evaluate(() => {
          const w = document.documentElement.clientWidth
          return {
            scroll: document.documentElement.scrollWidth - w,
            items: [...document.querySelectorAll('body *')].filter((el) => {
              const r = el.getBoundingClientRect()
              if (!r.width || getComputedStyle(el).position === 'fixed' || r.right <= w + 1) return false
              if (el.closest('.node-list-wrap, .segmented')) return false
              for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
                const style = getComputedStyle(a)
                // Held to the window, as the closed page's globe is: it cannot scroll.
                if (style.position === 'fixed') return false
                // Cut off by a box that itself fits is clipped, not overflowing.
                if (/hidden|clip/.test(style.overflowX) && a.getBoundingClientRect().right <= w + 1) return false
              }
              return true
            }).slice(0, 5).map((el) => el.className || el.tagName),
          }
        })
        expect(over.scroll, `${name} (${lang}) at ${width}px`).toBeLessThanOrEqual(0)
        expect(over.items, `${name} (${lang}) at ${width}px`).toEqual([])
      }
    }
  }
})

test('every control on a phone is at least 44px tall', async ({ page, hub }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'touch sizing')
  await seed(hub)
  for (const [name, { closed, ...options }] of PAGES) {
    if (closed) await close(hub)
    await open(page, options)
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('button, a[href], input:not([type=checkbox]), select, [role=tab], [role=radio], [role=switch]')]
        .filter((el) => {
          const r = el.getBoundingClientRect()
          if (!r.width || !r.height || el.closest('[hidden], .sr-only, .skip')) return false
          // A hit area widened past the visible box by a positioned ::after.
          const after = getComputedStyle(el, '::after')
          if (after.position === 'absolute' && after.content !== 'none') return false
          return r.height < 43.5
        })
        .map((el) => `${el.tagName}.${el.className} ${Math.round(el.getBoundingClientRect().height)}px`))
    expect(small, name).toEqual([])
  }
})

test('type and radius stay on the scale, and marks sit on their text', async ({ page, hub }, testInfo) => {
  await seed(hub)
  const SIZES = [11, 12, 13, 14, 16, 18, 24, 32, 48, 64]
  const allowed = SIZES.flatMap((s) => [0.75, 0.92, 1].map((k) => Math.round(s * k * 100) / 100))
  const RADII = ['0px', '4px', '6px', '10px', '16px', '20px', '50%']
  for (const [theme, list] of [['light', false], ['dark', false], ['light', true]]) {
    await open(page, { theme, list })
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
    expect(found.sizes.filter((s) => !allowed.includes(s)), `font sizes (${theme}, ${list ? 'list' : 'cards'})`).toEqual([])
    // A radius is a token, or large enough to read as a pill.
    expect(found.radii.filter((r) => !RADII.includes(r) && !(parseFloat(r) >= 999)), `radii (${theme}, ${list ? 'list' : 'cards'})`).toEqual([])
  }
  await open(page)
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
    for (const b of document.querySelectorAll('.nc-head .status')) pair('status dot', b.querySelector('.status-dot'), b.lastElementChild)
    const tiles = [...document.querySelectorAll('.status-tile')]
    const tops = tiles.map((t) => Math.round(t.getBoundingClientRect().top))
    return {
      off,
      perRow: new Set(Object.values(tops.reduce((m, t) => ({ ...m, [t]: (m[t] || 0) + 1 }), {}))).size,
      heights: new Set(tiles.map((t) => Math.round(t.getBoundingClientRect().height))).size,
      wrapped: [...document.querySelectorAll('.nc-title h3')].filter((h) => h.getBoundingClientRect().height > parseFloat(getComputedStyle(h).lineHeight) * 1.5 + 2).length,
    }
  })
  expect(report, testInfo.project.name).toEqual({ off: [], perRow: 1, heights: 1, wrapped: 0 })
})

test('the globe draws in both themes, moves while live and holds still under reduced motion', async ({ page, hub }) => {
  await seed(hub)
  await located(page)
  for (const theme of ['light', 'dark']) {
    await open(page, { theme })
    const live = await frames(page, '.globe-hero canvas')
    expect(live.painted, `hero globe painted (${theme})`).toBeGreaterThan(0.05)
    expect(live.distinct, `hero globe moves (${theme})`).toBe(4)
    const map = await frames(page, '.day-map canvas')
    expect(map.painted, `day map painted (${theme})`).toBeGreaterThan(0.05)
  }
  await open(page, { reduced: true })
  const still = await frames(page, '.globe-hero canvas')
  expect(still.painted).toBeGreaterThan(0.05)
  expect(still.distinct).toBeLessThanOrEqual(2)
  const moving = await page.evaluate(() => [...document.querySelectorAll('.status-ripple, .mark-beat, .live-dot, .status-dot')]
    .filter((el) => getComputedStyle(el).display !== 'none' && parseFloat(getComputedStyle(el).animationDuration) > 0.01).length)
  expect(moving, 'ambient animation under reduced motion').toBe(0)
})

test('a closed status page sends visitors to sign in over the world', async ({ page, hub }) => {
  await seed(hub)
  await close(hub)
  for (const theme of ['light', 'dark']) {
    await open(page, { theme })
    await expect(page.getByRole('heading', { name: '需要登录', exact: true })).toBeVisible()
    await expect(page.getByText(NAMES[0])).toHaveCount(0)
    const backdrop = await frames(page, '.globe-backdrop canvas')
    expect(backdrop.painted, `backdrop globe painted (${theme})`).toBeGreaterThan(0.02)
  }
  await page.getByRole('link', { name: '前往登录', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/$/)
})

test('keyboard: skip link, visible focus and the search palette', async ({ page, hub }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'keyboard')
  await seed(hub)
  await open(page)
  await page.keyboard.press('Tab')
  await expect(page.locator('.skip')).toBeFocused()
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle)).not.toBe('none')
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('button')]
    .filter((b) => b.getClientRects().length && !b.textContent.trim() && !b.getAttribute('aria-label')).length)
  expect(unnamed, 'every icon button has a name').toBe(0)
  await page.evaluate(() => document.activeElement.blur())
  await page.keyboard.press('/')
  const palette = page.getByRole('dialog', { name: '搜索', exact: true })
  await expect(palette).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette).toBeVisible()
  await page.keyboard.type('Singapore')
  await expect(palette.getByRole('option')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/node\/\d+$/)
  await expect(page.getByRole('heading', { name: NAMES[1], level: 1 })).toBeVisible()
})

test('status tiles filter the fleet and search narrows it', async ({ page, hub }) => {
  await seed(hub)
  await open(page)
  const cards = page.locator('.node-card')
  await expect(cards).toHaveCount(3)
  const never = page.getByRole('button', { name: /未连接/ })
  await never.click()
  await expect(never).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('heading', { name: '未连接节点', level: 2 })).toBeVisible()
  await expect(page.getByRole('button', { name: /^在线/ })).toBeDisabled()
  await page.getByRole('searchbox', { name: '搜索节点', exact: true }).fill('frankfurt')
  await expect(cards).toHaveCount(1)
  await page.getByRole('searchbox', { name: '搜索节点', exact: true }).fill('nothing-like-this')
  await expect(page.getByText('没有匹配的节点')).toBeVisible()
  await page.getByRole('button', { name: '清除筛选', exact: true }).first().click()
  await expect(cards).toHaveCount(3)
  await expect(never).toHaveAttribute('aria-pressed', 'false')
})
