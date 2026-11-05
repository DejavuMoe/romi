import { test, expect, signIn, navigateAdmin } from './fixtures.mjs'

// Mark selected nodes online in the browser-only snapshots. Authentication,
// node creation and every write still go to the disposable real Hub.
async function routeOnline(page, hub, onlineIds) {
  const mark = body => {
    const now = Math.floor(Date.now() / 1000)
    body.nodes = body.nodes.map(node => onlineIds.includes(node.id)
      ? { ...node, online: true, last_seen: now, online_since: now - 10 }
      : node)
    return body
  }
  await page.route('**/api/nodes', async route => {
    const response = await route.fetch()
    if (response.status() !== 200) return route.fulfill({ response })
    await route.fulfill({ response, json: mark(await response.json()) })
  })
  await page.routeWebSocket(/\/api\/ws$/, ws => {
    let active = true
    const push = async () => {
      if (!active) return
      try { ws.send(JSON.stringify(mark(await hub.request('/api/nodes')))) } catch { /* hub closes after the test */ }
    }
    void push()
    const timer = setInterval(push, 500)
    timer.unref()
    ws.onClose(() => { active = false; clearInterval(timer) })
  })
}

test('the v15 probes section selects, creates, edits and deletes a monitor', async ({ page, hub }) => {
  const online = await hub.node('Online edge', false)
  await hub.node('Offline edge', false)
  await routeOnline(page, hub, [online])
  await signIn(page)
  await navigateAdmin(page, '监测')
  await expect(page.getByText('0 个监测任务', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '添加监测', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('1 / 2', { exact: true })).toBeVisible()
  await expect(dialog.locator('.picker-list input:checked')).toHaveCount(1)

  await dialog.getByRole('button', { name: '全选', exact: true }).click()
  await expect(dialog.getByText('2 / 2', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '清空', exact: true }).click()
  await expect(dialog.getByText('0 / 2', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '仅在线', exact: true }).click()
  await expect(dialog.getByText('1 / 2', { exact: true })).toBeVisible()

  await dialog.getByLabel('名称', { exact: true }).fill('V15 monitor')
  await dialog.getByLabel('目标地址', { exact: true }).fill('192.0.2.1:443')
  await dialog.getByLabel('间隔（秒）', { exact: true }).fill('30')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { name: 'V15 monitor', exact: true })).toBeVisible()

  await page.getByRole('button', { name: '编辑 V15 monitor', exact: true }).click()
  const edit = page.getByRole('dialog')
  await edit.getByLabel('名称', { exact: true }).fill('V15 monitor edited')
  await edit.getByRole('button', { name: '保存', exact: true }).click()
  await expect(edit).toBeHidden()
  await expect(page.getByRole('heading', { name: 'V15 monitor edited', exact: true })).toBeVisible()

  await page.getByRole('button', { name: '删除 V15 monitor edited', exact: true }).click()
  await expect(page.getByRole('dialog').getByText('删除监测「V15 monitor edited」？', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '删除监测', exact: true }).click()
  await expect(page.getByText('还没有监测任务', { exact: true })).toBeVisible()
})

test('the migrated probes section has English interface copy', async ({ page, hub }) => {
  await hub.node('Edge node', false)
  await signIn(page)
  await navigateAdmin(page, '监测')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.getByText('No monitors yet', { exact: true })).toBeVisible()
  const text = await page.locator('main').innerText()
  expect(text).not.toMatch(/[\u3400-\u9fff]/)
})
