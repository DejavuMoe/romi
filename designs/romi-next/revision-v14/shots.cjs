// Review screenshots of revision v14.
//
//   node designs/preview.mjs 4311
//   node designs/romi-next/revision-v14/shots.cjs [base] [outDir] [filter]
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('@playwright/test')

const BASE = process.argv[2] || 'http://127.0.0.1:4311/romi-next/revision-v14'
const OUT = process.argv[3] || path.join(__dirname, 'screenshots')
const FILTER = process.argv[4] || ''

const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }

// name, page, viewport, theme, then an optional step once it has loaded.
const SHOTS = [
  ['public-cards', 'public.html', DESKTOP, 'light'],
  ['public-cards-dark', 'public.html', DESKTOP, 'dark'],
  ['public-list', 'public.html', DESKTOP, 'light', (p) => p.getByRole('button', { name: '列表', exact: true }).click()],
  ['public-cards-mobile', 'public.html', MOBILE, 'light'],
  ['public-list-mobile', 'public.html', MOBILE, 'dark', (p) => p.getByRole('button', { name: '列表', exact: true }).click()],
  ['detail', 'public.html#node-1', DESKTOP, 'light'],
  ['detail-dark', 'public.html#node-1', DESKTOP, 'dark'],
  ['detail-mobile', 'public.html#node-1', MOBILE, 'light'],
  ['admin-nodes', 'index.html#nodes', DESKTOP, 'light'],
  ['admin-nodes-dark', 'index.html#nodes', DESKTOP, 'dark'],
  ['admin-nodes-mobile', 'index.html#nodes', MOBILE, 'light'],
  ['admin-detail', 'index.html#node-1', DESKTOP, 'light'],
  ['system', 'system.html', { width: 1440, height: 900 }, 'light', null, true],
  ['system-mobile', 'system.html', MOBILE, 'light', null, true],
]

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const failures = []
  for (const [name, target, viewport, theme, step, fullPage] of SHOTS) {
    if (FILTER && !name.includes(FILTER)) continue
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height },
      isMobile: !!viewport.isMobile, hasTouch: !!viewport.hasTouch, deviceScaleFactor: viewport.deviceScaleFactor || 1 })
    const page = await context.newPage()
    const errors = []
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    page.on('pageerror', (e) => errors.push(e.message))
    const [file, hash] = target.split('#')
    const sep = file.includes('?') ? '&' : '?'
    await page.goto(`${BASE}/${file}${sep}theme=${theme}${hash ? '#' + hash : ''}`, { waitUntil: 'networkidle' })
    await page.locator('[data-screen-id]').first().waitFor({ timeout: 30_000 })
    if (step) await step(page)
    await page.waitForTimeout(150)
    await page.screenshot({ path: path.join(OUT, `v14-${name}.png`), fullPage: !!fullPage, animations: 'disabled', caret: 'hide' })
    if (errors.length) failures.push(`${name}: ${errors.join(' | ')}`)
    console.log('wrote', `v14-${name}.png`)
    await context.close()
  }
  await browser.close()
  if (failures.length) {
    console.error(failures.join('\n'))
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
