import { describe, expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({ browser: {} }));
vi.mock('wxt/utils/define-background', () => ({ defineBackground: (main: unknown) => main }));
vi.mock('../../../src/core/detector/ko-pii/runtime', () => ({ KoPiiRuntime: class {} }));
import { KoPiiDetector } from '../../../src/core/detector/ko-pii/detector';
import { installPiiBackground } from '../../../src/entrypoints/background';
import { createWorkerRpc } from '../../../src/entrypoints/offscreen/rpc';
import { createPiiDetectorClient } from '../../../src/shared/messaging/pii-client';
import { createPiiRequestHandler, installPiiServer } from '../../../src/shared/messaging/pii-server';
import { cancelMessage, isCancelMessage, type MessageSender, type PiiRequest } from '../../../src/shared/messaging/types';
import { fakeRuntime, holdInference, logitsFor } from '../detector/fakes';
import { MockWorker, mockRuntime } from './helpers';

function pipeline(detector: KoPiiDetector) {
  const { runtime, listeners, sendMessage } = mockRuntime();
  const dispatch = (message: unknown, sender: MessageSender) => new Promise<unknown>(resolve => {
    let claimed = false;
    for (const listener of listeners) if (listener(message, sender, resolve) === true) claimed = true;
    if (!claimed) resolve(undefined);
  });
  sendMessage.mockImplementation(message => dispatch(message, { id: runtime.id, url: runtime.getURL('background.js') }));
  const removeBackground = installPiiBackground(runtime,
    { hasDocument: vi.fn().mockResolvedValue(true), createDocument: vi.fn() },
    { query: vi.fn().mockResolvedValue([]), sendMessage: vi.fn() });
  const worker = new MockWorker();
  const handle = createPiiRequestHandler(detector);
  worker.postMessage.mockImplementation(message => {
    if (isCancelMessage(message, 'worker')) { handle.cancel(message); return; }
    void handle(message).then(response => worker.emit('message', { data: response }));
  });
  const rpc = createWorkerRpc({ createWorker: () => worker });
  const removeOffscreen = installPiiServer(runtime, 'offscreen', rpc.request);
  const senderA = { id: runtime.id, tab: { id: 1 }, frameId: 0, documentId: 'document-a', url: 'https://chatgpt.com/' };
  const senderB = { ...senderA, documentId: 'document-b' };
  const runtimeFor = (sender: MessageSender) => ({ ...runtime, sendMessage: (message: unknown) => dispatch(message, sender) });
  const a = createPiiDetectorClient({ runtime: runtimeFor(senderA) });
  const b = createPiiDetectorClient({ runtime: runtimeFor(senderB) });
  return { a, b, worker, sendMessage,
    forgeCancel: (req: PiiRequest) => dispatch(cancelMessage({ ...req, target: 'background' }), senderB),
    dispose() { a.dispose(); b.dispose(); removeOffscreen(); removeBackground(); rpc.dispose(); handle.dispose(); } };
}

describe('cancellation through the complete transport and real detector', () => {
  it('rejects active work promptly, rejects cross-context cancellation, and isolates another client', async () => {
    const { runtime } = fakeRuntime();
    const held = holdInference(runtime);
    const transport = pipeline(new KoPiiDetector(runtime));
    const controller = new AbortController();
    const cancelled = transport.a.scanText('가'.repeat(1200), { signal: controller.signal });
    const failure = expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
    const input = await held.started;
    const other = transport.b.scanText('other');
    const forwarded = transport.worker.postMessage.mock.calls.find(([message]) => message.type === 'pii:scan-text')![0] as PiiRequest;
    await transport.forgeCancel(forwarded);
    expect(runtime.infer).toHaveBeenCalledTimes(1);
    const observed = vi.fn();
    void cancelled.then(observed, observed);
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    controller.abort();
    await failure; // The ONNX operation is still held, but the public promise already rejected.
    expect(transport.worker.terminate).not.toHaveBeenCalled();
    held.result.resolve(logitsFor(input.ids.map(() => 0)));
    await expect(other).resolves.toEqual([]);
    expect(runtime.infer).toHaveBeenCalledTimes(2); // cancelled first chunk + other client's scan
    expect(runtime.initialize).toHaveBeenCalledTimes(1);
    transport.dispose();
  });
  it('delivers cancellation between chunks and never returns the first chunk as a partial result', async () => {
    const { runtime } = fakeRuntime([{ start: 0, end: 3 }]);
    const controller = new AbortController();
    runtime.infer.mockImplementationOnce(async input => {
      setTimeout(() => controller.abort(), 0);
      return logitsFor(input.ids.map((_, i) => i === 1 ? 1 : 0));
    });
    const transport = pipeline(new KoPiiDetector(runtime));
    await expect(transport.a.scanText('가'.repeat(1200), { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(transport.b.scanText('other')).resolves.toBeInstanceOf(Array);
    expect(runtime.infer).toHaveBeenCalledTimes(2);
    expect(transport.worker.terminate).not.toHaveBeenCalled();
    transport.dispose();
  });
  it('skips later segments when a document scan is cancelled after its first segment', async () => {
    const { runtime } = fakeRuntime();
    const controller = new AbortController();
    runtime.infer.mockImplementationOnce(async input => {
      setTimeout(() => controller.abort(), 0);
      return logitsFor(input.ids.map(() => 0));
    });
    const transport = pipeline(new KoPiiDetector(runtime));
    await expect(transport.a.scanSegments([{ id: 'first', text: 'one' }, { id: 'second', text: 'two' }],
      { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(transport.b.scanText('other')).resolves.toEqual([]);
    expect(runtime.infer).toHaveBeenCalledTimes(2);
    transport.dispose();
  });
});
