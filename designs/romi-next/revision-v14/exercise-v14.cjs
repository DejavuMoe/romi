// Measures revision v14 in a real browser and captures its text for the
// content inventory. Every assertion is taken live, not from a stored record.
//
//   node designs/preview.mjs 4311
//   node designs/romi-next/revision-v14/exercise-v14.cjs [base]
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('@playwright/test')

const BASE = process.argv[2] || 'http://127.0.0.1:4311/romi-next/revision-v14'
const collector = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '..', '.agents', 'skills', 'prototype-first-ui', 'scripts', 'collect_dom_content.js'),
  'utf8',
)

// Page, then what to do once it has loaded.
const PAGES = {
  'public-cards': ['public.html'],
  'public-list': ['public.html', (p) => p.getByRole('button', { name: '列表', exact: true }).click()],
  'public-detail': ['public.html#node-1'],
  'admin-nodes': ['index.html#nodes'],
  'admin-detail': ['index.html#node-1'],
  system: ['system.html'],
}
const WIDTHS = [320, 390, 768, 1100, 1440]
const FORBIDDEN = /github|oauth|omarchy|flexoki|hyprland|提示词|简单\s*·\s*可靠|SIMPLE TO DEPLOY|BUILT FOR OPERATIONS|STYLE PROMPT/i

async function open(browser, name, { width = 1440, height = 900, theme = 'light', mobile = false, query = '' } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: mobile,
    hasTouch: mobile,
  })
  const page = await context.newPage()
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(e.message))
  const [file, step] = PAGES[name]
  const [base, hash] = file.split('#')
  await page.goto(`${BASE}/${base}?theme=${theme}${query}${hash ? '#' + hash : ''}`, { waitUntil: 'networkidle' })
  await page.locator('[data-screen-id]').first().waitFor({ timeout: 30_000 })
  if (step) await step(page)
  await page.waitForTimeout(100)
  return { page, context, errors }
}

async function main() {
  const browser = await chromium.launch()
  const report = []
  const note = (line) => {
    report.push(line)
    console.log(line)
  }
  try {
    // ---- square, flat, no overflow, no forbidden text ------------------
    for (const name of Object.keys(PAGES)) {
      for (const theme of ['light', 'dark']) {
        const { page, context, errors } = await open(browser, name, { theme })
        const flat = await page.evaluate(() => {
          const offenders = []
          for (const el of document.querySelectorAll('body *')) {
            const s = getComputedStyle(el)
            const rounded = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']
              .some((k) => parseFloat(s[k]) > 0)
            if (rounded || s.boxShadow !== 'none') offenders.push(el.tagName + '.' + el.className)
          }
          return offenders
        })
        assert.deepEqual(flat, [], `${name}/${theme}: rounded or shadowed elements`)
        const text = await page.evaluate(() => document.body.innerText + ' ' +
          [...document.querySelectorAll('[aria-label],[title],[placeholder]')]
            .map((el) => ['aria-label', 'title', 'placeholder'].map((a) => el.getAttribute(a) || '').join(' ')).join(' '))
        assert.doesNotMatch(text, FORBIDDEN, `${name}/${theme}: forbidden wording`)
        assert.deepEqual(errors, [], `${name}/${theme}: console errors`)
        await context.close()
      }
      for (const width of WIDTHS) {
        const { page, context } = await open(browser, name, { width, height: 844, mobile: width < 768 })
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
        assert.ok(overflow <= 0, `${name}@${width}: overflows by ${overflow}px`)
        await context.close()
      }
    }
    note(`square and flat in ${Object.keys(PAGES).length} pages x 2 themes; no overflow at ${WIDTHS.join('/')}`)

    // ---- the status page never shows an address -----------------------
    for (const name of ['public-cards', 'public-list', 'public-detail']) {
      const { page, context } = await open(browser, name)
      const text = await page.evaluate(() => document.body.innerText)
      assert.doesNotMatch(text, /\b\d{1,3}(\.\d{1,3}){3}\b|2001:db8/, `${name}: an address on the status page`)
      await context.close()
    }
    note('status page: no IPv4 or IPv6 address rendered')

    // ---- touch targets on a phone -------------------------------------
    for (const name of ['public-cards', 'public-list', 'public-detail', 'admin-nodes', 'admin-detail']) {
      const { page, context } = await open(browser, name, { width: 390, height: 844, mobile: true })
      const small = await page.evaluate(() =>
        [...document.querySelectorAll('button, a[href], input, [role="combobox"], [role="tab"]')]
          .filter((el) => {
            const r = el.getBoundingClientRect()
            const s = getComputedStyle(el)
            return r.width && r.height && s.visibility !== 'hidden' && !el.closest('[aria-hidden="true"]')
          })
          // A card is one large target; the links inside prose are exempt.
          .filter((el) => !el.matches('a.node-card') && el.getBoundingClientRect().height < 44)
          .map((el) => `${el.tagName} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 20)}" ${Math.round(el.getBoundingClientRect().height)}px`))
      assert.deepEqual(small, [], `${name}@390: targets under 44px`)
      await context.close()
    }
    note('390px touch: every button, link, input, combobox and tab is at least 44px tall')

    // ---- the admin list keeps each row's first lines level ------------
    {
      const { page, context } = await open(browser, 'admin-nodes')
      const rows = await page.evaluate(() => [...document.querySelectorAll('.admin-node-list tbody tr')].map((tr) =>
        [...tr.children].map((td) => Math.round([...td.children].find((el) => el.getBoundingClientRect().height > 0).getBoundingClientRect().top))))
      for (const tops of rows) assert.equal(new Set(tops).size, 1, `first lines not level: ${tops}`)
      note(`admin list at 1440: ${rows.length} rows, first lines level in every column`)
      await context.close()
    }

    // ---- data is monospace; the review parameter changes only the UI face
    for (const [query, ui] of [['', /Mono/], ['&font=sans', /YaHei|PingFang|Noto Sans SC/]]) {
      const { page, context } = await open(browser, 'public-cards', { query })
      const faces = await page.evaluate(() => ({
        body: getComputedStyle(document.body).fontFamily,
        data: getComputedStyle(document.querySelector('.usage-value')).fontFamily,
        address: getComputedStyle(document.querySelector('.card-network td')).fontFamily,
      }))
      assert.match(faces.body.split(',')[0], ui, `UI face for "${query}"`)
      assert.match(faces.data.split(',')[0], /Mono/, 'usage figures stay monospace')
      assert.match(faces.address.split(',')[0], /Mono/, 'network figures stay monospace')
      await context.close()
    }
    note('UI face: monospace by default, proportional with ?font=sans; figures monospace in both')

    // ---- one focus ring -----------------------------------------------
    {
      const { page, context } = await open(browser, 'admin-nodes')
      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')
      const ring = await page.evaluate(() => {
        const s = getComputedStyle(document.activeElement)
        return { style: s.outlineStyle, width: s.outlineWidth, tag: document.activeElement.tagName }
      })
      assert.equal(ring.style, 'solid', `focus ring on ${ring.tag}`)
      assert.equal(ring.width, '2px')
      note(`keyboard focus: 2px solid ring (${ring.tag})`)
      await context.close()
    }

    // ---- text captures for the content inventory -----------------------
    for (const name of Object.keys(PAGES)) {
      const { page, context } = await open(browser, name)
      await page.evaluate(collector)
      const capture = await page.evaluate(() => window.__prototypeFirstUICollectDOMContent())
      fs.writeFileSync(path.join(__dirname, 'captures', `v14-${name}.json`), JSON.stringify(capture, null, 2) + '\n')
      await context.close()
    }
    note(`captured ${Object.keys(PAGES).length} surfaces for the content inventory`)
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e.message || e)
  process.exit(1)
})
