import { test, expect, signIn, navigateAdmin } from './fixtures.mjs'

test('login, logout and anonymous access use real sessions', async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible()
  const response = await page.request.get('/api/settings')
  expect(response.status()).toBe(401)
})

test('revoking the current session returns an open panel to login', async ({ page }) => {
  await signIn(page)
  expect((await page.request.post('/api/auth/logout')).ok()).toBeTruthy()
  await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '后台导航' })).toHaveCount(0)
})

for (const [section, loaded] of [
  ['设置', '保存站点设置'], ['通知', '保存事件设置'], ['安全', '保存 GitHub 设置'],
]) {
  test(`${section} recovers from a failed settings request`, async ({ page }) => {
    await signIn(page)
    let requests = 0
    await page.route('**/api/settings', (route) => ++requests === 1
      ? route.fulfill({ status: 503, body: 'Temporary settings failure' })
      : route.continue())
    await navigateAdmin(page, section)
    await expect(page.getByRole('alert')).toContainText('Temporary settings failure')
    await expect(page.getByRole('button', { name: loaded, exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.getByRole('button', { name: loaded, exact: true })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: 'Temporary settings failure' })).toHaveCount(0)
    expect(requests).toBe(2)
  })
}

test('saving settings survives a page reload', async ({ page }) => {
  await signIn(page)
  await navigateAdmin(page, '设置')
  await page.getByLabel('站点名称', { exact: true }).fill('Saved E2E site')
  await page.getByRole('button', { name: '保存站点设置' }).click()
  await expect(page.getByText('已保存', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('站点名称', { exact: true })).toHaveValue('Saved E2E site')
  await expect(page).toHaveTitle('Saved E2E site · 管理')
})

test('a failed probe list is not presented as an empty list', async ({ page }) => {
  await signIn(page)
  let requests = 0
  await page.route('**/api/ping-tasks', (route) => ++requests === 1
    ? route.fulfill({ status: 503, body: 'Temporary probe failure' })
    : route.continue())
  await navigateAdmin(page, '监测')
  await expect(page.getByRole('alert')).toContainText('Temporary probe failure')
  await expect(page.getByText(/还没有监测任务/)).toHaveCount(0)
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByText(/还没有监测任务/)).toBeVisible()
  expect(requests).toBe(2)
})

for (const [section, endpoint, heading] of [['数据', 'db', '数据库']]) {
  test(`${section} shows loading failures and retries the real resource`, async ({ page }) => {
    await signIn(page)
    let requests = 0
    await page.route(`**/api/${endpoint}`, route => ++requests === 1
      ? route.fulfill({ status: 503, body: 'Temporary resource failure' }) : route.continue())
    await navigateAdmin(page, section)
    await expect(page.getByRole('alert')).toContainText('Temporary resource failure')
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: 'Temporary resource failure' })).toHaveCount(0)
    if (section === '数据') await expect(page.locator('input[type="file"]')).toHaveAttribute('accept', /\.gz/)
    expect(requests).toBe(2)
  })
}


test('v7 node settings, card navigation and maintenance persist through real APIs', async ({page,hub})=>{
  const id=await hub.node('V7 settings',true)
  await signIn(page)
  await page.setViewportSize({width:320,height:831})
  await expect(page.getByRole('button',{name:'卡片',exact:true})).toHaveCount(0)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  await page.getByRole('button',{name:'编辑菜单 V7 settings',exact:true}).click()
  await page.getByRole('button',{name:'编辑节点',exact:true}).click()
  await expect(page.getByText('公开显示',{exact:true})).toHaveCount(0)
  await page.getByLabel('展示优先级',{exact:true}).fill('-1')
  await page.getByRole('button',{name:'保存',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('0–999999')
  await page.getByLabel('展示优先级',{exact:true}).fill('123')
  await page.getByLabel('下载带宽',{exact:true}).fill('500')
  await page.getByRole('button',{name:'保存',exact:true}).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const saved=(await hub.request('/api/nodes')).nodes.find(n=>n.id===id)
  expect(saved.priority).toBe(123);expect(saved.bandwidth_up).toBe(500);expect(saved.bandwidth_down).toBe(500)
  await page.getByRole('link',{name:'V7 settings',exact:true}).click()
  await expect(page.getByRole('heading',{name:'V7 settings',exact:true})).toBeVisible()
  await expect(page.locator('.resource-panel')).toHaveCount(6)
  await expect(page.locator('.detail-kpis').getByText('待上报',{exact:true})).toHaveCount(3)
  const controls=()=>page.locator('.history-controls').evaluate(el=>({y:el.getBoundingClientRect().top+scrollY,height:el.getBoundingClientRect().height,select:el.querySelector('[role="combobox"]').getBoundingClientRect().x}))
  const before=await controls()
  for (const name of ['监测','流量','资源']) {await page.getByRole('tab',{name,exact:true}).click();expect(await controls()).toEqual(before)}
  await page.getByRole('button',{name:'返回',exact:true}).click()
  await expect(page.getByRole('table',{name:'节点列表',exact:true})).toBeVisible()
  await navigateAdmin(page,'数据')
  await expect(page.getByRole('combobox',{name:'自动维护周期',exact:true})).toContainText('关闭')
  await page.getByRole('combobox',{name:'自动维护周期',exact:true}).click()
  await page.getByRole('option',{name:'每 7 天',exact:true}).click()
  await page.getByRole('button',{name:'保存周期',exact:true}).click()
  await expect.poll(async()=>(await hub.request('/api/settings')).maintenance_days).toBe('7')
  await page.reload()
  await expect(page.getByRole('combobox',{name:'自动维护周期',exact:true})).toContainText('每 7 天')
})

test('local login requires both the configured account and password',async({page,hub})=>{
  await hub.request('/api/settings',{method:'PUT',body:{admin_username:'operator'}})
  await page.goto('/admin/')
  await page.getByLabel('账号',{exact:true}).fill('admin')
  await page.getByLabel('密码',{exact:true}).fill('romi-e2e-only-password')
  await page.getByRole('button',{name:'登录',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('invalid account or password')
  await page.getByLabel('账号',{exact:true}).fill('operator')
  await page.getByRole('button',{name:'登录',exact:true}).click()
  await expect(page.getByRole('heading',{name:'节点管理',exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'主题',exact:true})).toHaveCount(0)
})


test('GeoLite state recovers after a transient read failure',async({page})=>{
  await signIn(page)
  let requests=0
  await page.route('**/api/geolite',route=>++requests===1?route.fulfill({status:503,body:'Temporary GeoLite state failure'}):route.continue())
  await navigateAdmin(page,'设置')
  await expect(page.getByRole('alert')).toContainText('Temporary GeoLite state failure')
  await expect(page.getByText('未配置',{exact:true})).toBeVisible()
  await expect(page.getByRole('alert').filter({hasText:'Temporary GeoLite state failure'})).toHaveCount(0)
  expect(requests).toBeGreaterThanOrEqual(2)
})


test('keyboard focus remains visible when the pointer hovers the focused button',async({page})=>{
  await page.goto('/admin/')
  await page.getByLabel('密码',{exact:true}).fill('unused-test-input')
  await page.keyboard.press('Tab')
  const button=page.getByRole('button',{name:'登录',exact:true})
  await expect(button).toBeFocused()
  await button.hover()
  await expect.poll(()=>button.evaluate(el=>({visible:el.matches(':focus-visible'),outline:getComputedStyle(el).outlineStyle,width:getComputedStyle(el).outlineWidth}))).toEqual({visible:true,outline:'solid',width:'1px'})
})


test('billing rejects invalid amounts and calendar dates without silent correction',async({page,hub})=>{
  const id=await hub.node('Billing validation',true)
  await signIn(page)
  await page.getByRole('button',{name:'编辑菜单 Billing validation',exact:true}).click()
  await page.getByRole('button',{name:'账单与流量',exact:true}).click()
  await page.getByLabel('价格',{exact:true}).fill('-1')
  await page.getByRole('button',{name:'保存',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('非负数')
  await page.getByLabel('价格',{exact:true}).fill('5.25')
  await page.getByLabel('到期时间',{exact:true}).fill('2027-02-30')
  await page.getByRole('button',{name:'保存',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('有效的 YYYY-MM-DD')
  await page.getByLabel('到期时间',{exact:true}).fill('2028-02-29')
  await page.getByRole('button',{name:'保存',exact:true}).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const saved=(await hub.request('/api/nodes')).nodes.find(n=>n.id===id)
  expect(saved.price).toBe(5.25);expect(saved.expires_at).toBe('2028-02-29')
})


test('GeoLite polling does not erase a rejected update error',async({page})=>{
  await signIn(page)
  let reads=0
  await page.route('**/api/geolite',route=>{if(route.request().method()==='GET')reads++;return route.continue()})
  await navigateAdmin(page,'设置')
  await page.getByLabel('HTTPS 数据库直链',{exact:true}).fill('http://example.invalid/country.mmdb')
  await page.getByRole('button',{name:'下载并更新',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('HTTPS')
  const before=reads
  await expect.poll(()=>reads).toBeGreaterThan(before)
  await expect(page.getByRole('alert')).toContainText('HTTPS')
})
