// Drives the two controls added in v13 against the served prototype and writes
// the rendered strings the content inventory is built from. Design-only: it
// starts a static server over the prototype directory and never touches a hub.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { chromium } = require('@playwright/test')

const ROOT = path.resolve(__dirname, '..', '..')
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.jsx': 'text/babel', '.css': 'text/css', '.json': 'application/json' }

function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]))
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)))
}

async function main() {
  const server = await serve()
  const base = `http://127.0.0.1:${server.address().port}/romi-next/revision-v12`
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1326, height: 831 } })
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('requestfailed', (r) => errors.push(`${r.url()} ${r.failure()?.errorText || ''}`))

  try {
    // --- node visibility -------------------------------------------------
    await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' })
    // The prototype transforms its JSX in the browser, so the shell is served
    // long before the tree mounts. It opens already signed in.
    await page.locator('[data-screen-id="nodes"]').waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: '编辑菜单 香港 · relay-03', exact: true }).click()
    await page.getByRole('button', { name: '编辑节点', exact: true }).click()

    const visibility = page.getByRole('combobox', { name: '公开状态页' })
    await visibility.waitFor()
    assert.equal(await visibility.textContent(), '不显示', 'a private fixture opens on 不显示')
    await visibility.click()
    await page.getByRole('option', { name: '显示', exact: true }).click()
    assert.equal(await visibility.textContent(), '显示')
    const nodeDialog = await page.locator("dialog[open]").first().innerText()

    // --- current password ------------------------------------------------
    await page.keyboard.press('Escape')
    await page.locator('dialog[open]').waitFor({ state: 'detached' })
    // The sidebar links read "05 安全", so address the route rather than the label.
    await page.locator('nav.side-nav a[href="#security"]').click()
    await page.locator('[data-screen-id="security"]').waitFor()
    const account = page.locator('form:has(h2:text("账号与密码"))')
    await account.getByLabel('当前密码', { exact: true }).fill('wrong-password')
    await account.getByLabel('新密码', { exact: true }).fill('another-long-password')
    await account.getByRole('button', { name: '修改密码', exact: true }).click()
    const refusal = await account.locator('[role="alert"]').innerText()
    assert.equal(refusal, '当前密码不正确', 'a wrong current password is refused in place')

    await account.getByLabel('当前密码', { exact: true }).fill('romi-prototype')
    assert.equal(await account.locator('[role="alert"]').count(), 0, 'the refusal clears on edit')
    await account.getByRole('button', { name: '修改密码', exact: true }).click()
    await page.getByRole('button', { name: '确认', exact: true }).click()
    const securityText = await account.innerText()

    assert.deepEqual(errors, [], 'no console or page errors')

    console.log('v13 controls exercised: visibility switch, refused and accepted password change.')
    console.log(`node dialog: ${nodeDialog.split('\n').length} lines; security card: ${securityText.split('\n').length} lines`)

    // Content inventory input, in the package collector's own format so
    // content_audit.py can seed from it beside the existing captures. Taken on
    // the two surfaces this revision changed, each in the state that shows the
    // new control.
    const collector = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', '.agents', 'skills', 'prototype-first-ui', 'scripts', 'collect_dom_content.js'),
      'utf8',
    )
    for (const [name, open] of [
      ['v13-node-visibility', async () => {
        await page.locator('nav.side-nav a[href="#nodes"]').click()
        await page.getByRole('button', { name: '编辑菜单 香港 · relay-03', exact: true }).click()
        await page.getByRole('button', { name: '编辑节点', exact: true }).click()
        await page.getByRole('combobox', { name: '公开状态页' }).waitFor()
      }],
      ['v13-current-password', async () => {
        await page.locator('nav.side-nav a[href="#security"]').click()
        await page.locator('[data-screen-id="security"]').waitFor()
      }],
    ]) {
      await open()
      await page.evaluate(collector)
      const report = await page.evaluate(() => window.__prototypeFirstUICollectDOMContent())
      fs.writeFileSync(
        path.join(__dirname, 'captures', `${name}.json`),
        JSON.stringify(report, null, 2) + '\n',
      )
      await page.keyboard.press('Escape')
    }
    console.log('captured the two changed surfaces for the content inventory.')
  } catch (failure) {
    // The prototype compiles its JSX in the browser, so a syntax slip shows up
    // as an empty page and a timeout rather than as a thrown error.
    console.error('page errors:', errors)
    console.error('body:', (await page.locator('body').innerHTML()).slice(0, 600))
    throw failure
  } finally {
    await browser.close()
    server.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
