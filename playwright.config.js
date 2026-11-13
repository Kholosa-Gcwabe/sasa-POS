// Playwright config for Sasa POS.
// The app is static files, so a tiny local server is enough.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx http-server . -p 5173 -c-1 --silent',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // Enable on Monday for responsive testing:
    // { name: 'phone', use: { ...devices['Pixel 7'] } },
    // { name: 'tablet', use: { ...devices['iPad (gen 7)'] } },
  ],
});
