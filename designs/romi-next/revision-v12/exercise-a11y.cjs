// Drives the accessibility revision with the keyboard and reads back what
// assistive technology would get.
//
// Points at an already-running preview server so the reviewer and this script
// see the same bytes:
//   node designs/preview.mjs 4311
//   node designs/romi-next/revision-v12/exercise-a11y.cjs [base]
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('@playwright/test')

const BASE = process.argv[2] || 'http://127.0.0.1:4311/romi-next/revision-v12'

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1326, height: 831 } })
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(e.message))

  try {
    // --- history tabs --------------------------------------------------
    await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' })
    await page.locator('[data-screen-id="nodes"]').waitFor({ timeout: 30_000 })
    await page.getByRole('link', { name: '东京 · edge-01' }).or(page.getByText('东京 · edge-01')).first().click()
    await page.locator('[data-screen-id="node-detail"]').waitFor()

    const tabs = page.getByRole('tab')
    assert.equal(await tabs.count(), 3, 'three history tabs')

    // One stop, not three: only the selected tab is in the tab order.
    const reachable = await tabs.evaluateAll((all) => all.map((t) => t.tabIndex))
    assert.deepEqual(reachable, [0, -1, -1], `roving tabindex, got ${reachable}`)

    // Each tab names the panel it controls, and the panel names its tab.
    const selected = page.getByRole('tab', { selected: true })
    const controls = await selected.getAttribute('aria-controls')
    const panel = page.locator(`#${controls}`)
    await panel.waitFor()
    assert.equal(await panel.getAttribute('role'), 'tabpanel')
    assert.equal(await panel.getAttribute('aria-labelledby'), await selected.getAttribute('id'))

    // Arrows move the selection and carry focus with it.
    await selected.focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.getByRole('tab', { selected: true }).textContent(), '监测')
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '监测')
    await page.keyboard.press('End')
    assert.equal(await page.getByRole('tab', { selected: true }).textContent(), '流量')
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.getByRole('tab', { selected: true }).textContent(), '资源', 'wraps around')
    await page.keyboard.press('Home')
    assert.equal(await page.getByRole('tab', { selected: true }).textContent(), '资源')

    // --- public cards --------------------------------------------------
    await page.goto(`${BASE}/public.html`, { waitUntil: 'networkidle' })
    await page.locator('[data-screen-id="public"]').waitFor({ timeout: 30_000 })
    const card = page.locator('a.node-card').first()
    await card.waitFor()

    // The card's accessible name is its own content. With an aria-label it was
    // "查看 <名称>" and everything the card shows was replaced by that.
    const name = await card.evaluate((element) => element.getAttribute('aria-label'))
    assert.equal(name, null, 'the card carries no overriding label')
    const announced = await card.evaluate((element) => element.innerText.replace(/\s+/g, ' ').trim())
    for (const expected of ['东京 · edge-01', 'CPU', 'RAM']) {
      assert.ok(announced.includes(expected), `the card still announces ${expected}: ${announced}`)
    }

    assert.deepEqual(errors, [], 'no console or page errors')

    // Content inventory input for the two surfaces this touches.
    const collector = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', '.agents', 'skills', 'prototype-first-ui', 'scripts', 'collect_dom_content.js'),
      'utf8',
    )
    await page.evaluate(collector)
    const report = await page.evaluate(() => window.__prototypeFirstUICollectDOMContent())
    fs.writeFileSync(
      path.join(__dirname, 'captures', 'v13-public-cards.json'),
      JSON.stringify(report, null, 2) + '\n',
    )
    console.log('a11y revision exercised: roving tabs, arrow/Home/End, panel wiring, card content intact.')
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
