import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 600_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: '/tmp/opencode/pii-playwright-results',
  use: { baseURL: 'http://127.0.0.1:4173', headless: true },
  projects: [
    { name: 'chromium', testIgnore: '**/firefox-compat.spec.ts', use: { browserName: 'chromium' } },
    { name: 'firefox', testMatch: [
      '**/firefox-compat.spec.ts', '**/pdf-module.spec.ts', '**/docx-module.spec.ts', '**/hwpx-module.spec.ts', '**/document-review.spec.ts',
    ], use: { browserName: 'firefox' } },
  ],
  webServer: process.env.PII_MODEL_E2E === '1' ? {
    command: 'npx vite --config tests/e2e/vite.config.ts',
    url: 'http://127.0.0.1:4173/tests/e2e/harness.html',
    reuseExistingServer: false,
    timeout: 60_000,
  } : undefined,
});
