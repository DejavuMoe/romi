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

test('the v15 security section requires the current password and confirms session deletion', async ({ page, hub }) => {
  await hub.request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'romi-e2e-only-password' } })
  await signIn(page)
  await navigateAdmin(page, '安全')
  await expect(page.getByRole('heading', { name: '账号与密码', exact: true })).toBeVisible()

  // The approved v15 sections use the whole content column, not the old
  // 960px settings page. Measure against its padding so the assertion follows
  // both desktop and mobile shells.
  const geometry = await page.locator('.security-layout').evaluate(layout => {
    const content = layout.closest('.admin-content')
    if (!content) throw new Error('security page is outside the admin content column')
    const box = layout.getBoundingClientRect()
    const frame = content.getBoundingClientRect()
    const style = getComputedStyle(content)
    return {
      leftGap: Math.round(box.left - frame.left - parseFloat(style.paddingLeft)),
      rightGap: Math.round(frame.right - parseFloat(style.paddingRight) - box.right),
    }
  })
  expect(Math.abs(geometry.leftGap)).toBeLessThanOrEqual(2)
  expect(Math.abs(geometry.rightGap)).toBeLessThanOrEqual(2)

  // The prototype footer only sets its display, alignment, height and bottom
  // edge. Compare the rest with `.muted.small` so the old public-card footer
  // rules cannot leak into the section card.
  const footer = await page.locator('.security-layout .card-foot').evaluate(foot => {
    const reference = document.createElement('span')
    reference.className = 'muted small'
    document.body.append(reference)
    const read = element => {
      const style = getComputedStyle(element)
      return {
        fontSize: style.fontSize,
        color: style.color,
        justifyContent: style.justifyContent,
        marginTop: style.marginTop,
        flexWrap: style.flexWrap,
        gap: style.gap,
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        borderTopWidth: style.borderTopWidth,
      }
    }
    const result = { actual: read(foot), target: read(reference) }
    reference.remove()
    return result
  })
  expect(footer.actual.fontSize).toBe(footer.target.fontSize)
  expect(footer.actual.color).toBe(footer.target.color)
  expect(footer.actual.justifyContent).toBe('normal')
  expect(footer.actual.marginTop).toBe('auto')
  expect(footer.actual.flexWrap).toBe('nowrap')
  expect(footer.actual.gap).toBe('normal')
  expect(footer.actual.paddingTop).toBe('0px')
  expect(footer.actual.paddingBottom).toBe('0px')
  expect(footer.actual.borderTopWidth).toBe('0px')

  const current = page.getByLabel('当前密码', { exact: true })
  const next = page.getByLabel('新密码', { exact: true })
  const submit = page.getByRole('button', { name: '保存', exact: true })
  let puts = 0
  page.on('request', request => {
    if (request.method() === 'PUT' && request.url().endsWith('/api/settings')) puts += 1
  })

  await next.fill('a-brand-new-password')
  await submit.click()
  await expect(page.getByRole('alert').filter({ hasText: '请填写当前密码' })).toBeVisible()
  await expect(current).toBeFocused()
  expect(puts, 'empty current password never reaches the hub').toBe(0)

  await current.fill('not-the-password')
  await submit.click()
  await expect(page.getByRole('alert').filter({ hasText: '当前密码不正确' })).toBeVisible()
  await expect(current).toBeFocused()
  expect(puts).toBe(1)

  const rows = page.locator('.session-list li')
  const before = await rows.count()
  expect(before).toBeGreaterThan(1)
  await page.getByRole('button', { name: '删除会话', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('删除会话？', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '删除会话', exact: true }).click()
  await expect(page.getByText('已删除会话', { exact: true })).toBeVisible()
  await expect(rows).toHaveCount(before - 1)
})

test('a successful credential change keeps the security form mounted', async ({ page, hub }) => {
  await signIn(page)
  await navigateAdmin(page, '安全')
  await expect(page.getByRole('heading', { name: '账号与密码', exact: true })).toBeVisible()
  await expect(page.locator('.session-list li').first()).toBeVisible()

  let sessionGets = 0
  page.on('request', request => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/sessions') sessionGets += 1
  })

  const form = page.locator('.security-layout .card').first().locator('form')
  await form.evaluate(element => { element.dataset.reviewMarker = 'kept' })
  const sessionReload = page.waitForResponse(response =>
    response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/sessions')

  await page.getByLabel('账号', { exact: true }).fill('review-admin')
  await page.getByLabel('当前密码', { exact: true }).fill('romi-e2e-only-password')
  await page.getByLabel('新密码', { exact: true }).fill('review-admin-password')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('账号与密码已修改', { exact: true })).toBeVisible()
  await sessionReload
  await expect(page.locator('.session-list li').first()).toBeVisible()

  // The form is the same DOM node, not a fresh mount keyed by the new name.
  expect(await form.getAttribute('data-review-marker')).toBe('kept')
  await expect(page.getByLabel('账号', { exact: true })).toHaveValue('review-admin')
  // The credential change refreshes the session list once, not twice.
  await page.waitForTimeout(250)
  expect(sessionGets).toBe(1)
})
test('the migrated security section has English interface copy', async ({ page }) => {
  await signIn(page)
  await navigateAdmin(page, '安全')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Username and password', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sign-in sessions', exact: true })).toBeVisible()
  const text = await page.locator('main').innerText()
  expect(text).not.toMatch(/[\u3400-\u9fff]/)
})
