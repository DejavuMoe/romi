import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'docs/.vitepress/dist')
assert(existsSync(join(output, 'index.html')), 'run pnpm docs:build first')
assert.equal(readFileSync(join(output, 'logo.svg'), 'utf8'), readFileSync(join(root, 'web/public/favicon.svg'), 'utf8'), 'docs must use the product logo')

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
  const anchors = new Map()
  let layouts = 0

  for (const file of pages) {
    const path = '/' + file.replaceAll('\\', '/')
    const response = await page.goto(origin + path)
    assert.equal(response.status(), 200, path)
    anchors.set(path, new Set(await page.locator('[id]').evaluateAll(elements => elements.map(element => element.id))))
    const navigation = await page.locator('.VPNavBarMenu a[href], .VPSidebar a[href], .VPFeature a[href]').evaluateAll(anchors => anchors.map(anchor => anchor.href))
    for (const href of navigation) assert.equal(new URL(href).origin, origin, `document navigation left the site: ${href}`)
    for (const href of await page.locator('a[href]').evaluateAll(anchors => anchors.map(anchor => anchor.href))) {
      const url = new URL(href)
      if (url.origin === origin) links.add(url.pathname + url.hash)
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme)
      for (const width of [320, 390, 768, 1360]) {
        await page.setViewportSize({ width, height: 850 })
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `${path}: horizontal overflow at ${width}px (${theme})`)
        layouts++
      }
    }
  }
  for (const href of links) {
    const url = new URL(href, origin)
    const path = decodeURIComponent(url.pathname)
    const file = resolve(output, path.slice(1) || 'index.html')
    assert(!relative(output, file).startsWith('..') && existsSync(file), `broken site link: ${path}`)
    if (url.hash) {
      assert(anchors.get(path === '/' ? '/index.html' : path)?.has(decodeURIComponent(url.hash.slice(1))), `broken anchor: ${href}`)
    }
  }

  await page.goto(origin + '/deployment.html')
  await page.getByRole('button', { name: '搜索文档' }).click()
  await page.locator('#localsearch-input').fill('备份')
  const result = page.getByRole('link', { name: /存储架构.*备份格式与限制/ })
  await result.waitFor({ state: 'visible' })
  await result.click()
  assert(page.url().startsWith(origin + '/storage.html'), 'search result left the docs site')

  await page.setViewportSize({ width: 390, height: 850 })
  await page.goto(origin + '/quick-start.html')
  await page.getByRole('button', { name: '目录', exact: true }).click()
  await page.locator('.VPSidebar').getByRole('link', { name: '日常使用', exact: true }).click()
  await page.waitForURL('**/guide.html')
  await page.waitForFunction(() => !document.querySelector('.VPSidebar')?.classList.contains('open'))
  assert.deepEqual(errors, [], 'browser errors')
  console.log(`PASS: ${pages.length} documentation pages, ${links.size} local links/anchors, ${layouts} layouts, product logo, search and mobile navigation`)
} finally {
  await browser?.close()
  server.kill()
}
