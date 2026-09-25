// Drives the session list's own failure state and captures it for review.
//
//   node designs/preview.mjs 4311
//   node designs/romi-next/revision-v12/exercise-sessions.cjs [base] [shotDir]
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('@playwright/test')

const BASE = process.argv[2] || 'http://127.0.0.1:4311/romi-next/revision-v12'
const SHOTS = process.argv[3] || path.join(__dirname, 'screenshots')

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1326, height: 831 } })
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(`${BASE}/index.html?state=sessions-error#security`, { waitUntil: 'networkidle' })
    await page.locator('[data-screen-id="security"]').waitFor({ timeout: 30_000 })
    const card = page.locator('.box:has(h2:text("登录会话"))')

    // The failure is the card's own: the account form beside it still works.
    const alert = card.getByRole('alert')
    await alert.waitFor()
    assert.match(await alert.innerText(), /会话列表加载失败/)
    assert.match(await alert.innerText(), /暂时无法确认其他设备的登录状态/)
    assert.equal(await card.getByText('2 个').count(), 0, 'no count for a list that did not load')
    assert.equal(await card.getByRole('button', { name: '撤销' }).count(), 0)
    assert.ok(await page.getByRole('button', { name: '修改密码' }).isVisible(), 'the rest of the page is usable')

    fs.mkdirSync(SHOTS, { recursive: true })
    await card.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(SHOTS, 'sessions-error.png'), animations: 'disabled', caret: 'hide' })

    const collector = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', '.agents', 'skills', 'prototype-first-ui', 'scripts', 'collect_dom_content.js'),
      'utf8',
    )
    await page.evaluate(collector)
    const report = await page.evaluate(() => window.__prototypeFirstUICollectDOMContent())
    fs.writeFileSync(path.join(__dirname, 'captures', 'sessions-error.json'), JSON.stringify(report, null, 2) + '\n')

    // Retry brings the list back.
    await card.getByRole('button', { name: '重试' }).click()
    await card.getByRole('button', { name: '撤销' }).first().waitFor()
    assert.equal(await card.getByRole('alert').count(), 0)
    await page.screenshot({ path: path.join(SHOTS, 'sessions-retried.png'), animations: 'disabled', caret: 'hide' })

    assert.deepEqual(errors, [], 'no console or page errors')
    console.log('session list failure exercised: card-local alert, page usable, retry restores the list.')
  } catch (failure) {
    console.error('page errors:', errors)
    throw failure
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
