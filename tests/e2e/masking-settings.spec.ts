import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('settings expose all labels, persist choices, and restore defaults across popup and options', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'blaind-settings-'));
  const extensionPath = resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    let page = await context.newPage();
    await page.goto(`chrome-extension://${id}/popup.html`);
    await expect(page.getByRole('heading')).toHaveCount(0);
    await expect(page.getByText('설정은 이 브라우저에 저장됩니다.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '설정 저장' })).toBeDisabled();
    await expect(page.getByRole('radiogroup')).toHaveCount(18);
    await expect(page.getByRole('radio', { name: '필수', exact: true })).toHaveCount(18);
    await expect(page.getByRole('radio', { name: '선택', exact: true })).toHaveCount(18);
    await page.locator('input[name="PERSON"][value="AUTO_MASK"]').check();
    await page.locator('input[name="PHONE"][value="CONFIRM"]').check();
    await Promise.all([page.waitForEvent('close'), page.getByRole('button', { name: '설정 저장' }).click()]);
    page = await context.newPage();
    await page.goto(`chrome-extension://${id}/popup.html`);
    await expect(page.locator('input[name="PERSON"][value="AUTO_MASK"]')).toBeChecked();
    await expect(page.locator('input[name="PHONE"][value="CONFIRM"]')).toBeChecked();
    await page.getByRole('button', { name: '기본값으로 되돌리기' }).click();
    await Promise.all([page.waitForEvent('close'), page.getByRole('button', { name: '설정 저장' }).click()]);
    page = await context.newPage();
    await page.goto(`chrome-extension://${id}/options.html`);
    await expect(page.locator('input[name="PERSON"][value="CONFIRM"]')).toBeChecked();
    await expect(page.locator('input[name="PHONE"][value="AUTO_MASK"]')).toBeChecked();
    await page.setViewportSize({ width: 460, height: 600 });
    await page.goto(`chrome-extension://${id}/popup.html`);
    await expect(page.locator('fieldset')).toBeEnabled();
    await page.screenshot({ path: '.output/settings-preview.png', fullPage: true });
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
