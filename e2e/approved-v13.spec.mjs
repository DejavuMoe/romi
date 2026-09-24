// The two controls approved for v13, against a real Hub.
//
// Both are authorization surfaces as much as interface ones: publishing a node
// decides what an anonymous visitor may read, and replacing a credential decides
// who keeps the account. Each test therefore ends at the hub's answer, not at
// the panel's.
import { test, expect, signIn, navigateAdmin } from './fixtures.mjs'

const PASSWORD = 'romi-e2e-only-password'

async function openNodeForm(page, name) {
  await page.getByRole('button', { name: `编辑菜单 ${name}`, exact: true }).click()
  await page.getByRole('button', { name: '编辑节点', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '公开状态页' })).toBeVisible()
}

async function chooseVisibility(page, option) {
  await page.getByRole('combobox', { name: '公开状态页' }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

test('the node form publishes and unpublishes, and the status page follows', async ({ page, hub }) => {
  const id = await hub.node('可见性节点', true)
  await hub.request('/api/settings', { method: 'PUT', body: { public_page: 'on' } })

  // Published to begin with, so an anonymous visitor can read it.
  const visitor = await page.context().browser().newContext()
  const anonymous = await visitor.newPage()
  await anonymous.goto(hub.url + '/')
  await expect(anonymous.getByText('可见性节点', { exact: true })).toBeVisible()

  await signIn(page)
  await openNodeForm(page, '可见性节点')
  await expect(page.getByRole('combobox', { name: '公开状态页' })).toHaveText('显示')
  await chooseVisibility(page, '不显示')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()

  // The hub, not the panel, is what decides: the anonymous list must lose it and
  // the direct link must stop resolving.
  await expect(async () => {
    const listed = await anonymous.request.get(`${hub.url}/api/nodes`)
    const body = await listed.json()
    expect(body.nodes.some((node) => node.id === id)).toBe(false)
  }).toPass()
  const refused = await anonymous.request.get(`${hub.url}/api/nodes/${id}/metrics?hours=1`)
  expect(refused.status()).toBe(401)

  // The management list keeps it, marked.
  await expect(page.getByText('可见性节点', { exact: true })).toBeVisible()
  await expect(page.getByText('私有', { exact: true }).first()).toBeVisible()

  // And the choice survives a reload, so it was stored rather than held in the
  // form's own state.
  await page.reload()
  await openNodeForm(page, '可见性节点')
  await expect(page.getByRole('combobox', { name: '公开状态页' })).toHaveText('不显示')

  // Publishing again restores anonymous access.
  await chooseVisibility(page, '显示')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(async () => {
    const listed = await anonymous.request.get(`${hub.url}/api/nodes`)
    const body = await listed.json()
    expect(body.nodes.some((node) => node.id === id)).toBe(true)
  }).toPass()
  await visitor.close()
})

test('changing the password requires the current one', async ({ page, hub }) => {
  await signIn(page)
  await navigateAdmin(page, '安全')

  const current = page.getByLabel('当前密码', { exact: true })
  const next = page.getByLabel('新密码', { exact: true })
  const submit = page.getByRole('button', { name: '修改密码', exact: true })

  // Nothing to submit until both halves are present.
  await expect(submit).toBeDisabled()
  await next.fill('a-brand-new-password')
  await expect(submit).toBeDisabled()

  // A wrong current password is refused on its own field, and the old one still
  // works: the refusal has to be the hub's, not the panel's.
  await current.fill('not-the-password')
  await expect(submit).toBeEnabled()
  await submit.click()
  const refusal = page.getByRole('alert').filter({ hasText: '当前密码不正确' })
  await expect(refusal).toBeVisible()
  // Attached to the field it concerns, not merely present on the page.
  await expect(current).toHaveAttribute('aria-invalid', 'true')
  const describedBy = await current.getAttribute('aria-describedby')
  await expect(page.locator(`#${describedBy}`)).toHaveText('当前密码不正确')

  const stillOld = await page.request.post(`${hub.url}/api/auth/login`, {
    data: { username: 'admin', password: PASSWORD },
  })
  expect(stillOld.status()).toBe(200)

  // Editing the field clears the refusal rather than leaving it stale.
  await current.fill(PASSWORD)
  await expect(refusal).toHaveCount(0)
  await expect(current).not.toHaveAttribute('aria-invalid', 'true')

  // Accepted: the new password signs in and the old one no longer does.
  await submit.click()
  await expect(current).toHaveValue('')
  await expect(next).toHaveValue('')

  const fresh = await page.request.post(`${hub.url}/api/auth/login`, {
    data: { username: 'admin', password: 'a-brand-new-password' },
  })
  expect(fresh.status()).toBe(200)
  const stale = await page.request.post(`${hub.url}/api/auth/login`, {
    data: { username: 'admin', password: PASSWORD },
  })
  expect(stale.status()).toBe(401)
})

test('history tabs are one stop and move with the arrow keys', async ({ page, hub }) => {
  const id = await hub.node('键盘导航节点', true)
  await hub.request('/api/settings', { method: 'PUT', body: { public_page: 'on' } })
  await page.goto(`/node/${id}`)

  const tabs = page.getByRole('tab')
  await expect(tabs).toHaveCount(3)

  // One stop, not three: only the selected tab is in the tab order.
  expect(await tabs.evaluateAll((all) => all.map((t) => t.tabIndex))).toEqual([0, -1, -1])

  // The tab names the panel it controls, and the panel names the tab back.
  const selected = page.getByRole('tab', { selected: true })
  const panel = page.locator(`#${await selected.getAttribute('aria-controls')}`)
  await expect(panel).toHaveAttribute('role', 'tabpanel')
  expect(await panel.getAttribute('aria-labelledby')).toBe(await selected.getAttribute('id'))

  // Arrows move the selection, carry focus with it, and wrap.
  await selected.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { selected: true })).toHaveText('监测')
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('监测')
  await page.keyboard.press('End')
  await expect(page.getByRole('tab', { selected: true })).toHaveText('流量')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { selected: true })).toHaveText('资源')
  await page.keyboard.press('Home')
  await expect(page.getByRole('tab', { selected: true })).toHaveText('资源')

  // The panel follows the selection rather than keeping the first tab's id.
  await page.keyboard.press('ArrowLeft')
  const last = page.getByRole('tab', { selected: true })
  await expect(page.locator(`#${await last.getAttribute('aria-controls')}`)).toBeVisible()
})

test('a public card is announced by its own content', async ({ page, hub }) => {
  await hub.node('自述卡片节点', true)
  await hub.request('/api/settings', { method: 'PUT', body: { public_page: 'on' } })
  await page.goto('/')

  const card = page.locator('a.public-node-card').first()
  await expect(card).toBeVisible()
  // An aria-label here would replace everything inside, leaving the status,
  // billing and resource figures unreadable to assistive technology.
  expect(await card.getAttribute('aria-label')).toBeNull()

  const announced = await card.evaluate((element) => element.innerText.replace(/\s+/g, ' ').trim())
  for (const expected of ['自述卡片节点', 'CPU', 'RAM']) {
    expect(announced, 'the card still announces its own content').toContain(expected)
  }
  // And it is still the link that opens the node.
  await card.click()
  await expect(page).toHaveURL(/\/node\/\d+$/)
})
