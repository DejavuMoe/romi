// Screenshots of the accessibility revision, for review.
//
//   node designs/preview.mjs 4311
//   node designs/romi-next/revision-v12/shots-a11y.cjs [base] [outDir]
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('@playwright/test')

const BASE = process.argv[2] || 'http://127.0.0.1:4311/romi-next/revision-v12'
const OUT = process.argv[3] || path.join(__dirname, 'screenshots')

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1326, height: 831 } })

  const shot = async (name) => {
    const file = path.join(OUT, `a11y-${name}.png`)
    await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' })
    console.log('wrote', path.basename(file))
  }

  // Focus rings only show for keyboard interaction, so drive the tabs by key.
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' })
  await page.locator('[data-screen-id="nodes"]').waitFor({ timeout: 30_000 })
  await page.getByText('东京 · edge-01').first().click()
  await page.locator('[data-screen-id="node-detail"]').waitFor()

  await page.getByRole('tab', { selected: true }).focus()
  await shot('tab-focus-resources')
  await page.keyboard.press('ArrowRight')
  await shot('tab-focus-after-arrow')

  await page.goto(`${BASE}/public.html`, { waitUntil: 'networkidle' })
  await page.locator('[data-screen-id="public"]').waitFor({ timeout: 30_000 })
  await shot('public-cards')

  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
