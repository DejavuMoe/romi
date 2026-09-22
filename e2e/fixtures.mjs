import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test as base, expect } from '@playwright/test'

// Public test data, used only on the disposable loopback Hub created below.
const PASSWORD = 'romi-e2e-only-password'

export const test = base.extend({
  // Playwright requires an object pattern even when no fixtures are requested.
  // oxlint-disable-next-line eslint/no-empty-pattern
  hub: async ({}, use, testInfo) => {
    const binary = resolve(process.env.ROMI_E2E_BIN_DIR || 'target/debug', 'romi-hub')
    await access(binary).catch(() => { throw new Error('Hub binary missing: run make build or set ROMI_E2E_BIN_DIR') })
    const work = await mkdtemp(join(tmpdir(), 'romi-e2e-'))
    const credential = join(work, 'bootstrap-password')
    const child = spawn(binary, [
      '--listen', '127.0.0.1:0', '--db', join(work, 'romi.duckdb'),
      '--bootstrap-password-file', credential,
    ], { cwd: work, env: { ...process.env, ROMI_SITE: '', NO_COLOR: '1', ROMI_LOG: 'romi_hub=info' } })
    let log = ''
    let spawnError
    const secrets = new Set()
    const closed = new Promise((done) => child.once('close', done))
    child.on('error', (error) => { spawnError = error })
    for (const output of [child.stdout, child.stderr]) {
      output.on('data', (chunk) => { log = (log + chunk).slice(-128 * 1024) })
    }
    try {
      let url
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        if (spawnError || child.exitCode !== null || child.signalCode) throw new Error('Temporary Hub exited before listening')
        const address = log.match(/listening on (127\.0\.0\.1:\d+)/)?.[1]
        if (address) {
          const candidate = `http://${address}`
          if (await fetch(`${candidate}/healthz`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false)) {
            url = candidate
            break
          }
        }
        await delay(50)
      }
      if (!url) throw new Error('Temporary Hub did not become healthy within 20 seconds')
      for (const path of ['/admin/', '/']) {
        const response = await fetch(url + path, { signal: AbortSignal.timeout(1000) })
        if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
          throw new Error('Hub frontend assets missing: run make e2e after synchronizing the build mirror')
        }
      }
      let cookie = ''
      const request = async (path, { method = 'GET', body, headers = {} } = {}) => {
        // node:http preserves the explicit trusted-proxy Host used when seeding
        // nodes; fetch derives Host from the loopback URL instead.
        const response = await new Promise((done, reject) => {
          const req = httpRequest(url + path, {
            method, timeout: 10_000,
            headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
          }, done)
          req.on('error', reject)
          req.on('timeout', () => req.destroy(new Error('Test API request timed out')))
          req.end(body === undefined ? undefined : JSON.stringify(body))
        })
        for (const value of response.headers['set-cookie'] || []) {
          cookie = value.split(';')[0]
          secrets.add(cookie)
          secrets.add(cookie.slice(cookie.indexOf('=') + 1))
        }
        const chunks = []
        for await (const chunk of response) chunks.push(chunk)
        if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`${method} ${path}: HTTP ${response.statusCode}`)
        return response.statusCode === 204 ? undefined : JSON.parse(Buffer.concat(chunks).toString())
      }
      const bootstrap = (await readFile(credential, 'utf8')).trim()
      secrets.add(bootstrap)
      await request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: bootstrap } })
      await request('/api/settings', { method: 'PUT', body: { admin_password: PASSWORD } })
      await use({
        url, request,
        node: async (name, isPublic = false) => {
          // Same trusted-proxy simulation as scripts/smoke.py, on loopback only.
          const issued = await request('/api/nodes', {
            method: 'POST', body: { name, public: isPublic, traffic_reset_day: 1 },
            headers: { Host: 'romi.test', 'X-Forwarded-Proto': 'https' },
          })
          secrets.add(issued.token)
          return issued.id
        },
      })
    } finally {
      child.kill('SIGTERM')
      const kill = setTimeout(() => child.kill('SIGKILL'), 5_000)
      kill.unref()
      await closed
      clearTimeout(kill)
      if (testInfo.status !== testInfo.expectedStatus) {
        for (const secret of secrets) if (secret) log = log.replaceAll(secret, '[redacted]')
        await testInfo.attach('hub.log', { body: log, contentType: 'text/plain' })
      }
      await rm(work, { recursive: true, force: true })
    }
  },
  baseURL: async ({ hub }, use) => { await use(hub.url) },
  page: async ({ page }, use) => {
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await use(page)
    expect(errors, 'uncaught browser errors').toEqual([])
  },
})

export { expect }

export async function signIn(page) {
  await page.goto('/admin/')
  await page.getByLabel('账号', { exact: true }).fill('admin')
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '节点管理', exact: true })).toBeVisible()
}

export async function navigateAdmin(page, name) {
  await expect(page.locator('main h1')).toBeVisible()
  const menu = page.getByRole('button', { name: '打开导航', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: '后台导航' }).getByRole('button', { name, exact: true }).click()
}
