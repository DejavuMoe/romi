import { test, expect, signIn, navigateAdmin } from './fixtures.mjs'

test('node management keeps edits, cancellation and priority on real APIs', async ({ page, hub }) => {
  const first = await hub.node('第一台节点')
  await hub.node('第二台节点')
  await signIn(page)
  await page.getByRole('button', { name: '编辑菜单 第一台节点', exact: true }).click()
  await page.getByRole('button', { name: '编辑节点', exact: true }).click()
  await page.getByLabel('名称', { exact: true }).fill('更名后的节点')
  await page.getByLabel('展示优先级', { exact: true }).fill('80')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(async () => (await hub.request('/api/nodes')).nodes.find(n=>n.id===first).priority).toBe(80)
  await expect(page.getByRole('button', { name: '编辑菜单 更名后的节点', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '编辑菜单 更名后的节点', exact: true })).toBeFocused()
  await page.getByRole('button', { name: '编辑菜单 更名后的节点', exact: true }).click()
  await page.getByRole('button', { name: '删除节点', exact: true }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('button', { name: '编辑菜单 更名后的节点', exact: true })).toBeFocused()
  expect((await hub.request('/api/nodes')).nodes.some(n => n.id === first)).toBe(true)
  await page.getByRole('button', { name: '编辑菜单 更名后的节点', exact: true }).click()
  await page.getByRole('button', { name: '删除节点', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '删除节点', exact: true }).click()
  await expect.poll(async () => (await hub.request('/api/nodes')).nodes.some(n => n.id === first)).toBe(false)
  await expect(page.locator('main')).toBeFocused()
})

test('solid light/dark surfaces and operational copy hold across navigation', async ({ page, hub }) => {
  await hub.node('文案检查节点', true)
  await signIn(page)
  const paths = []
  page.on('request', request => paths.push(new URL(request.url()).pathname))
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => localStorage.setItem('theme', value), theme)
    await page.goto('/admin/')
    for (const section of ['节点', '监测', '通知', '数据', '安全', '设置']) {
      await navigateAdmin(page, section)
      await expect(page.locator('main h1')).toBeVisible()
      if (section === '节点') await expect(page.getByRole('button', { name: '编辑菜单 文案检查节点', exact: true })).toBeVisible()
      else if (section === '监测') await expect(page.getByText('还没有监测任务。添加目标地址并选择节点。', { exact: true })).toBeVisible()
      else if (section === '数据') await expect(page.getByRole('heading', { name: '数据库', exact: true })).toBeVisible()
      else await expect(page.getByRole('button', { name: ({ 通知: '保存事件设置', 安全: '保存 GitHub 设置', 设置: '保存站点设置' })[section], exact: true })).toBeVisible()
      const observed = await page.evaluate(() => {
        const text = document.body.innerText + [...document.querySelectorAll('[aria-label],[title],[placeholder]')]
          .map(el => ['aria-label', 'title', 'placeholder'].map(a => el.getAttribute(a) || '').join(' ')).join(' ')
        return {
          text, overflow: document.documentElement.scrollWidth > innerWidth,
          primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
          blurred: [...document.querySelectorAll('*')].some(el => {
            const style = getComputedStyle(el)
            return style.backdropFilter && style.backdropFilter !== 'none'
          }),
        }
      })
      expect(observed.overflow, `${theme}: ${section}`).toBe(false)
      expect(observed.blurred).toBe(false)
      expect(observed.primary).toBe(theme === 'dark' ? '#99b9dd' : '#205ea6')
      expect(observed.text).not.toMatch(/AI Slop|提示词|草绿色|米白|Hackerman|Flexoki|CONTROL PANEL|OVERVIEW \/ NODES/i)
    }
    await navigateAdmin(page, '节点')
    await page.getByRole('button', { name: '编辑菜单 文案检查节点', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    expect(await page.locator('[data-slot="dialog-overlay"]').evaluate(el => getComputedStyle(el).backgroundColor)).not.toMatch(/rgba/)
    await page.getByRole('dialog').press('Escape')
    await page.goto('/')
    await expect(page.getByRole('heading', { name: '节点状态', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  expect(paths.some(path => path.includes('/designs/') || path.includes('/vendor/'))).toBe(false)
})

test('saved dark theme is applied before the application bundle executes', async ({ page }) => {
  await page.goto('/admin/')
  await page.evaluate(() => localStorage.setItem('theme', 'dark'))
  await page.route('**/assets/*.js', route => route.abort())
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  expect(await page.locator('html').getAttribute('class')).toContain('dark')
  await expect(page).toHaveTitle('romi')
})
