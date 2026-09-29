// Review screenshots of revision v15. States and their steps come from exercise.cjs.
//
//   node designs/preview.mjs 4311
//   node designs/romi-next/revision-v15/shots.cjs [base] [outDir] [filter]
//
// CHROME=<path> uses an installed Chrome instead of Playwright's own browser.
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('@playwright/test')
const { STATES } = require('./exercise.cjs')

const BASE = process.argv[2] || 'http://127.0.0.1:4311/romi-next/revision-v15'
const OUT = process.argv[3] || path.join(__dirname, 'screenshots')
const FILTER = process.argv[4] || ''

const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }

// file name, state, viewport, theme, full page, language
const SHOTS = [
  ['public-cards', 'public-cards', DESKTOP, 'light'],
  ['public-cards-dark', 'public-cards', DESKTOP, 'dark'],
  ['public-cards-full', 'public-cards', DESKTOP, 'light', true],
  ['public-list', 'public-list', DESKTOP, 'light'],
  ['public-globe-dark', 'public-globe', DESKTOP, 'dark'],
  ['public-globe-pinned', 'public-globe-pinned', DESKTOP, 'light'],
  ['public-palette', 'public-palette', DESKTOP, 'dark'],
  ['public-cards-mobile', 'public-cards', MOBILE, 'light'],
  ['public-cards-mobile-dark', 'public-cards', MOBILE, 'dark'],
  ['public-list-mobile', 'public-list', MOBILE, 'dark'],
  ['detail', 'public-detail', DESKTOP, 'light', true],
  ['detail-dark', 'public-detail', DESKTOP, 'dark', true],
  ['detail-traffic', 'public-detail-traffic', DESKTOP, 'dark'],
  ['detail-latency', 'public-detail-latency', DESKTOP, 'light'],
  ['detail-offline', 'public-detail-offline', DESKTOP, 'light'],
  ['detail-mobile', 'public-detail', MOBILE, 'light', true],
  ['public-offline', 'public-offline', DESKTOP, 'light'],
  ['public-loading', 'public-loading', DESKTOP, 'dark'],
  ['public-closed', 'public-closed', DESKTOP, 'dark'],
  ['login', 'login', DESKTOP, 'dark'],
  ['login-error-light', 'login-error', DESKTOP, 'light'],
  ['login-mobile', 'login', MOBILE, 'dark'],
  ['admin-nodes', 'admin-nodes', DESKTOP, 'light'],
  ['admin-nodes-dark', 'admin-nodes', DESKTOP, 'dark'],
  ['admin-nodes-mobile', 'admin-nodes', MOBILE, 'light'],
  ['admin-inspector', 'admin-inspector', DESKTOP, 'light'],
  ['admin-inspector-billing', 'admin-inspector-billing', DESKTOP, 'dark'],
  ['admin-inspector-install', 'admin-inspector-install', DESKTOP, 'light'],
  ['admin-add-install', 'admin-add-install', DESKTOP, 'dark'],
  ['admin-add-joined', 'admin-add-joined', DESKTOP, 'dark'],
  ['admin-register-open', 'admin-register-open', DESKTOP, 'light'],
  ['admin-detail', 'admin-detail', DESKTOP, 'dark', true],
  ['admin-probes', 'admin-probes', DESKTOP, 'light'],
  ['admin-notify', 'admin-notify', DESKTOP, 'light', true],
  ['admin-data', 'admin-data', DESKTOP, 'dark', true],
  ['admin-restore-progress', 'admin-restore-progress', DESKTOP, 'light'],
  ['admin-security', 'admin-security', DESKTOP, 'light'],
  ['admin-settings', 'admin-settings', DESKTOP, 'dark', true],
  ['admin-palette', 'admin-palette', DESKTOP, 'light'],
  ['system', 'system', DESKTOP, 'light', true],
  ['system-mobile', 'system', MOBILE, 'light', true],
  ['en-public-cards', 'public-cards', DESKTOP, 'light', true, 'en'],
  ['en-public-cards-dark', 'public-cards', DESKTOP, 'dark', false, 'en'],
  ['en-public-cards-mobile', 'public-cards', MOBILE, 'light', false, 'en'],
  ['en-detail', 'public-detail', DESKTOP, 'light', true, 'en'],
  ['en-login', 'login', DESKTOP, 'dark', false, 'en'],
  ['en-admin-nodes', 'admin-nodes', DESKTOP, 'light', false, 'en'],
  ['en-admin-inspector', 'admin-inspector', DESKTOP, 'dark', false, 'en'],
  ['en-admin-register-open', 'admin-register-open', DESKTOP, 'light', false, 'en'],
  ['en-admin-notify', 'admin-notify', DESKTOP, 'light', true, 'en'],
  ['en-admin-data', 'admin-data', DESKTOP, 'dark', true, 'en'],
  ['en-admin-settings', 'admin-settings', DESKTOP, 'light', true, 'en'],
  ['en-system', 'system', DESKTOP, 'light', true, 'en'],
]

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
  const failures = []
  for (const [name, state, viewport, theme, fullPage, lang = 'zh-CN'] of SHOTS) {
    if (FILTER && !name.includes(FILTER)) continue
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: !!viewport.isMobile,
      hasTouch: !!viewport.hasTouch,
      deviceScaleFactor: viewport.deviceScaleFactor || 1,
      locale: lang === 'en' ? 'en-US' : 'zh-CN',
    })
    const page = await context.newPage()
    const errors = []
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()))
    page.on('pageerror', (e) => errors.push(e.message))
    const [file, step] = STATES[state]
    const [base, hash] = file.split('#')
    await page.goto(`${BASE}/${base}${base.includes('?') ? '&' : '?'}theme=${theme}&lang=${lang}${hash ? `#${hash}` : ''}`)
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, null, { timeout: 15000 })
    // The globe fades its land in over the first second.
    await page.waitForTimeout(1800)
    if (step) await step(page)
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(OUT, `v15-${name}.png`), fullPage: !!fullPage, caret: 'hide' })
    if (errors.length) failures.push(`${name}: ${errors.join(' | ')}`)
    console.log('wrote', `v15-${name}.png`)
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
