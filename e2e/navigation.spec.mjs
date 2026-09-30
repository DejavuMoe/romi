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
  // The account form is the only sign-in path; the other buttons change presentation.
  const login = page.locator('.login')
  await expect(login.locator('button[type=submit]')).toHaveText(['登录'])
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
  await expect(page.getByRole('heading', { name: '节点', exact: true })).toBeVisible()
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
  await expect(page.getByRole('heading', { name: '节点', exact: true })).toBeVisible()
})

test('a zoomed latency chart stays zoomed across a refresh', async ({ page, hub }) => {
  const id = await hub.node('缩放节点', true)
  await signIn(page)
  await page.clock.install()

  // Synthetic history, because nothing in a test Hub produces probe samples. Each
  // answer rolls the window one minute forward, as the minute refresh does.
  let calls = 0
  await page.route(`**/api/nodes/${id}/metrics?**`, async (route) => {
    const end = Math.floor(Date.now() / 60_000) * 60 + calls * 60
    calls += 1
    const ping = Array.from({ length: 120 }, (_, i) => ({
      task_id: 1, ts: end - (119 - i) * 60, latency: 20 + (i % 7),
    }))
    await route.fulfill({ json: { metrics: [], ping, probes: { 1: '主站' } } })
  })

  await page.goto(`/admin/node/${id}`)
  await page.getByRole('tab', { name: '监测' }).click()
  const plot = page.locator('.chart-plot').first()
  await expect(plot).toBeVisible()
  await expect(plot.locator('.chart-svg')).toBeVisible()
  await plot.scrollIntoViewIfNeeded()
  const box = await plot.boundingBox()
  await page.mouse.move(box.x + box.width * 0.3, box.y + 50)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.7, box.y + 50, { steps: 8 })
  await page.mouse.up()
  const note = page.locator('.zoom-note')
  await expect(note).toBeVisible()
  const zoomed = await note.locator('.num').textContent()

  // Refresh with a window that has rolled forward.
  const served = calls
  await page.clock.fastForward(61_000)
  await expect.poll(() => calls).toBe(served + 1)
  await expect(note.locator('.num')).toHaveText(zoomed)
})

test('the admin detail records live pushes into its three sparklines', async ({ page, hub }) => {
  const id = await hub.node('实时详情', true)
  await signIn(page)
  const m = { uptime: 100, cpu: 25, load: [0.1, 0.2, 0.3], mem_total: 1024, mem_used: 512,
    swap_total: 0, swap_used: 0, disk_total: 2048, disk_used: 1024, net_rx: 10, net_tx: 20,
    total_rx: 100, total_tx: 200, month_rx: 50, month_tx: 100, tcp: 3, udp: 4, procs: 20 }
  await page.route('**/api/nodes', async route => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({ response, json: { ...body, nodes: body.nodes.map(n => ({ ...n, online: true, metrics: m })) } })
  })
  await page.routeWebSocket('**/api/ws', ws => {
    const server = ws.connectToServer()
    let tick = 0
    server.onMessage(message => {
      const body = JSON.parse(message)
      tick++
      ws.send(JSON.stringify({ ...body, nodes: body.nodes.map(n => ({ ...n, online: true, metrics: { ...m, cpu: m.cpu + tick } })) }))
    })
  })
  await page.goto(`/admin/node/${id}`)
  await expect(page.locator('.vitals .spark .spark-line')).toHaveCount(3)
  await expect(page.locator('.vitals .spark.is-idle')).toHaveCount(0)
})
