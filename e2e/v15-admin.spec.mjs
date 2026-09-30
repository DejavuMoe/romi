import { test, expect } from './fixtures.mjs'
import { readFile } from 'node:fs/promises'

// Tokens are shown in these flows. Failure screenshots must not capture them.
test.use({ screenshot: 'off' })

async function securePanel(page, hub) {
  const version = (await readFile(new URL('../VERSION', import.meta.url), 'utf8')).trim()
  const online = new Set()
  const timers = []
  // A loopback trusted proxy makes the browser origin secure without an external
  // domain. Only distribution availability and Agent reports are UI fixtures;
  // authentication, node creation, settings and registration reach the real Hub.
  await page.route('https://romi.test/**', async route => {
    const url = new URL(route.request().url())
    const response = await route.fetch({ url: hub.url + url.pathname + url.search,
      headers: { ...await route.request().allHeaders(), host: 'romi.test', 'x-forwarded-proto': 'https' } })
    if (url.pathname === '/api/me') await route.fulfill({ response, json: { ...await response.json(),
      site: 'https://romi.test', can_provision: true, distribution: { version, architecture: 'x86_64' } } })
    else await route.fulfill({ response })
  })
  await page.routeWebSocket('wss://romi.test/api/ws', ws => {
    const push = async () => {
      try {
        const body = await hub.request('/api/nodes')
        const now = Math.floor(Date.now() / 1000)
        body.nodes = body.nodes.map(node => !online.has(node.id) ? node : { ...node, online: true, last_seen: now,
          online_since: now - 10, cpu_cores: 2, mem_total: 1024, disk_total: 2048, agent_version: version,
          metrics: { uptime: 100, cpu: 25, load: [0.1, 0.2, 0.3], mem_total: 1024, mem_used: 512,
            swap_total: 0, swap_used: 0, disk_total: 2048, disk_used: 1024, net_rx: 10, net_tx: 20,
            total_rx: 100, total_tx: 200, month_rx: 50, month_tx: 100, tcp: 3, udp: 4, procs: 20 } })
        ws.send(JSON.stringify(body))
      } catch { /* The disposable Hub closes after the test. */ }
    }
    void push()
    const timer = setInterval(push, 500)
    timer.unref()
    timers.push(timer)
    ws.onClose(() => clearInterval(timer))
  })
  await page.goto('https://romi.test/admin/')
  await page.getByLabel('账号', { exact: true }).fill('admin')
  await page.getByLabel('密码', { exact: true }).fill('romi-e2e-only-password')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.locator('.admin-title h1')).toHaveText('节点')
  return { online, close: () => timers.forEach(clearInterval) }
}

test('the three-step add flow creates one node and waits for its first report', async ({ page, hub }) => {
  const panel = await securePanel(page, hub)
  try {
    await page.getByRole('button', { name: '添加节点', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('名称', { exact: true }).fill('New edge')
    await dialog.getByRole('button', { name: '添加', exact: true }).click()
    await expect(dialog.getByText('等待 Agent 首次上报', { exact: true })).toBeVisible()
    const nodes = (await hub.request('/api/nodes')).nodes
    expect(nodes).toHaveLength(1)
    expect(nodes[0].name).toBe('New edge')
    expect(nodes[0].public).toBe(true)
    await expect(dialog.getByRole('button', { name: '查看节点', exact: true })).toHaveCount(0)
    panel.online.add(nodes[0].id)
    await expect(dialog.getByRole('button', { name: '查看节点', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '查看节点', exact: true }).click()
    await expect(page).toHaveURL(new RegExp('/admin/node/' + nodes[0].id + '$'))
    await expect(page.getByRole('button', { name: '管理节点', exact: true })).toBeVisible()
  } finally { panel.close() }
})

test('registration lists only nodes added after the window opened and survives reload', async ({ page, hub }) => {
  await hub.node('Before window')
  const panel = await securePanel(page, hub)
  try {
    await page.getByRole('button', { name: '批量注册', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: '开启一小时窗口', exact: true }).click()
    await expect(dialog.getByText('等待节点注册', { exact: true })).toBeVisible()
    await hub.node('Joined window')
    const window = await hub.request('/api/settings')
    const joined = (await hub.request('/api/nodes')).nodes.find(node => node.name === 'Joined window')
    expect(joined.created_at).toBeGreaterThanOrEqual(Number(window.register_until) - 3600)
    await expect(dialog.locator('.registered-list')).toContainText('Joined window')
    await expect(dialog.locator('.registered-list')).not.toContainText('Before window')
    await page.reload()
    await page.getByRole('button', { name: '批量注册', exact: true }).click()
    await expect(dialog.locator('.registered-list')).toContainText('Joined window')
    await dialog.getByRole('button', { name: '立即关闭', exact: true }).click()
    await expect(dialog.getByRole('button', { name: '开启一小时窗口', exact: true })).toBeVisible()
    expect((await hub.request('/api/settings')).register_key).toBe('')
  } finally { panel.close() }
})

test('the palette jumps to a node, and its inspector has stable tabs and English copy', async ({ page, hub }) => {
  await hub.node('Tokyo edge', true)
  const panel = await securePanel(page, hub)
  try {
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog', { name: '搜索', exact: true })
    await palette.getByRole('combobox').fill('Tokyo')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/admin\/node\/\d+$/)
    await page.getByRole('button', { name: '管理节点', exact: true }).click()
    const inspector = page.getByRole('dialog', { name: 'Tokyo edge', exact: true })
    await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))))
    const opened = await inspector.boundingBox()
    for (const name of ['设置', '账单与流量', '安装', '概览']) {
      await inspector.getByRole('tab', { name, exact: true }).click()
      await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))))
      expect(await inspector.boundingBox()).toEqual(opened)
    }
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'English', exact: true }).click()
    await page.getByRole('button', { name: 'Manage node', exact: true }).click()
    for (const name of ['Settings', 'Billing and traffic', 'Install', 'Overview']) {
      await inspector.getByRole('tab', { name, exact: true }).click()
      const text = await inspector.innerText()
      expect(text).not.toMatch(/[㐀-鿿]/)
    }
  } finally { panel.close() }
})

test('a billing-only edit leaves unedited byte counters and allowance exact', async ({ page, hub }) => {
  const id = await hub.node('Exact accounting')
  await hub.request('/api/nodes/' + id, { method: 'PUT', body: { traffic_limit: 1234567 } })
  await hub.request('/api/nodes/' + id + '/traffic', { method: 'PUT', body: { total_rx: 9876543, total_tx: 7654321 } })
  const before = (await hub.request('/api/nodes')).nodes.find(node => node.id === id)
  const panel = await securePanel(page, hub)
  try {
    await page.getByRole('button', { name: '管理 Exact accounting', exact: true }).click()
    const inspector = page.getByRole('dialog', { name: 'Exact accounting' })
    await inspector.getByRole('tab', { name: '账单与流量', exact: true }).click()
    await inspector.getByLabel('价格', { exact: true }).fill('5.25')
    await inspector.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => (await hub.request('/api/nodes')).nodes.find(node => node.id === id).price).toBe(5.25)
    const after = (await hub.request('/api/nodes')).nodes.find(node => node.id === id)
    for (const key of ['traffic_limit', 'total_rx', 'total_tx']) expect(after[key], key).toBe(before[key])
  } finally { panel.close() }
})
