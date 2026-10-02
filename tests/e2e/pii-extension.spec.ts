import { chromium, expect, test } from '@playwright/test';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { assertEntity, assertSpans } from './assertions';
import type {} from './harness';

const extension = resolve('.output/chrome-mv3');

/** Bundle the real public client into a throwaway extension page under tests/.
 *  No demo UI ships: the page exists only inside the test's copied build output.
 */
async function installTestPage() {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: extension,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: resolve('tests/e2e/extension-client.ts'),
        formats: ['iife'],
        name: 'PiiE2E',
        fileName: () => 'pii-e2e-client.js',
      },
    },
  });
  await copyFile(resolve('tests/e2e/extension-page.html'), join(extension, 'pii-e2e-page.html'));
}

test('built MV3 public client → offscreen → worker → real model', async ({}, testInfo) => {
  test.skip(process.env.PII_MODEL_E2E !== '1' || process.env.PII_EXTENSION_E2E !== '1',
    'Requires PII_MODEL_E2E=1 PII_EXTENSION_E2E=1 and a built extension.');
  expect(existsSync(join(extension, 'manifest.json')), 'Run the main-owned WXT build first').toBe(true);
  await installTestPage();
  const profile = await mkdtemp('/tmp/opencode/pii-extension-');
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).hostname;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/pii-e2e-page.html`);
    await expect.poll(() => page.evaluate(() => typeof window.piiDetector?.scanText))
      .toBe('function');
    await page.evaluate(() => window.piiDetector!.initialize());
    const text = '😀 제 이름은 김민수고 전화번호는 010-1234-5678입니다.';
    const detections = await page.evaluate(text => window.piiDetector!.scanText(text), text);
    assertSpans(text, detections);
    assertEntity(text, detections, 'PHONE', '010-1234-5678');
    const results = await page.evaluate(text => window.piiDetector!.scanSegments([{ id: 'rpc-page', text }]), text);
    expect(results[0]!.segmentId).toBe('rpc-page');
    assertEntity(text, results[0]!.detections, 'PHONE', '010-1234-5678');
    const cancellation = await page.evaluate(async text => {
      const client = window.piiDetector!;
      const handled = <T>(promise: Promise<T>) => promise.then(
        value => ({ status: 'fulfilled' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const,
          code: (error as { code?: string })?.code, message: String(error) }),
      );
      const pre = new AbortController();
      pre.abort();
      const preText = await handled(client.scanText(text, { signal: pre.signal }));
      const preSegments = await handled(client.scanSegments([{ id: 'pre-rpc', text }], { signal: pre.signal }));
      const controller = new AbortController();
      const longText = `${'문서 '.repeat(4096)}${text}`;
      const cancelled = handled(client.scanSegments([
        { id: 'cancelled-long', text: longText }, { id: 'cancelled-tail', text },
      ], { signal: controller.signal }));
      const survivor = handled(client.scanText(text));
      // Give real messaging time to dispatch. Active-versus-queued placement is
      // intentionally not asserted here; the Vite probe tests the exact boundary.
      await new Promise(resolve => setTimeout(resolve, 100));
      const abortedAt = performance.now();
      controller.abort();
      controller.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancelledResult: Awaited<typeof cancelled>;
      try {
        cancelledResult = await Promise.race([cancelled, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('RPC cancellation did not settle within 5 seconds')), 5_000);
        })]);
      } finally { clearTimeout(timer); }
      const cancellationMs = performance.now() - abortedAt;
      const survivorResult = await survivor;
      controller.abort();
      const recovery = await handled(client.scanSegments([{ id: 'rpc-recovery', text }]));
      return { preText, preSegments, cancelledResult, cancellationMs, survivorResult, recovery };
    }, text);
    await testInfo.attach('extension-rpc-cancellation', {
      body: JSON.stringify(cancellation, null, 2), contentType: 'application/json',
    });
    for (const result of [cancellation.preText, cancellation.preSegments, cancellation.cancelledResult]) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.code).toBe('CANCELLED');
    }
    expect(cancellation.cancellationMs).toBeLessThan(5_000);
    expect(cancellation.survivorResult.status).toBe('fulfilled');
    if (cancellation.survivorResult.status === 'fulfilled') {
      assertSpans(text, cancellation.survivorResult.value);
      assertEntity(text, cancellation.survivorResult.value, 'PHONE', '010-1234-5678');
    }
    expect(cancellation.recovery.status).toBe('fulfilled');
    if (cancellation.recovery.status === 'fulfilled') {
      expect(cancellation.recovery.value[0]!.segmentId).toBe('rpc-recovery');
      assertSpans(text, cancellation.recovery.value[0]!.detections);
      assertEntity(text, cancellation.recovery.value[0]!.detections, 'PHONE', '010-1234-5678');
    }
    const cacheEntries = await worker.evaluate(async () => {
      const entries: string[] = [];
      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys()) entries.push(request.url);
      }
      return entries;
    });
    expect(cacheEntries.some(url => url.endsWith('/model_int8.onnx'))).toBe(true);
    // Recreate the entire offscreen host/worker with no live model or loaded ORT
    // module left. Bundled executable assets and cached model data must suffice.
    await worker.evaluate(async () => {
      const extension = globalThis as unknown as { chrome: { offscreen: { closeDocument(): Promise<void> } } };
      await extension.chrome.offscreen.closeDocument();
    });
    await context.setOffline(true);
    try {
      await page.evaluate(() => window.piiDetector!.initialize());
      const offline = await page.evaluate(text => window.piiDetector!.scanText(text), text);
      assertEntity(text, offline, 'PHONE', '010-1234-5678');
      assertSpans(text, offline);
    } finally { await context.setOffline(false); }
    await testInfo.attach('extension-rpc-results', {
      body: JSON.stringify({ extensionId, detections, results, cacheEntries }, null, 2), contentType: 'application/json',
    });
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
