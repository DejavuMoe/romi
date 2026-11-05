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

async function expectNoChinese(locator) {
  expect(await locator.innerText()).not.toMatch(/[\u3400-\u9fff]/)
}

async function expectFullContentWidth(page, selector) {
  const geometry = await page.locator(selector).evaluate(layout => {
    const content = layout.closest('.admin-content')
    if (!content) throw new Error('section is outside the admin content column')
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

test('editing a monitor ignores nodes deleted after its list was loaded', async ({ page, hub }) => {
  const kept = await hub.node('Kept edge', false)
  const gone = await hub.node('Gone edge', false)
  await hub.request('/api/ping-tasks', {
    method: 'POST',
    body: { name: 'Stale monitor', target: '192.0.2.2:443', interval: 60, nodes: [kept, gone] },
  })
  await signIn(page)
  await navigateAdmin(page, '监测')
  await expect(page.getByRole('heading', { name: 'Stale monitor', exact: true })).toBeVisible()
  await expect(page.getByText('Gone edge', { exact: true })).toBeVisible()

  await hub.request(`/api/nodes/${gone}`, { method: 'DELETE' })
  // The node list updates over the WebSocket while the monitor list remains the
  // snapshot that was loaded before the deletion.
  await expect(page.getByText('Gone edge', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: '编辑 Stale monitor', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('1 / 1', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Kept edge', { exact: true })).toBeVisible()
  await expect(dialog.locator('.picker-list input:checked')).toHaveCount(1)
})

test('the migrated probes section has English interface copy', async ({ page, hub }) => {
  await hub.node('Edge node', false)
  await signIn(page)
  await navigateAdmin(page, '监测')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.getByText('No monitors yet', { exact: true })).toBeVisible()
  await expectNoChinese(page.locator('main'))

  // A dialog is rendered in a portal, so it needs its own copy check. Submit
  // empty fields to include the field-level error state.
  await page.getByRole('button', { name: 'Add monitor', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Add monitor', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog.getByRole('alert').filter({ hasText: 'Enter a name' })).toBeVisible()
  await expect(dialog.getByRole('alert').filter({ hasText: 'Enter a target' })).toBeVisible()
  await expectNoChinese(dialog)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()

  // The page-level failure state is English too.
  await page.route('**/api/ping-tasks', route => route.fulfill({ status: 500, contentType: 'text/plain', body: 'test list failure' }))
  await page.reload()
  const loadError = page.getByRole('alert').filter({ hasText: "Couldn't load Monitors" })
  await expect(loadError).toBeVisible()
  await expectNoChinese(loadError)
  await expectNoChinese(page.locator('main'))
})

test('the v15 security section requires the current password and confirms session deletion', async ({ page, hub }) => {
  await hub.request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'romi-e2e-only-password' } })
  await signIn(page)
  await navigateAdmin(page, '安全')
  await expect(page.getByRole('heading', { name: '账号与密码', exact: true })).toBeVisible()

  // The approved v15 sections use the whole content column, not the old
  // 960px settings page. Measure against its padding so the assertion follows
  // both desktop and mobile shells.
  await expectFullContentWidth(page, '.security-layout')

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
  expect(footer.actual.flexWrap).toBe('nowrap')
  expect(footer.actual.gap).toBe('normal')
  expect(footer.actual.paddingTop).toBe('0px')
  expect(footer.actual.paddingBottom).toBe('0px')
  expect(footer.actual.borderTopWidth).toBe('0px')
  // `margin-top: auto` computes to its used length in Chromium. Its effect is
  // what the prototype specifies: the footer sits on the card's inner bottom.
  const footerBottomGap = await page.locator('.security-layout .card-foot').evaluate(foot => {
    const card = foot.closest('.card')
    const padding = parseFloat(getComputedStyle(card).paddingBottom)
    return Math.round(card.getBoundingClientRect().bottom - padding - foot.getBoundingClientRect().bottom)
  })
  expect(Math.abs(footerBottomGap)).toBeLessThanOrEqual(1)

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

test('a successful credential change keeps the security form mounted', async ({ page }) => {
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
test('the migrated security section has English interface copy', async ({ page, hub }) => {
  // A second session supplies a non-current row whose confirmation is a portal.
  await hub.request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'romi-e2e-only-password' } })
  await signIn(page)
  await navigateAdmin(page, '安全')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Username and password', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sign-in sessions', exact: true })).toBeVisible()
  await expectNoChinese(page.locator('main'))

  const deleteSession = page.getByRole('button', { name: 'Delete session', exact: true }).first()
  await expect(deleteSession).toBeVisible()
  await deleteSession.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Delete session?', { exact: true })).toBeVisible()
  await expectNoChinese(dialog)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()

  // The page-level failure state is English too.
  await page.route('**/api/settings', route => route.fulfill({ status: 500, contentType: 'text/plain', body: 'test settings failure' }))
  await page.reload()
  const loadError = page.getByRole('alert').filter({ hasText: "Couldn't load Security settings" })
  await expect(loadError).toBeVisible()
  await expectNoChinese(loadError)
  await expectNoChinese(page.locator('main'))
})

test('the v15 settings section discards, saves and restores the site form', async ({ page, hub }) => {
  await signIn(page)
  await navigateAdmin(page, '设置')
  await expect(page.getByRole('heading', { name: '站点', exact: true })).toBeVisible()
  await expectFullContentWidth(page, '.settings-layout')

  const site = page.getByLabel('站点名称', { exact: true })
  await expect(site).toHaveValue('Monitor')
  const original = await site.inputValue()
  const bar = page.locator('.save-bar')
  await expect(bar).toHaveAttribute('aria-hidden', 'true')

  await site.fill('V15 settings site')
  await expect(bar).toHaveAttribute('aria-hidden', 'false')
  await bar.getByRole('button', { name: '放弃', exact: true }).click()
  await expect(site).toHaveValue(original)
  await expect(bar).toHaveAttribute('aria-hidden', 'true')

  await site.fill('V15 persisted site')
  await page.getByRole('radio', { name: '列表', exact: true }).click()
  await page.getByLabel('分钟历史保留天数', { exact: true }).fill('90')
  await page.getByLabel('连续在线重置阈值（分钟）', { exact: true }).fill('15')
  await bar.getByRole('button', { name: '保存站点设置', exact: true }).click()
  await expect(page.getByText('站点设置已保存', { exact: true })).toBeVisible()
  await expect(bar).toHaveAttribute('aria-hidden', 'true')

  const saved = await hub.request('/api/settings')
  expect(saved.site_name).toBe('V15 persisted site')
  expect(saved.public_default_view).toBe('list')
  expect(saved.retention_days).toBe('90')
  expect(saved.online_grace_minutes).toBe('15')

  await page.reload()
  await expect(page.getByLabel('站点名称', { exact: true })).toHaveValue('V15 persisted site')
  await expect(page.getByRole('radio', { name: '列表', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByLabel('分钟历史保留天数', { exact: true })).toHaveValue('90')
  await expect(page.getByLabel('连续在线重置阈值（分钟）', { exact: true })).toHaveValue('15')
})

test('the v15 settings section validates fields and moves the view choice by keyboard', async ({ page }) => {
  await signIn(page)
  await navigateAdmin(page, '设置')
  const site = page.getByLabel('站点名称', { exact: true })
  const retention = page.getByLabel('分钟历史保留天数', { exact: true })
  const save = page.getByRole('button', { name: '保存站点设置', exact: true })

  await retention.fill('60')
  await site.fill('')
  await expect(page.getByRole('alert').filter({ hasText: '请填写站点名称' })).toBeVisible()
  await expect(save).toBeDisabled()

  await site.fill('Validation site')
  await retention.fill('0')
  await expect(page.getByRole('alert').filter({ hasText: '不能小于 1' })).toBeVisible()
  await retention.fill('3651')
  await expect(page.getByRole('alert').filter({ hasText: '不能大于 3650' })).toBeVisible()
  const grace = page.getByLabel('连续在线重置阈值（分钟）', { exact: true })
  await grace.fill('61')
  await expect(page.getByRole('alert').filter({ hasText: '不能大于 60' })).toBeVisible()

  await retention.fill('30')
  await grace.fill('5')
  const cards = page.getByRole('radio', { name: '卡片', exact: true })
  await cards.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('radio', { name: '列表', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('radio', { name: '列表', exact: true })).toBeFocused()
  await expect(save).toBeEnabled()

  await page.getByLabel('HTTPS 数据库直链', { exact: true }).fill('http://example.com/country.mmdb')
  await expect(page.getByRole('alert').filter({ hasText: 'HTTPS' })).toBeVisible()
  await expect(page.getByRole('button', { name: '下载并更新', exact: true })).toBeDisabled()
})

test('the migrated settings section has English interface copy', async ({ page }) => {
  await signIn(page)
  await page.route('**/api/geolite', route => route.fulfill({ status: 503, contentType: 'text/plain', body: 'temporary geo failure' }))
  await navigateAdmin(page, '设置')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Site', exact: true })).toBeVisible()
  await expect(page.getByText('Not configured', { exact: true })).toBeVisible()
  const readError = page.getByRole('alert').filter({ hasText: 'temporary geo failure' })
  await expect(readError).toBeVisible()
  await expectNoChinese(readError)
  await expectNoChinese(page.locator('main'))

  // A fresh hub has no stored site_name; the form must show the same fallback
  // as the public page instead of blocking the untouched field.
  await expect(page.getByLabel('Site name', { exact: true })).toHaveValue('Monitor')
  await page.getByLabel('Minute history retention (days)', { exact: true }).fill('60')
  await expect(page.getByRole('alert').filter({ hasText: 'Enter a site name' })).toHaveCount(0)
  await page.getByLabel('Site name', { exact: true }).fill('')
  await expect(page.getByRole('alert').filter({ hasText: 'Enter a site name' })).toBeVisible()
  await expectNoChinese(page.locator('main'))
})

test('the v15 notification section saves credentials without echoing them', async ({ page, hub }) => {
  await signIn(page)
  await navigateAdmin(page, '通知')
  const telegram = page.getByRole('region', { name: 'Telegram', exact: true })
  const webhook = page.getByRole('region', { name: 'Webhook', exact: true })
  await expect(telegram.getByRole('heading', { name: 'Telegram', exact: true })).toBeVisible()
  await expect(telegram.getByText('未配置', { exact: true })).toBeVisible()

  const puts = []
  page.on('request', request => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/settings') puts.push(request.postDataJSON())
  })

  await telegram.getByLabel('Bot Token', { exact: true }).fill('123456:ABC-DEF')
  await telegram.getByLabel('Chat ID', { exact: true }).fill('-1001234567890')
  await telegram.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('Telegram 已保存', { exact: true })).toBeVisible()
  await expect(telegram.getByText('已配置', { exact: true })).toBeVisible()
  await expect(telegram.getByLabel('Bot Token', { exact: true })).toHaveValue('')
  let saved = await hub.request('/api/settings')
  expect(saved.notify_telegram_token_set).toBe(true)
  expect(saved.notify_telegram_chat).toBe('-1001234567890')
  expect(saved).not.toHaveProperty('notify_telegram_token')
  expect(puts[0]).toMatchObject({
    notify_telegram_chat: '-1001234567890',
    notify_telegram_token: '123456:ABC-DEF',
  })
  expect(puts[0]).not.toHaveProperty('notify_webhook_url')

  const telegramTest = telegram.getByRole('button', { name: '测试', exact: true })
  await expect(telegramTest).toBeEnabled()
  await page.route('**/api/notify/test?channel=telegram', route => route.fulfill({ status: 200, json: { sent: ['telegram'] } }))
  await telegramTest.click()
  await expect(page.getByText('测试通知已发送：telegram', { exact: true })).toBeVisible()
  await telegram.getByLabel('消息模板', { exact: true }).fill('changed telegram template')
  await expect(telegramTest).toBeDisabled()

  await webhook.getByLabel('URL', { exact: true }).fill('https://example.com/hook')
  const headers = webhook.getByLabel('请求头')
  await headers.fill('Authorization: Bearer secret')
  await webhook.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('Webhook 已保存', { exact: true })).toBeVisible()
  await expect(webhook.getByText('已配置', { exact: true })).toBeVisible()
  await expect(webhook.getByLabel('URL', { exact: true })).toHaveValue('')
  await expect(headers).toHaveValue('')
  await expect(headers.locator('..').getByText('已设置，留空不变', { exact: true })).toBeVisible()
  saved = await hub.request('/api/settings')
  expect(saved.notify_webhook_url_set).toBe(true)
  expect(saved.notify_webhook_headers_set).toBe(true)
  expect(saved).not.toHaveProperty('notify_webhook_url')
  expect(saved).not.toHaveProperty('notify_webhook_headers')
  // Saving the Webhook must not discard the Telegram template being edited.
  await expect(telegram.getByLabel('消息模板', { exact: true })).toHaveValue('changed telegram template')

  await telegram.getByRole('button', { name: '清除已保存的 Bot Token', exact: true }).click()
  await expect(page.getByText('已清除 Bot Token', { exact: true })).toBeVisible()
  saved = await hub.request('/api/settings')
  expect(saved.notify_telegram_token_set).toBe(false)
  expect(saved.notify_telegram_chat).toBe('-1001234567890')

  await webhook.getByRole('button', { name: '清除请求头', exact: true }).click()
  await expect(page.getByText('已保存', { exact: true })).toBeVisible()
  saved = await hub.request('/api/settings')
  expect(saved.notify_webhook_url_set).toBe(true)
  expect(saved.notify_webhook_headers_set).toBe(false)
  await expect(headers.locator('..').getByText('可选，一行一个', { exact: true })).toBeVisible()
  await expect(headers.locator('..').getByText('已设置，留空不变', { exact: true })).toHaveCount(0)

  await webhook.getByRole('button', { name: '清除', exact: true }).click()
  await expect.poll(async () => (await hub.request('/api/settings')).notify_webhook_url_set).toBe(false)
  saved = await hub.request('/api/settings')
  expect(saved.notify_webhook_headers_set).toBe(false)
})

test('the v15 notification templates insert placeholders and reject invalid JSON', async ({ page }) => {
  await signIn(page)
  await navigateAdmin(page, '通知')
  const telegram = page.getByRole('region', { name: 'Telegram', exact: true })
  const webhook = page.getByRole('region', { name: 'Webhook', exact: true })
  const template = telegram.getByLabel('消息模板', { exact: true })
  await template.fill('Hello ')
  await template.evaluate(element => element.setSelectionRange(6, 6))
  await telegram.getByRole('button', { name: '{{title}}', exact: true }).click()
  const expected = 'Hello {{title}}'
  await expect(template).toHaveValue(expected)
  await expect.poll(() => template.evaluate(element => element.selectionStart)).toBe(expected.length)
  await expect(telegram.locator('.tg-text')).toContainText('香港 · 甲商家')

  await webhook.getByLabel('请求体', { exact: true }).fill('{"content": {{title}}}')
  await expect(webhook.getByRole('alert').filter({ hasText: '代入后不是合法 JSON' })).toBeVisible()
})

test('the v15 notification rules validate and persist', async ({ page, hub }) => {
  await signIn(page)
  await navigateAdmin(page, '通知')
  const rules = page.getByRole('region', { name: '提醒规则', exact: true })
  const grace = rules.getByLabel('离线宽限期（分钟）', { exact: true })
  const traffic = rules.getByLabel('流量提醒（%）', { exact: true })
  const expiry = rules.getByLabel('到期提醒（天）', { exact: true })

  await grace.fill('0')
  await expect(rules.getByRole('alert').filter({ hasText: '不能小于 1' })).toBeVisible()
  await traffic.fill('101')
  await expect(rules.getByRole('alert').filter({ hasText: '不能大于 100' })).toBeVisible()
  await expiry.fill('366')
  await expect(rules.getByRole('alert').filter({ hasText: '不能大于 365' })).toBeVisible()

  await grace.fill('5')
  await traffic.fill('90')
  await expiry.fill('30')
  await rules.getByRole('switch', { name: '登录后台时提醒', exact: true }).click()
  await rules.getByRole('button', { name: '保存事件设置', exact: true }).click()
  await expect(page.getByText('已保存', { exact: true })).toBeVisible()
  const saved = await hub.request('/api/settings')
  expect(saved.notify_grace).toBe('5')
  expect(saved.notify_traffic).toBe('90')
  expect(saved.notify_expiry).toBe('30')
  expect(saved.notify_login).toBe('off')
})

test('the v15 notification section toggles offline alerts for every node', async ({ page, hub }) => {
  await hub.node('Notify A', false)
  await hub.node('Notify B', false)
  await signIn(page)
  await navigateAdmin(page, '通知')
  const card = page.getByRole('region', { name: '离线通知', exact: true })
  const count = card.locator('.card-head .num')
  await expect(count).toHaveText('0 / 2')

  await card.getByRole('button', { name: '全部打开', exact: true }).click()
  await expect.poll(() => count.innerText()).toBe('2 / 2')
  await expect(card.getByRole('switch')).toHaveCount(2)
  await expect(card.getByRole('switch').first()).toHaveAttribute('aria-checked', 'true')

  await card.getByRole('button', { name: '全部关闭', exact: true }).click()
  await expect.poll(() => count.innerText()).toBe('0 / 2')
  await card.getByRole('switch', { name: /Notify A/ }).click()
  await expect(page.getByText('已开启「Notify A」离线通知', { exact: true })).toBeVisible()
  await expect.poll(() => count.innerText()).toBe('1 / 2')
})

test('the migrated notification section has English interface copy', async ({ page }) => {
  await signIn(page)
  await navigateAdmin(page, '通知')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  const telegram = page.getByRole('region', { name: 'Telegram', exact: true })
  await expect(telegram.getByRole('heading', { name: 'Telegram', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Alert rules', exact: true })).toBeVisible()
  await expectNoChinese(page.locator('main'))

  await telegram.getByLabel('Bot Token', { exact: true }).fill('not-a-token')
  const fieldError = telegram.getByRole('alert').filter({ hasText: 'Bot Token should look like 123456:ABC-DEF' })
  await expect(fieldError).toBeVisible()
  await expectNoChinese(fieldError)

  await page.route('**/api/settings', route => route.fulfill({ status: 500, contentType: 'text/plain', body: 'test settings failure' }))
  await page.reload()
  const loadError = page.getByRole('alert').filter({ hasText: "Couldn't load Alert settings" })
  await expect(loadError).toBeVisible()
  await expectNoChinese(loadError)
  await expectNoChinese(page.locator('main'))
})

test('the v15 data section shows the database and saves the maintenance schedule', async ({ page, hub }) => {
  await signIn(page)
  await navigateAdmin(page, '数据')
  await expect(page.getByRole('heading', { name: '数据库', exact: true })).toBeVisible()
  await expect(page.locator('.db-size')).toBeVisible()
  const download = page.getByRole('link', { name: '下载备份', exact: true })
  await expect(download).toHaveAttribute('href', '/api/db/backup')
  await expect(download).toHaveAttribute('download', '')
  await expect(page.locator('input[type="file"]')).toHaveAttribute('accept', /\.gz/)

  const schedule = page.getByRole('combobox', { name: '自动维护周期', exact: true })
  await schedule.selectOption('7')
  await page.getByRole('button', { name: '保存周期', exact: true }).click()
  await expect(page.getByText('已保存', { exact: true })).toBeVisible()
  await expect.poll(async () => (await hub.request('/api/settings')).maintenance_days).toBe('7')
  await page.reload()
  await expect(page.getByRole('combobox', { name: '自动维护周期', exact: true })).toHaveValue('7')
})

test('the v15 data section gates restore on the backup checkbox and rejects non-backups', async ({ page }) => {
  await signIn(page)
  await navigateAdmin(page, '数据')
  const picker = page.locator('input[type="file"]')
  await picker.setInputFiles({ name: 'not-a-backup.zip', mimeType: 'application/zip', buffer: Buffer.from('no') })
  await expect(page.getByText('请选择 .tar.gz 备份文件', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await picker.setInputFiles({ name: 'romi-backup.tar.gz', mimeType: 'application/gzip', buffer: Buffer.alloc(32, 1) })
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '用备份覆盖当前数据？', exact: true })).toBeVisible()
  const confirm = dialog.getByRole('button', { name: '确认恢复', exact: true })
  await expect(confirm).toBeDisabled()
  await dialog.getByRole('checkbox', { name: '我已保留当前数据的备份', exact: true }).check()
  await expect(confirm).toBeEnabled()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toHaveCount(0)
})

test('cancelling a restore leaves the database unchanged', async ({ page, hub }) => {
  await hub.request('/api/settings', { method: 'PUT', body: { site_name: 'before restore' } })
  await signIn(page)
  await navigateAdmin(page, '数据')
  const chunks = []
  let release
  const held = new Promise(resolve => { release = resolve })
  await page.route('**/api/db/restore?**', async route => {
    chunks.push(new URL(route.request().url()).searchParams.get('offset'))
    await held
    await route.continue().catch(() => {})
  })

  await page.locator('input[type="file"]').setInputFiles({
    name: 'romi-backup.tar.gz', mimeType: 'application/gzip', buffer: Buffer.alloc(5 * 1024 * 1024, 1),
  })
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('checkbox', { name: '我已保留当前数据的备份', exact: true }).check()
  await dialog.getByRole('button', { name: '确认恢复', exact: true }).click()
  await expect.poll(() => chunks.length).toBe(1)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByText('已取消，数据库没有改动', { exact: true })).toBeVisible()
  release()
  await page.waitForTimeout(300)
  expect(chunks).toEqual(['0'])
  expect((await hub.request('/api/settings')).site_name).toBe('before restore')
})

test('the restore verification phase disables cancel', async ({ page }) => {
  await signIn(page)
  await navigateAdmin(page, '数据')
  await page.route('**/api/db/restore?**', async route => {
    const offset = new URL(route.request().url()).searchParams.get('offset')
    if (offset === '0') return route.fulfill({ status: 200, json: { received: 4 * 1024 * 1024 } })
    await new Promise(resolve => setTimeout(resolve, 1200))
    return route.fulfill({ status: 400, contentType: 'text/plain', body: 'final upload failure' })
  })

  await page.locator('input[type="file"]').setInputFiles({
    name: 'romi-backup.tar.gz', mimeType: 'application/gzip', buffer: Buffer.alloc(5 * 1024 * 1024, 1),
  })
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('checkbox', { name: '我已保留当前数据的备份', exact: true }).check()
  await dialog.getByRole('button', { name: '确认恢复', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '正在校验并切换', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
  await expect(page.getByText('final upload failure', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '确认恢复', exact: true })).toBeVisible()
})

test('the v15 data section reports both maintenance outcomes', async ({ page }) => {
  await signIn(page)
  await navigateAdmin(page, '数据')
  let calls = 0
  await page.route('**/api/db/maintenance', route => {
    calls += 1
    return route.fulfill({
      json: calls === 1
        ? { pruned: 1284, freed: 18.4 * 1024 * 1024, compacted: true, reusable: 0 }
        : { pruned: 1284, freed: 0, compacted: false, reusable: 18.4 * 1024 * 1024 },
    })
  })

  await page.getByRole('button', { name: '运行维护', exact: true }).click()
  const first = page.getByRole('dialog')
  await first.getByRole('button', { name: '运行维护', exact: true }).click()
  await expect(page.getByText('已清理 1,284 行，重写文件后实际回收 18.4 MiB', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '运行维护', exact: true }).click()
  const second = page.getByRole('dialog')
  await second.getByRole('button', { name: '运行维护', exact: true }).click()
  await expect(page.getByText('已清理 1,284 行，可复用 18.4 MiB 未达重写阈值，本次未重写文件', { exact: true })).toBeVisible()
})

test('the migrated data section has English interface copy', async ({ page }) => {
  await signIn(page)
  await navigateAdmin(page, '数据')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Database', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Backup and restore', exact: true })).toBeVisible()
  await expectNoChinese(page.locator('main'))

  await page.locator('input[type="file"]').setInputFiles({ name: 'romi-backup.tar.gz', mimeType: 'application/gzip', buffer: Buffer.alloc(32, 1) })
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Replace current data with the backup?', { exact: true })).toBeVisible()
  await expectNoChinese(dialog)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()

  await page.route('**/api/db', route => route.fulfill({ status: 500, contentType: 'text/plain', body: 'test database failure' }))
  await page.reload()
  const loadError = page.getByRole('alert').filter({ hasText: "Couldn't load Storage" })
  await expect(loadError).toBeVisible()
  await expectNoChinese(loadError)
  await expectNoChinese(page.locator('main'))
})
