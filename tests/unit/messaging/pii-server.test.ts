import { describe, expect, it, vi } from 'vitest';
import { PiiError } from '../../../src/core/api/errors';
import { createPiiRequestHandler } from '../../../src/shared/messaging/pii-server';
import { PII_CHANNEL, validateResponse, type PiiRequest } from '../../../src/shared/messaging/types';
import { deferred, request } from './helpers';

describe('detector RPC dispatch', () => {
  it('shares initialization and scans automatically once ready', async () => {
    const initialization = deferred<void>();
    const detector = { initialize: vi.fn(() => initialization.promise), scanText: vi.fn().mockResolvedValue([]),
      scanSegments: vi.fn().mockResolvedValue([{ segmentId: 'page', detections: [] }]) };
    const handle = createPiiRequestHandler(detector);
    const text = handle(request('text', 'pii:scan-text'));
    const segment = handle({ channel: PII_CHANNEL, clientId: 'test-client', type: 'pii:scan-segments', target: 'worker', requestId: 'segments', segments: [{ id: 'page', text: '김민수' }] });
    await Promise.resolve();
    expect(detector.initialize).toHaveBeenCalledTimes(1);
    expect(detector.scanText).not.toHaveBeenCalled();
    initialization.resolve();
    await expect(text).resolves.toMatchObject({ type: 'pii:result', result: [] });
    await expect(segment).resolves.toMatchObject({ type: 'pii:result', result: [{ segmentId: 'page', detections: [] }] });
  });
  it('retries initialization errors, serializes typed public errors, and strips raw exceptions', async () => {
    const detector = { initialize: vi.fn().mockRejectedValueOnce(new PiiError('MODEL_DOWNLOAD_FAILED', 'Download failed.', { cause: new Error('secret') }))
      .mockResolvedValue(undefined), scanText: vi.fn().mockRejectedValue(new Error('private text')),
      scanSegments: vi.fn() };
    const handle = createPiiRequestHandler(detector);
    const failed = await handle(request('init'));
    expect(failed).toEqual({ channel: PII_CHANNEL, clientId: 'test-client', ownerKey: undefined, requestId: 'init', type: 'pii:error', error: { code: 'MODEL_DOWNLOAD_FAILED', message: 'Download failed.' } });
    await expect(handle(request('retry'))).resolves.toMatchObject({ type: 'pii:ready' });
    await expect(handle(request('text', 'pii:scan-text'))).resolves.toMatchObject({ type: 'pii:error', error: { code: 'INFERENCE_FAILED', message: 'PII request failed.' } });
  });
  it('validates segment identity, order, confidence, and UTF-16 bounds', () => {
    const req: PiiRequest = { channel: PII_CHANNEL, clientId: 'test-client', target: 'worker', type: 'pii:scan-segments', requestId: 'segments', segments: [{ id: 'page', text: '😀김민수' }] };
    const result = (segmentId = 'page', confidence = 1, end = 5) => ({ channel: PII_CHANNEL, clientId: req.clientId,
      requestId: req.requestId, type: 'pii:result', result: [{ segmentId, detections: [{ type: 'PERSON', confidence, span: { start: 2, end } }] }] });
    expect(() => validateResponse(result(), req)).not.toThrow();
    for (const invalid of [result('wrong'), result('page', NaN), result('page', 2), result('page', 1, 6)]) {
      expect(() => validateResponse(invalid, req)).toThrow(PiiError);
    }
  });
});
