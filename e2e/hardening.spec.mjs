// Behaviour that only a real Hub serving real assets to a real browser can
// show: the response headers both shells carry, that the policy in them does
// not break the pre-paint theme script, and that a refused request is not
// retried forever.
import { test, expect, signIn } from './fixtures.mjs'

test('both shells carry the framing and content policy headers', async ({ page }) => {
  for (const path of ['/', '/admin/']) {
    const response = await page.goto(path)
    expect(response.status(), path).toBe(200)
    const headers = response.headers()

    expect(headers['x-frame-options'], path).toBe('DENY')
    expect(headers['x-content-type-options'], path).toBe('nosniff')
    expect(headers['referrer-policy'], path).toBe('no-referrer')

    const csp = headers['content-security-policy']
    expect(csp, `${path} carries a policy`).toBeTruthy()
    // The clickjacking half. The panel mutates state with a SameSite=Lax
    // cookie, which does ride along with a framed top-level navigation.
    expect(csp, path).toContain("frame-ancestors 'none'")
    expect(csp, path).toContain("object-src 'none'")
    expect(csp, path).toContain("base-uri 'none'")
    // The shells load nothing off-origin, so a script source naming anything
    // but this origin and the theme bootstrap's own hash is a regression.
    expect(csp, path).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/)
    expect(csp, `${path} does not open scripts to inline`).not.toContain("script-src 'self' 'unsafe-inline'")
  }
})

test('the hashed bundle is cacheable and not policed as a document', async ({ page }) => {
  await page.goto('/')
  const source = await page.locator('script[type="module"]').first().getAttribute('src')
  expect(source).toMatch(/^\/assets\//)

  const response = await page.request.get(source)
  expect(response.status()).toBe(200)
  const headers = response.headers()
  expect(headers['cache-control']).toBe('public, max-age=31536000, immutable')
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['content-security-policy']).toBeUndefined()
})

test('the policy still admits the theme script that runs before the bundle', async ({ page }) => {
  // The pre-paint theme bootstrap is inline, so a policy of `script-src 'self'`
  // alone would silently block it and a dark session would flash white. The
  // violation is observable, so assert on it rather than on the rendering.
  await page.addInitScript(() => {
    addEventListener('securitypolicyviolation', (event) => {
      ;(window.__cspViolations ||= []).push(event.violatedDirective + ' ' + event.blockedURI)
    })
  })
  // The panel, not the status page: the public page is off by default, so `/`
  // would bounce an anonymous visitor to `/admin/` mid-assertion. Both shells
  // carry the same bootstrap.
  await page.goto('/admin/')
  await page.evaluate(() => localStorage.setItem('theme', 'dark'))

  await page.goto('/admin/', { waitUntil: 'load' })
  expect(await page.locator('html').getAttribute('class')).toContain('dark')
  const violations = await page.evaluate(() => window.__cspViolations || [])
  expect(violations, 'the shell must load with no policy violation').toEqual([])
})

test('the login screen stops asking once the hub has refused', async ({ page }) => {
  // The public page is off by default, so a signed-out panel gets 401 from both
  // /api/nodes and the stream. Retrying cannot make a refusal succeed, and an
  // unattended login form used to repeat it every five seconds for as long as
  // the tab stayed open.
  const asked = []
  await page.route('**/api/nodes*', (route) => {
    asked.push(Date.now())
    return route.continue()
  })

  await page.goto('/admin/')
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible()
  await page.waitForTimeout(6_000)
  expect(asked.length, 'a refused node list is requested once, not on a timer').toBe(1)
})

test('signing in resumes the node list the refusal stopped', async ({ page, hub }) => {
  // The other half of the contract above: stopping must not leave the panel
  // unable to load its list after a successful sign-in.
  await hub.node('恢复后的节点')
  await page.goto('/admin/')
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible()
  await page.waitForTimeout(1_000)

  await signIn(page)
  await expect(page.getByText('恢复后的节点', { exact: true })).toBeVisible()
})

test('the public range picker is styled by the stylesheet this app ships', async ({ page, hub }) => {
  // The detail page borrows the panel's Select primitive. With only this app's
  // own source scanned for classes, that component's utilities were compiled
  // into the panel's stylesheet and nowhere else, so the control rendered
  // unstyled here while every test that only checked text still passed.
  const id = await hub.node('样式检查节点', true)
  await hub.request('/api/settings', { method: 'PUT', body: { public_page: 'on' } })

  await page.goto(`/node/${id}`)
  const trigger = page.getByRole('combobox').first()
  await expect(trigger).toBeVisible()

  const style = await trigger.evaluate((element) => {
    const computed = getComputedStyle(element)
    return {
      display: computed.display,
      border: computed.borderStyle,
      height: element.getBoundingClientRect().height,
    }
  })
  // An unstyled trigger is a block with no border. Corners are not a signal
  // here: this design system sets every radius to zero on purpose.
  expect(style.display).toBe('flex')
  expect(style.border).toBe('solid')
  // The canary: `data-[size=default]:h-9` exists only in the borrowed
  // component's own file, so its 36px is what a missed scan takes away, leaving
  // a bare inline-height control. Not an equality: the shared touch-target rule
  // raises this to 44px on a coarse pointer, which is the layout working.
  expect(style.height).toBeGreaterThanOrEqual(36)
})
