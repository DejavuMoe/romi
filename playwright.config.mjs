import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // Each test owns a Hub and database; keep CI resource use predictable.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    browserName: 'chromium',
    // The interface follows the browser language; the tests read its Chinese
    // source text, so they state the language rather than inherit the runner's.
    locale: 'zh-CN',
    screenshot: 'only-on-failure',
    // Traces contain session cookies. Publish screenshots and redacted Hub logs
    // instead of recording credentials in network traces or storage state.
    trace: 'off',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
})
