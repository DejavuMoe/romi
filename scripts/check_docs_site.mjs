import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'docs/.vitepress/dist')
assert(existsSync(join(output, 'index.html')), 'run pnpm docs:build first')

const socket = createServer()
await new Promise(resolveReady => socket.listen(0, '127.0.0.1', resolveReady))
const port = socket.address().port
await new Promise(resolveClosed => socket.close(resolveClosed))
const origin = `http://127.0.0.1:${port}`
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const server = spawn(pnpm, ['--dir', 'docs', 'exec', 'vitepress', 'preview', '.', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore', shell: process.platform === 'win32' })
let browser

try {
  let ready = false
  for (let attempt = 0; attempt < 40; attempt++) {
    if (server.exitCode !== null) throw new Error('VitePress preview exited before serving')
    try {
      ready = (await fetch(origin)).ok
      if (ready) break
    } catch { /* preview is starting */ }
    await delay(250)
  }
  assert(ready, 'VitePress preview did not start')

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const pages = readdirSync(output, { recursive: true }).filter(file => file.endsWith('.html'))
  const links = new Set()

  for (const file of pages) {
    const path = '/' + file.replaceAll('\\', '/')
    const response = await page.goto(origin + path)
    assert.equal(response.status(), 200, path)
    const navigation = await page.locator('.VPNavBarMenu a[href], .VPSidebar a[href], .VPFeature a[href]').evaluateAll(anchors => anchors.map(anchor => anchor.href))
    for (const href of navigation) assert.equal(new URL(href).origin, origin, `document navigation left the site: ${href}`)
    for (const href of await page.locator('a[href]').evaluateAll(anchors => anchors.map(anchor => anchor.href))) {
      const url = new URL(href)
      if (url.origin === origin) links.add(decodeURIComponent(url.pathname))
    }
  }
  for (const path of links) {
    const file = resolve(output, path.slice(1) || 'index.html')
    assert(!relative(output, file).startsWith('..') && existsSync(file), `broken site link: ${path}`)
  }

  await page.goto(origin + '/deployment.html')
  await page.getByRole('button', { name: '搜索文档' }).click()
  await page.locator('#localsearch-input').fill('备份')
  const result = page.getByRole('link', { name: /存储架构.*备份格式与限制/ })
  await result.waitFor({ state: 'visible' })
  await result.click()
  assert(page.url().startsWith(origin + '/storage.html'), 'search result left the docs site')

  for (const width of [320, 390, 1360]) {
    await page.setViewportSize({ width, height: 850 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `horizontal overflow at ${width}px`)
  }
  assert.deepEqual(errors, [], 'browser errors')
  console.log(`PASS: ${pages.length} documentation pages, ${links.size} local routes/assets, search and responsive layout`)
} finally {
  await browser?.close()
  server.kill()
}
