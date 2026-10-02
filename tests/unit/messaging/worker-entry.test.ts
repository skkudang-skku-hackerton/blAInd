import { afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ detector: {
  initialize: vi.fn(), scanText: vi.fn(), scanSegments: vi.fn(), onStatus: vi.fn(),
} }));
vi.mock('../../../src/core/detector/ko-pii/detector', () => ({
  KoPiiDetector: vi.fn(function () { return fixture.detector; }),
}));
import { cancelMessage } from '../../../src/shared/messaging/types';
import { deferred, request, requiredAt } from './helpers';
afterEach(() => vi.unstubAllGlobals());

it('the worker entry handles cancellation immediately during initialization and passes a local scan signal', async () => {
  vi.resetModules();
  const initialization = deferred<void>();
  fixture.detector.initialize.mockReturnValue(initialization.promise);
  fixture.detector.scanText.mockResolvedValue([]);
  fixture.detector.onStatus.mockReturnValue(() => undefined);
  const scope = { addEventListener: vi.fn(), postMessage: vi.fn() };
  vi.stubGlobal('self', scope);
  await import('../../../src/entrypoints/offscreen/inference.worker');
  expect(fixture.detector.onStatus).toHaveBeenCalledTimes(1);
  const receive = requiredAt(scope.addEventListener.mock.calls, 0)[1];
  const scan = request('scan', 'pii:scan-text');
  receive({ data: scan });
  receive({ data: request('shared-init') });
  receive({ data: cancelMessage(scan) });
  await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledWith(expect.objectContaining({
    requestId: scan.requestId, clientId: scan.clientId, type: 'pii:error', error: { code: 'CANCELLED', message: 'PII scan cancelled.' },
  })));
  expect(fixture.detector.scanText).not.toHaveBeenCalled();
  initialization.resolve();
  await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'shared-init', type: 'pii:ready' })));
  receive({ data: request('next', 'pii:scan-text') });
  await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'next', type: 'pii:result', result: [] })));
  expect(requiredAt(fixture.detector.scanText.mock.calls, 0)[1].signal).toBeInstanceOf(AbortSignal);
  expect(fixture.detector.initialize).toHaveBeenCalledTimes(1);
});
