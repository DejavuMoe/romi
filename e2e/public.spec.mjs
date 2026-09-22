import { test, expect } from './fixtures.mjs'

test.beforeEach(async ({ hub }) => {
  await hub.request('/api/settings', { method: 'PUT', body: { public_page: 'on', site_name: 'E2E' } })
})

test('anonymous visitors see public nodes only, including direct links', async ({ page, hub }) => {
  const publicId = await hub.node('Public E2E node', true)
  const privateId = await hub.node('Private E2E node')
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Public E2E node' })).toBeVisible()
  await expect(page.getByText('Private E2E node')).toHaveCount(0)
  const response = await page.request.get('/api/nodes')
  const body = await response.json()
  expect(body.admin).toBe(false)
  expect(body.nodes.map((node) => node.id)).toEqual([publicId])
  for (const node of body.nodes) {
    // Even a regression must not print an exposed credential in the report.
    expect(Object.hasOwn(node, 'token')).toBe(false)
    expect(Object.hasOwn(node, 'token_hash')).toBe(false)
  }
  await page.goto(`/node/${privateId}`)
  await expect(page.getByText(/节点不存在或未公开/)).toBeVisible()
  await expect(page.getByText('Private E2E node')).toHaveCount(0)
})

test('approved public cards keep resource bars and summary separators at responsive widths', async ({ page, hub }) => {
  for (const name of ['Tokyo', 'Singapore', 'Frankfurt']) await hub.node(name, true)
  for (const theme of ['light', 'dark']) {
    await page.goto('/')
    await page.evaluate(value => localStorage.setItem('theme', value), theme)
    await page.reload()
    await expect(page.getByRole('link', { name: '查看 Tokyo', exact: true })).toBeVisible()
    for (const width of [320, 390, 818, 1601]) {
      await page.setViewportSize({ width, height: 900 })
      const layout = await page.evaluate(() => {
        const summary = document.querySelector('.fleet-summary')
        const cards = [...document.querySelectorAll('.public-node-card')]
        const meters = [...document.querySelectorAll('.resource-meter')]
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          gap: getComputedStyle(summary).gap,
          cellBorders: [...summary.children].map(el=>getComputedStyle(el).borderWidth),
          border: getComputedStyle(summary).borderTopWidth,
          columns: new Set(cards.map(el => Math.round(el.getBoundingClientRect().x))).size,
          meters: meters.map(el => ({ tone: el.dataset.tone, width: el.querySelector('.usage-fill').getBoundingClientRect().width })),
        }
      })
      expect(layout.overflow).toBe(false)
      expect(layout.gap).toBe('1px')
      expect(layout.cellBorders).toEqual(['0px','0px','0px','0px'])
      expect(layout.border).toBe('1px')
      expect(layout.columns).toBe(width > 1050 ? 3 : width > 700 ? 2 : 1)
      expect(layout.meters).toHaveLength(9)
      expect(layout.meters.every(m => m.tone === 'unknown' && m.width === 0)).toBe(true)
    }
    await page.getByRole('link', { name: '查看 Tokyo', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: 'Tokyo', level: 2 })).toBeVisible()
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page.getByRole('heading', { name: '节点状态', exact: true })).toBeVisible()
  }
})

test('node deep links, reload and browser history preserve navigation', async ({ page, hub }) => {
  const id = await hub.node('Linked E2E node', true)
  await page.goto(`/node/${id}`)
  await expect(page.getByRole('heading', { name: 'Linked E2E node', level: 2 })).toBeVisible()
  await page.reload()
  await expect(page).toHaveTitle('Linked E2E node · E2E')
  await page.getByRole('button', { name: 'E2E', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Linked E2E node', level: 3 })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/node/${id}$`))
  await expect(page.getByRole('heading', { name: 'Linked E2E node', level: 2 })).toBeVisible()
  await page.goForward()
  await expect(page.getByRole('heading', { name: 'Linked E2E node', level: 3 })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

function history() {
  const now = Math.floor(Date.now() / 60_000) * 60
  return {
    metrics: Array.from({ length: 3 }, (_, i) => ({
      ts: now - (2 - i) * 60, cpu: 10 + i, mem_used: 1024, disk_used: 2048, net_rx: 100, net_tx: 200,
    })),
    ping: [], probes: {}, loss: {},
  }
}

test('history retries initial errors and retains the plot after a refresh error', async ({ page, hub }) => {
  const id = await hub.node('History E2E node', true)
  let requests = 0
  await page.route(`**/api/nodes/${id}/metrics?*`, (route) => ++requests % 2
    ? route.fulfill({ status: 503, body: 'Temporary history failure' })
    : route.fulfill({ json: history() }))
  await page.goto(`/node/${id}`)
  await expect(page.getByRole('alert')).toContainText('Temporary history failure')
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByRole('application').first()).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('当前显示上次成功读取的数据')
  await expect(page.getByRole('application').first()).toBeVisible()
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(requests).toBe(4)
})

test('history polling waits for responses and stops after leaving the detail page', async ({ page, hub }) => {
  const id = await hub.node('Polling E2E node', true)
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  let requests = 0
  let first
  await page.route(`**/api/nodes/${id}/metrics?*`, async (route) => {
    if (++requests === 1) first = route
    else await route.fulfill({ json: history() })
  })
  await page.goto(`/node/${id}`)
  await expect.poll(() => requests).toBe(1)
  await page.clock.fastForward(180_000)
  expect(requests).toBe(1)
  await expect(page.getByRole('button', { name: '刷新中…' })).toBeDisabled()
  await first.fulfill({ json: { metrics: [], ping: [], probes: {}, loss: {} } })
  await expect(page.getByText('这段时间没有历史数据').first()).toBeVisible()
  await page.clock.fastForward(60_000)
  await expect(page.getByRole('application').first()).toBeVisible()
  expect(requests).toBe(2)
  await page.getByRole('button', { name: 'E2E', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Polling E2E node', level: 3 })).toBeVisible()
  await page.clock.fastForward(120_000)
  expect(requests).toBe(2)
})
