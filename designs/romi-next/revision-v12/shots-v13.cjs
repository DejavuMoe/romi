// Screenshots of the surfaces this revision changes, for review.
//
// Points at an already-running preview server rather than starting its own, so
// the reviewer and these images see the same bytes.
//
//   node designs/preview.mjs 4311
//   node designs/romi-next/revision-v12/shots-v13.cjs [base] [outDir]
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('@playwright/test')

const BASE = process.argv[2] || 'http://127.0.0.1:4311/romi-next/revision-v12'
const OUT = process.argv[3] || path.join(__dirname, 'screenshots')

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1326, height: 831 } })
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(e.message))

  const shot = async (name, clip) => {
    const file = path.join(OUT, `v13-${name}.png`)
    await page.screenshot({ path: file, animations: 'disabled', caret: 'hide', ...clip })
    console.log('wrote', path.relative(process.cwd(), file))
  }

  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' })
  await page.locator('[data-screen-id="nodes"]').waitFor({ timeout: 30_000 })

  // 1. The management list, where a private node is marked.
  await shot('nodes')

  // 2. The edit dialog showing the new visibility control on a private node.
  await page.getByRole('button', { name: '编辑菜单 香港 · relay-03', exact: true }).click()
  await page.getByRole('button', { name: '编辑节点', exact: true }).click()
  await page.getByRole('combobox', { name: '公开状态页' }).waitFor()
  await shot('node-edit')

  // 3. The same control open, so the two choices are visible.
  await page.getByRole('combobox', { name: '公开状态页' }).click()
  await page.getByRole('option', { name: '显示', exact: true }).waitFor()
  await shot('node-edit-open')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.locator('dialog[open]').waitFor({ state: 'detached' })

  // 4. The account form with the new current-password field.
  await page.locator('nav.side-nav a[href="#security"]').click()
  await page.locator('[data-screen-id="security"]').waitFor()
  await shot('security')

  // 5. The refusal a wrong current password produces, in place.
  const account = page.locator('form:has(h2:text("账号与密码"))')
  await account.getByLabel('当前密码', { exact: true }).fill('wrong-password')
  await account.getByLabel('新密码', { exact: true }).fill('another-long-password')
  await account.getByRole('button', { name: '修改密码', exact: true }).click()
  await account.locator('[role="alert"]').waitFor()
  await shot('security-refused')

  // 6. The status page, which now lists only published nodes.
  await page.goto(`${BASE}/public.html`, { waitUntil: 'networkidle' })
  await page.locator('[data-screen-id="public"]').waitFor({ timeout: 30_000 })
  await shot('public')

  if (errors.length) {
    console.error('console or page errors:', errors)
    process.exitCode = 1
  }
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
