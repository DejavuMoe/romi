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
  // Read from the served HTML rather than a loaded page: with the status page
  // off, the public shell sends a signed-out visitor on to /admin/ as soon as it
  // runs, so the live DOM may already belong to the other shell.
  for (const [shell, prefix] of [['/', /^\/assets\//], ['/admin/', /^\/admin\/assets\//]]) {
    const html = await (await page.request.get(shell)).text()
    const source = html.match(/<script type="module"[^>]*\ssrc="([^"]+)"/)?.[1]
    expect(source, shell).toMatch(prefix)

    const response = await page.request.get(source)
    expect(response.status(), source).toBe(200)
    const headers = response.headers()
    expect(headers['cache-control'], source).toBe('public, max-age=31536000, immutable')
    expect(headers['x-content-type-options'], source).toBe('nosniff')
    expect(headers['content-security-policy'], source).toBeUndefined()
  }
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

test('one address holds a bounded number of public streams, returned on close', async ({ page, hub }) => {
  await hub.request('/api/settings', { method: 'PUT', body: { public_page: 'on' } })
  // A page that opens no stream of its own, so every seat below is the test's.
  await page.goto('/healthz')

  const outcome = await page.evaluate(async () => {
    const url = location.origin.replace(/^http/, 'ws') + '/api/ws'
    // Resolves to the socket once it opens, or to null when the upgrade is
    // refused -- the browser reports that only as an error followed by close.
    const open = () =>
      new Promise((resolve) => {
        const socket = new WebSocket(url)
        socket.onopen = () => resolve(socket)
        socket.onerror = () => resolve(null)
      })
    const closed = (socket) =>
      new Promise((resolve) => {
        socket.onclose = resolve
        socket.close()
      })

    const first = await Promise.all([open(), open(), open(), open()])
    const fifth = await open()
    await Promise.all(first.filter(Boolean).map(closed))
    // Immediately, well inside one push interval: only a server that reads the
    // close frame has returned these seats by now.
    const again = await Promise.all([open(), open(), open(), open()])
    const result = {
      first: first.filter(Boolean).length,
      fifth: fifth !== null,
      again: again.filter(Boolean).length,
    }
    for (const socket of [...again, fifth].filter(Boolean)) socket.close()
    return result
  })

  expect(outcome.first, 'the allowance opens').toBe(4)
  expect(outcome.fifth, 'a fifth stream from one address is refused').toBe(false)
  expect(outcome.again, 'closing returns the seats at once').toBe(4)
})
