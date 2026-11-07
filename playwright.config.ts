import { defineConfig, devices } from '@playwright/test';

// Runs against `wrangler dev`, i.e. the real Cloudflare static-asset server with public/_headers
// (CSP) applied. Build first: `npm run build && npm run test:e2e`.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:8787',
    ...devices['Desktop Chrome'],
    viewport: { width: 1500, height: 900 },
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: {
    command: 'npx wrangler dev --port 8787 --local --show-interactive-dev-session=false',
    url: 'http://localhost:8787',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
