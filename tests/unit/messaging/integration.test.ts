import { describe, expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({ browser: {} }));
vi.mock('wxt/utils/define-background', () => ({ defineBackground: (main: unknown) => main }));
import { installPiiBackground } from '../../../src/entrypoints/background';
import { createWorkerRpc } from '../../../src/entrypoints/offscreen/rpc';
import { createPiiDetectorClient } from '../../../src/shared/messaging/pii-client';
import { createPiiRequestHandler, installPiiServer } from '../../../src/shared/messaging/pii-server';
import { PII_CHANNEL, type MessageSender, type PiiRequest } from '../../../src/shared/messaging/types';
import { MockWorker, deferred, mockRuntime, requiredAt } from './helpers';

describe('browser → background → offscreen → worker', () => {
  it('scans through all hops and transparently reinitializes after a worker crash', async () => {
    const { runtime, listeners, sendMessage } = mockRuntime();
    const dispatch = (message: unknown, sender: MessageSender) => new Promise<unknown>(resolve => {
      let claimed = false;
      for (const listener of listeners) if (listener(message, sender, resolve) === true) claimed = true;
      if (!claimed) resolve(undefined);
    });
    sendMessage.mockImplementation(message => {
      const target = (message as { target: string }).target;
      return dispatch(message, target === 'background'
        ? { id: runtime.id, url: 'https://chatgpt.com/', tab: { id: 1 } } : { id: runtime.id });
    });
    const removeBackground = installPiiBackground(runtime,
      { hasDocument: vi.fn().mockResolvedValue(true), createDocument: vi.fn() },
      { query: vi.fn().mockResolvedValue([]), sendMessage: vi.fn() });
    const workers: MockWorker[] = [];
    const initializations: ReturnType<typeof vi.fn>[] = [];
    let blockScan = false;
    const blocked = deferred<never>();
    const createWorker = () => {
      const worker = new MockWorker();
      workers.push(worker);
      const initialize = vi.fn(async () => {
        worker.emit('message', { data: { channel: PII_CHANNEL, type: 'pii:status', target: 'background', status: { state: 'ready', backend: 'wasm' } } });
      });
      initializations.push(initialize);
      const handle = createPiiRequestHandler({ initialize, scanText: vi.fn(async () => {
        if (blockScan) return blocked.promise;
        return [{ type: 'PERSON' as const, confidence: 0.95, span: { start: 0, end: 3 } }];
      }), scanSegments: vi.fn().mockResolvedValue([]) });
      worker.postMessage.mockImplementation((message: PiiRequest) => {
        void handle(message).then(response => worker.emit('message', { data: response }));
      });
      return worker;
    };
    const rpc = createWorkerRpc({ createWorker, onStatus: status => {
      void dispatch({ channel: PII_CHANNEL, type: 'pii:status', target: 'background', status },
        { id: runtime.id, url: runtime.getURL('offscreen.html') });
    } });
    const removeOffscreen = installPiiServer(runtime, 'offscreen', rpc.request);
    const client = createPiiDetectorClient({ runtime });
    const status = vi.fn();
    client.onStatus(status);
    await expect(client.scanText('김민수')).resolves.toEqual([{ type: 'PERSON', confidence: 0.95, span: { start: 0, end: 3 } }]);
    expect(initializations[0]).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);
    blockScan = true;
    const inFlight = client.scanText('김민수');
    const failure = expect(inFlight).rejects.toMatchObject({ code: 'INFERENCE_FAILED' });
    await vi.waitFor(() => expect(requiredAt(workers, 0).postMessage).toHaveBeenCalledTimes(4));
    requiredAt(workers, 0).emit('error', { preventDefault: vi.fn() });
    await failure;
    blockScan = false;
    await expect(client.scanText('김민수')).resolves.toHaveLength(1);
    expect(workers).toHaveLength(2);
    expect(initializations[1]).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(3); // ready, crash, ready; each routed once.
    client.dispose();
    removeOffscreen();
    removeBackground();
    rpc.dispose();
    expect(listeners.size).toBe(0);
  });
});
