// Drives the revision that makes the account password the only sign-in, and
// re-captures every surface the removed GitHub copy appeared on.
//
//   node designs/preview.mjs 4311
//   node designs/romi-next/revision-v12/exercise-local-login.cjs [base] [shotDir]
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('@playwright/test')

const BASE = process.argv[2] || 'http://127.0.0.1:4311/romi-next/revision-v12'
const SHOTS = process.argv[3] || path.join(__dirname, 'screenshots')
const collector = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '..', '.agents', 'skills', 'prototype-first-ui', 'scripts', 'collect_dom_content.js'),
  'utf8',
)

async function capture(page, name) {
  await page.evaluate(collector)
  const report = await page.evaluate(() => window.__prototypeFirstUICollectDOMContent())
  fs.writeFileSync(path.join(__dirname, 'captures', `${name}.json`), JSON.stringify(report, null, 2) + '\n')
}

async function noGithub(page, where) {
  const text = await page.evaluate(() => document.body.innerText)
  assert.ok(!/github|oauth|client (id|secret)/i.test(text), `${where} still mentions GitHub: ${text.match(/.{0,30}github.{0,30}/i)}`)
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1326, height: 831 } })
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    // --- sign-in: the account form is the only way in ----------------------
    await page.goto(`${BASE}/index.html?state=login`, { waitUntil: 'networkidle' })
    await page.locator('[data-screen-id="login"]').waitFor({ timeout: 30_000 })
    await noGithub(page, 'the sign-in screen')
    const buttons = await page.locator('[data-screen-id="login"] button').allInnerTexts()
    assert.deepEqual(buttons.map((b) => b.trim()), ['登录'], `one way in, got ${buttons}`)
    await page.screenshot({ path: path.join(SHOTS, 'local-login.png'), animations: 'disabled', caret: 'hide' })
    await capture(page, 'approved-login')

    await page.getByLabel('账号', { exact: true }).fill('admin')
    await page.getByLabel('密码', { exact: true }).fill('romi-prototype')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.locator('[data-screen-id="nodes"]').waitFor()

    // --- security: the account form leads, sessions follow -----------------
    await page.goto(`${BASE}/index.html#security`, { waitUntil: 'networkidle' })
    await page.locator('[data-screen-id="security"]').waitFor({ timeout: 30_000 })
    await noGithub(page, 'the security page')
    const headings = await page.locator('[data-screen-id="security"] h2').allInnerTexts()
    assert.deepEqual(headings.map((h) => h.trim()), ['账号与密码', '登录会话'], `sections, got ${headings}`)
    await page.screenshot({ path: path.join(SHOTS, 'local-security.png'), animations: 'disabled', caret: 'hide' })

    // The current-password capture is of this same page, so it is retaken here.
    await capture(page, 'v13-current-password')

    // And the session list's failure state, from the revision awaiting review.
    await page.goto(`${BASE}/index.html?state=sessions-error#security`, { waitUntil: 'networkidle' })
    await page.locator('[data-screen-id="security"] .box:has(h2:text("登录会话")) [role="alert"]').waitFor()
    await noGithub(page, 'the security page in its sessions-error state')
    await capture(page, 'sessions-error')

    assert.deepEqual(errors, [], 'no console or page errors')
    console.log('local-only sign-in exercised: one way in, no GitHub card, captures retaken.')
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
