// Where the panel leaves the operator after something happens around them: a
// sign-in, a section change mid-upload, a background refresh under a zoomed
// chart. None changes what is drawn; each used to discard what the operator
// had chosen.
import { test, expect, signIn, navigateAdmin } from './fixtures.mjs'

const PASSWORD = 'romi-e2e-only-password'

test('signing in lands on the page that asked for it', async ({ page }) => {
  await page.goto('/admin/security')
  await page.getByLabel('账号', { exact: true }).fill('admin')
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  // Not the node list: that is where every sign-in used to send the operator.
  await expect(page.getByRole('heading', { name: '账号与密码' })).toBeVisible()
  await expect(page).toHaveURL(/\/admin\/security$/)
})

test('the account password is the only way in', async ({ page }) => {
  await page.goto('/admin/')
  // One button on the sign-in screen, and no trace of the withdrawn GitHub path.
  const login = page.locator('.login-screen')
  await expect(login.getByRole('button')).toHaveText(['登录'])
  await expect(login).not.toContainText(/github/i)

  // The hub no longer serves it either, and no longer advertises it.
  for (const route of ['/api/auth/github', '/api/auth/github/callback?code=x&state=y']) {
    const response = await page.request.get(route, { maxRedirects: 0 })
    expect(response.status(), route).toBe(404)
  }
  const me = await (await page.request.get('/api/me')).json()
  expect(me).not.toHaveProperty('github')

  // Its settings are unknown now, not silently accepted.
  await page.getByLabel('账号', { exact: true }).fill('admin')
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '节点管理', exact: true })).toBeVisible()
  for (const key of ['github_client_id', 'github_client_secret', 'github_allowed_users']) {
    const response = await page.request.put('/api/settings', { data: { [key]: 'x' } })
    expect(response.status(), key).toBe(400)
  }
  const settings = await (await page.request.get('/api/settings')).json()
  expect(Object.keys(settings).filter((key) => key.startsWith('github'))).toEqual([])

  // The security page opens on the account form, with the sessions after it.
  await navigateAdmin(page, '安全')
  await expect(page.locator('main h3')).toHaveText(['账号与密码', '登录会话'])
  await expect(page.locator('main')).not.toContainText(/github/i)
})

test('a failed session list says so in its card and recovers on retry', async ({ page }) => {
  await signIn(page)
  let requests = 0
  await page.route('**/api/sessions', (route) => ++requests === 1
    ? route.fulfill({ status: 503, body: 'Temporary sessions failure' })
    : route.continue())
  await navigateAdmin(page, '安全')

  const card = page.locator('[data-slot="card"]', { has: page.getByRole('heading', { name: '登录会话' }) })
  const alert = card.getByRole('alert')
  await expect(alert).toContainText('会话列表加载失败')
  await expect(alert).toContainText('暂时无法确认其他设备的登录状态。')
  // The rest of the page is not held hostage by the list.
  await expect(page.getByRole('heading', { name: '账号与密码' })).toBeVisible()

  await card.getByRole('button', { name: '重试', exact: true }).click()
  await expect(alert).toHaveCount(0)
  await expect(card.getByText('当前设备', { exact: true })).toBeVisible()
})

test('leaving the data section stops an unfinished restore', async ({ page }) => {
  await signIn(page)

  // Hold every chunk so the upload is still running when the operator leaves.
  const chunks = []
  let release
  const held = new Promise((resolve) => { release = resolve })
  await page.route('**/api/db/restore?**', async (route) => {
    chunks.push(new URL(route.request().url()).searchParams.get('offset'))
    await held
    await route.continue().catch(() => {})
  })

  await navigateAdmin(page, '数据')
  // Two chunks' worth, so the first is not the final one and stays abortable.
  const size = 5 * 1024 * 1024
  await page.locator('input[type=file]').setInputFiles({
    name: 'romi-backup.tar.gz', mimeType: 'application/gzip', buffer: Buffer.alloc(size, 1),
  })
  await page.getByRole('button', { name: '确认恢复', exact: true }).click()
  await expect.poll(() => chunks.length).toBe(1)

  // Back, not the sidebar: the confirmation is modal, so the way out of the
  // section mid-upload is the browser's own history, which unmounts it without
  // passing through the dialog's cancel.
  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/nodes$/)
  await expect(page.getByText('已取消，数据库没有改动')).toBeVisible()
  release()

  // No further chunk went out, and the page did not reload itself out from under
  // the section the operator moved to.
  await page.waitForTimeout(1_500)
  expect(chunks).toEqual(['0'])
  await expect(page).toHaveURL(/\/admin\/nodes$/)
  await expect(page.getByRole('heading', { name: '节点管理', exact: true })).toBeVisible()
})

test('a zoomed latency chart stays zoomed across a refresh', async ({ page, hub }) => {
  const id = await hub.node('缩放节点', true)
  await signIn(page)

  // Synthetic history, because nothing in a test Hub produces probe samples. Each
  // answer rolls the window one minute forward, as the minute refresh does.
  let calls = 0
  await page.route(`**/api/nodes/${id}/metrics?**`, async (route) => {
    const end = 1_700_000_000 + calls * 60
    calls += 1
    const ping = Array.from({ length: 120 }, (_, i) => ({
      task_id: 1, ts: end - (119 - i) * 60, latency: 20 + (i % 7),
    }))
    await route.fulfill({ json: { metrics: [], ping, probes: { 1: '主站' } } })
  })

  await page.goto(`/admin/node/${id}`)
  await page.getByRole('tab', { name: '监测' }).click()
  const start = page.locator('.recharts-brush-traveller').first()
  await expect(start).toBeVisible()
  const box = await page.locator('.recharts-brush').boundingBox()

  // Move the left handle 40 rows in, by keyboard: the handles take focus and
  // step one row per arrow, which is also how a keyboard user zooms.
  await start.focus()
  for (let i = 0; i < 40; i += 1) await page.keyboard.press('ArrowRight')
  const zoomed = (await start.boundingBox()).x
  expect(zoomed - box.x, 'the handle moved in').toBeGreaterThan(box.width / 4)

  // Refresh with a window that has rolled forward.
  const served = calls
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect.poll(() => calls).toBe(served + 1)
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled()

  // Still zoomed: the handle did not snap back to the left edge. It may move by
  // the minute the window rolled, which is one step in 120.
  const after = (await start.boundingBox()).x
  expect(Math.abs(after - zoomed), 'the zoom survived the refresh').toBeLessThan(box.width / 20)
})
