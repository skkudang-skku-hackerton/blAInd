import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { assertEntity, assertSpans } from './assertions';
import type {} from './harness';
import { MODEL_CONFIG } from '../../src/core/detector/ko-pii/model-config';

test.describe('real browser model (WASM)', () => {
  test.skip(process.env.PII_MODEL_E2E !== '1', 'Opt in with PII_MODEL_E2E=1; downloads approximately 460 MB.');

  test('real spans, segments, chunk overlap, and cache-backed offline session', async ({}, testInfo) => {
    // A persistent profile matches extension storage; Chromium's incognito blob
    // backend cannot reliably persist this large artifact even with a quota override.
    const profile = await mkdtemp('/tmp/opencode/pii-model-');
    const context = await chromium.launchPersistentContext(profile, {
      headless: true, baseURL: 'http://127.0.0.1:4173',
    });
    try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/tests/e2e/harness.html');
    // Match the extension's unlimitedStorage permission for the ~483 MB model.
    const storage = await context.newCDPSession(page);
    await storage.send('Storage.overrideQuotaForOrigin', {
      origin: new URL(page.url()).origin, quotaSize: 2 * 1024 ** 3,
    });
    const cacheFailures: string[] = [];
    page.on('console', message => {
      if (message.type() === 'warning') cacheFailures.push(message.text());
    });
    await page.evaluate(() => {
      const put = Cache.prototype.put;
      Cache.prototype.put = async function (...args) {
        try { return await put.apply(this, args); }
        catch (error) { console.warn('Cache write failed:', String(error)); throw error; }
      };
    });
    await page.waitForFunction(() => !!window.piiHarness);
    await page.evaluate(() => window.piiHarness.detector.initialize());
    expect(await page.evaluate(() => window.piiHarness.backend())).toBe('wasm');
    await page.evaluate(() => window.piiHarness.detector.initialize());

    const text = '😀 제 이름은 김민수고 전화번호는 010-1234-5678입니다. 이메일은 minsu@example.com입니다.';
    const detections = await page.evaluate(text => window.piiHarness.detector.scanText(text), text);
    assertSpans(text, detections);
    assertEntity(text, detections, 'PERSON', '김민수');
    assertEntity(text, detections, 'PHONE', '010-1234-5678');
    assertEntity(text, detections, 'EMAIL', 'minsu@example.com');
    expect(await page.evaluate(() => window.piiHarness.detector.scanText(''))).toEqual([]);

    const segments = [{ id: 'empty', text: '' }, { id: 'emoji', text }];
    const results = await page.evaluate(segments => window.piiHarness.detector.scanSegments(segments), segments);
    expect(results.map(r => r.segmentId)).toEqual(['empty', 'emoji']);
    expect(results[0]!.detections).toEqual([]);
    assertSpans(text, results[1]!.detections);
    assertEntity(text, results[1]!.detections, 'PHONE', '010-1234-5678');

    const fixture = await page.evaluate(() => window.piiHarness.boundaryFixture());
    expect(fixture.tokenCount).toBeGreaterThan(MODEL_CONFIG.maxSequenceLength);
    expect(fixture.chunkCount).toBeGreaterThan(1);
    expect(fixture.boundary).toBeGreaterThan(fixture.text.indexOf('010-1234-5678'));
    expect(fixture.boundary).toBeLessThan(fixture.text.indexOf('010-1234-5678') + '010-1234-5678'.length);
    const longDetections = await page.evaluate(text => window.piiHarness.detector.scanText(text), fixture.text);
    assertSpans(fixture.text, longDetections);
    assertEntity(fixture.text, longDetections, 'PHONE', '010-1234-5678');
    assertEntity(fixture.text, longDetections, 'EMAIL', 'minsu@example.com');

    const cancellation = await page.evaluate(({ longText, shortText }) =>
      window.piiHarness.cancellationChecks(longText, shortText), { longText: fixture.text, shortText: text });
    await testInfo.attach('real-model-cancellation', {
      body: JSON.stringify(cancellation, null, 2), contentType: 'application/json',
    });
    for (const result of [cancellation.preText, cancellation.preSegments,
      cancellation.queuedResult, cancellation.activeResult]) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.code).toBe('CANCELLED');
    }
    expect(cancellation.preCalls).toBe(0);
    expect(cancellation.callsBeforeRelease).toBe(1);
    // One cancelled real chunk, one survivor, one recovery; no later chunks or segments.
    expect(cancellation.totalCalls).toBe(3);
    for (const result of [cancellation.survivorResult, cancellation.recovery]) {
      expect(result.status).toBe('fulfilled');
      if (result.status === 'fulfilled') {
        assertSpans(text, result.value);
        assertEntity(text, result.value, 'PHONE', '010-1234-5678');
      }
    }

    const cacheEntries = await page.evaluate(async () => {
      const entries: string[] = [];
      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys()) entries.push(request.url);
      }
      return entries;
    });
    expect(cacheEntries.some(url => url.includes('.onnx')), cacheFailures.join('\n')).toBe(true);
    await testInfo.attach('real-model-results', {
      body: JSON.stringify({ detections, results, fixture, longDetections, cacheEntries }, null, 2),
      contentType: 'application/json',
    });

    // Dispose the live model and construct a new runtime before cutting ALL
    // networking. ORT's executable WASM remains loaded; model assets must cache-hit.
    await page.evaluate(() => window.piiHarness.reset());
    await context.setOffline(true);
    try {
      await page.evaluate(() => window.piiHarness.detector.initialize());
      const offline = await page.evaluate(text => window.piiHarness.detector.scanText(text), text);
      assertSpans(text, offline);
      assertEntity(text, offline, 'PHONE', '010-1234-5678');
    } finally {
      await context.setOffline(false);
    }
    expect(errors).toEqual([]);
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
});
