import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({ browser: {} }));
vi.mock('wxt/utils/define-background', () => ({ defineBackground: (main: unknown) => main }));
import { PiiError } from '../../../src/core/api/errors';
import { createPiiDetectorClient } from '../../../src/shared/messaging/pii-client';
import { createCancellableRequestHandler, createPiiRequestHandler, installPiiServer } from '../../../src/shared/messaging/pii-server';
import { installPiiBackground } from '../../../src/entrypoints/background';
import { createWorkerRpc } from '../../../src/entrypoints/offscreen/rpc';
import { cancelMessage, DEFAULT_REQUEST_TIMEOUT_MS, PII_CHANNEL, requestKey, scopedResponse,
  type MessageSender, type PiiRequest } from '../../../src/shared/messaging/types';
import { deferred, MockWorker, mockRuntime, ready, request, requiredAt } from './helpers';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('public client cancellation', () => {
  it('rejects pre-aborted text and segment scans without starting initialization', async () => {
    const { runtime, sendMessage } = mockRuntime();
    const client = createPiiDetectorClient({ runtime });
    const controller = new AbortController();
    controller.abort();
    for (const scan of [client.scanText('text', { signal: controller.signal }),
      client.scanSegments([{ id: 'page', text: 'text' }], { signal: controller.signal })]) {
      await expect(scan).rejects.toMatchObject({ code: 'CANCELLED' });
    }
    expect(sendMessage).not.toHaveBeenCalled();
    client.dispose();
  });
  it('cancels initialization-waiting scans promptly while shared initialization continues', async () => {
    const { runtime, sendMessage } = mockRuntime();
    const initialization = deferred<unknown>();
    sendMessage.mockImplementation(async message => {
      const req = message as PiiRequest;
      return req.type === 'pii:init' ? initialization.promise : scopedResponse(req,
        { channel: PII_CHANNEL, requestId: req.requestId, type: 'pii:result', result: [] });
    });
    const client = createPiiDetectorClient({ runtime });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const cancelled = client.scanText('cancel me', { signal: controller.signal });
    const failure = expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
    const other = client.scanText('keep me');
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    controller.abort();
    await failure;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(sendMessage.mock.calls.some(([message]) => (message as PiiRequest).type === 'pii:scan-text')).toBe(false);
    initialization.resolve(ready(requiredAt(sendMessage.mock.calls, 0)[0] as PiiRequest));
    await expect(other).resolves.toEqual([]);
    const messages = sendMessage.mock.calls.map(([message]) => message as PiiRequest);
    expect(messages.filter(message => message.type === 'pii:scan-text')).toHaveLength(1);
    expect(messages.some(message => 'signal' in message || 'options' in message)).toBe(false);
    client.dispose();
  });
  it('catches abort during listener setup and immediately before dispatch', async () => {
    const { runtime, sendMessage } = mockRuntime();
    const client = createPiiDetectorClient({ runtime });
    const setup = new AbortController();
    const add = setup.signal.addEventListener.bind(setup.signal);
    vi.spyOn(setup.signal, 'addEventListener').mockImplementation((...args) => { add(...args); setup.abort(); });
    await expect(client.scanText('text', { signal: setup.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(sendMessage).not.toHaveBeenCalled();
    const immediate = new AbortController();
    const pending = client.scanText('text', { signal: immediate.signal });
    const failed = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    immediate.abort();
    await failed;
    expect(sendMessage).not.toHaveBeenCalled();
    client.dispose();
  });
  it('keeps the same ID for active cancellation, ignores late replies and removes listeners', async () => {
    const { runtime, sendMessage } = mockRuntime();
    const late = deferred<unknown>();
    sendMessage.mockImplementation(async message => {
      const req = message as PiiRequest;
      return req.type === 'pii:init' ? ready(req) : req.type === 'pii:scan-text' ? late.promise : undefined;
    });
    const client = createPiiDetectorClient({ runtime });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const scan = client.scanText('text', { signal: controller.signal });
    const failure = expect(scan).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    const req = requiredAt(sendMessage.mock.calls, 1)[0] as PiiRequest;
    controller.abort();
    controller.abort();
    await failure;
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(3));
    expect(requiredAt(sendMessage.mock.calls, 2)[0]).toEqual(cancelMessage(req));
    expect(remove).toHaveBeenCalledTimes(1);
    late.resolve(scopedResponse(req, { channel: PII_CHANNEL, requestId: req.requestId, type: 'pii:result', result: [] }));
    await Promise.resolve();
    client.dispose();
  });
  it('allows intentionally shared signals and ignores abort after success or failure', async () => {
    const { runtime, sendMessage } = mockRuntime();
    sendMessage.mockImplementation(async message => {
      const req = message as PiiRequest;
      if (req.type === 'pii:init') return ready(req);
      return scopedResponse(req, { channel: PII_CHANNEL, requestId: req.requestId, type: 'pii:result', result: [] });
    });
    const client = createPiiDetectorClient({ runtime });
    const success = new AbortController();
    const remove = vi.spyOn(success.signal, 'removeEventListener');
    await expect(client.scanText('text', { signal: success.signal })).resolves.toEqual([]);
    const before = sendMessage.mock.calls.length;
    success.abort();
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledTimes(before);
    expect(remove).toHaveBeenCalledTimes(1);
    sendMessage.mockRejectedValue(new Error('transport failure'));
    const failure = new AbortController();
    const removeFailure = vi.spyOn(failure.signal, 'removeEventListener');
    await expect(client.scanText('text', { signal: failure.signal })).rejects.toBeInstanceOf(PiiError);
    const beforeFailureAbort = sendMessage.mock.calls.length;
    failure.abort();
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledTimes(beforeFailureAbort);
    expect(removeFailure).toHaveBeenCalledTimes(1);
    sendMessage.mockReturnValue(new Promise(() => undefined));
    const shared = new AbortController();
    const a = client.scanText('a', { signal: shared.signal });
    const b = client.scanText('b', { signal: shared.signal });
    const assertions = [expect(a).rejects.toMatchObject({ code: 'CANCELLED' }), expect(b).rejects.toMatchObject({ code: 'CANCELLED' })];
    shared.abort();
    await Promise.all(assertions);
    client.dispose();
  });
  it('aborting synchronously inside sendMessage cannot overtake scan dispatch', async () => {
    const { runtime, sendMessage } = mockRuntime();
    const controller = new AbortController();
    const order: string[] = [];
    sendMessage.mockImplementation(async message => {
      const req = message as PiiRequest;
      if (req.type === 'pii:init') return ready(req);
      if (req.type === 'pii:scan-text') {
        controller.abort();
        order.push('scan');
        return new Promise(() => undefined);
      }
      order.push('cancel');
      return undefined;
    });
    const client = createPiiDetectorClient({ runtime });
    await expect(client.scanText('text', { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(order).toEqual(['scan', 'cancel']));
    client.dispose();
  });
});

describe('request-owned worker dispatch', () => {
  it('rejects active and queued scans independently and removes queued inference jobs', async () => {
    const active = deferred<never[]>();
    const detector = { initialize: vi.fn().mockResolvedValue(undefined),
      scanText: vi.fn().mockReturnValueOnce(active.promise).mockResolvedValue([]), scanSegments: vi.fn() };
    const handle = createPiiRequestHandler(detector);
    const first = request('active', 'pii:scan-text');
    const queued = request('queued', 'pii:scan-text');
    const other = request('other', 'pii:scan-text');
    const a = handle(first);
    const b = handle(queued);
    const c = handle(other);
    await vi.waitFor(() => expect(detector.scanText).toHaveBeenCalledTimes(1));
    handle.cancel(cancelMessage(queued));
    await expect(b).resolves.toMatchObject({ type: 'pii:error', error: { code: 'CANCELLED' } });
    handle.cancel(cancelMessage(first));
    await expect(a).resolves.toMatchObject({ type: 'pii:error', error: { code: 'CANCELLED' } });
    const options = requiredAt(detector.scanText.mock.calls, 0)[1];
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(true);
    expect(detector.scanText).toHaveBeenCalledTimes(1);
    active.resolve([]);
    await expect(c).resolves.toMatchObject({ type: 'pii:result', result: [] });
    expect(detector.scanText).toHaveBeenCalledTimes(2);
    handle.dispose();
  });
  it('cancels while initialization is pending without cancelling the shared initialization', async () => {
    const initialization = deferred<void>();
    const detector = { initialize: vi.fn(() => initialization.promise), scanText: vi.fn().mockResolvedValue([]), scanSegments: vi.fn() };
    const handle = createPiiRequestHandler(detector);
    const cancelled = request('cancelled', 'pii:scan-text');
    const scan = handle(cancelled);
    const init = handle(request('init'));
    handle.cancel(cancelMessage(cancelled));
    await expect(scan).resolves.toMatchObject({ error: { code: 'CANCELLED' } });
    expect(detector.scanText).not.toHaveBeenCalled();
    initialization.resolve();
    await expect(init).resolves.toMatchObject({ type: 'pii:ready' });
    await expect(handle(request('next', 'pii:scan-text'))).resolves.toMatchObject({ type: 'pii:result' });
    expect(detector.initialize).toHaveBeenCalledTimes(1);
    handle.dispose();
  });
  it('scopes identical request IDs to client and authenticated owner, with bounded race state', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async req => ready(req));
    const handle = createCancellableRequestHandler(execute);
    const original = { ...request('same', 'pii:scan-text'), ownerKey: 'context-a', clientId: 'client-a' };
    handle.cancel(cancelMessage(original)); // A cancel arriving before its scan must survive.
    const elsewhere = { ...original, ownerKey: 'context-b' };
    await expect(handle(elsewhere)).resolves.toMatchObject({ type: 'pii:ready' });
    await expect(handle({ ...original, clientId: 'client-b' })).resolves.toMatchObject({ type: 'pii:ready' });
    await expect(handle(original)).resolves.toMatchObject({ error: { code: 'CANCELLED' } });
    expect(execute).toHaveBeenCalledTimes(2);
    handle.cancel(cancelMessage(elsewhere)); // Completed cancellation is a no-op.
    await expect(handle(elsewhere)).resolves.toMatchObject({ type: 'pii:ready' });
    for (let i = 0; i < 600; i++) handle.cancel(cancelMessage(request(`unknown-${i}`, 'pii:scan-text')));
    await expect(handle(request('unknown-0', 'pii:scan-text'))).resolves.toMatchObject({ type: 'pii:ready' });
    await expect(handle(request('unknown-599', 'pii:scan-text'))).resolves.toMatchObject({ error: { code: 'CANCELLED' } });
    handle.cancel(cancelMessage(request('expires', 'pii:scan-text')));
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1);
    await expect(handle(request('expires', 'pii:scan-text'))).resolves.toMatchObject({ type: 'pii:ready' });
    handle.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('disposal settles initialization and scans and removes all pending timers', async () => {
    vi.useFakeTimers();
    const handle = createCancellableRequestHandler(() => new Promise(() => undefined));
    const a = handle(request('init'));
    const b = handle(request('scan', 'pii:scan-text'));
    handle.dispose();
    handle.dispose();
    for (const result of await Promise.all([a, b])) expect(result).toMatchObject({ error: { code: 'MODEL_NOT_READY' } });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels one worker RPC without terminating the shared worker or failing another request', async () => {
    vi.useFakeTimers();
    const worker = new MockWorker();
    const rpc = createWorkerRpc({ createWorker: () => worker });
    const controller = new AbortController();
    const first = request('a', 'pii:scan-text');
    const second = { ...request('a'), clientId: 'another-client', ownerKey: 'other-context' };
    const a = rpc.request(first, controller.signal);
    const b = rpc.request(second);
    controller.abort();
    await expect(a).resolves.toMatchObject({ error: { code: 'CANCELLED' }, requestId: first.requestId });
    await Promise.resolve();
    expect(requiredAt(worker.postMessage.mock.calls, 2)[0]).toEqual({ ...cancelMessage(first), target: 'worker' });
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.emit('message', { data: scopedResponse(first, { channel: PII_CHANNEL, requestId: first.requestId, type: 'pii:result', result: [] }) });
    worker.emit('message', { data: ready(second) });
    await expect(b).resolves.toMatchObject({ type: 'pii:ready', clientId: 'another-client' });
    expect(vi.getTimerCount()).toBe(0);
    rpc.dispose();
  });
});

describe('background sender ownership and creation races', () => {
  it('does not forward a scan cancelled during offscreen creation and ignores forged owners', async () => {
    const { runtime, listeners, sendMessage } = mockRuntime();
    const creation = deferred<void>();
    const remove = installPiiBackground(runtime, { hasDocument: vi.fn().mockResolvedValue(false),
      createDocument: vi.fn(() => creation.promise) }, { query: vi.fn().mockResolvedValue([]), sendMessage: vi.fn() });
    const sender = { id: runtime.id, tab: { id: 1 }, frameId: 2, documentId: 'document-a', url: 'https://chatgpt.com/' };
    const req = { ...request('creation', 'pii:scan-text'), target: 'background' as const, ownerKey: 'forged' };
    const response = deferred<unknown>();
    for (const listener of listeners) listener(req, sender, response.resolve);
    // A different document/frame cannot cancel this invocation, even with forged owner metadata.
    for (const listener of listeners) listener(cancelMessage(req), { ...sender, documentId: 'document-b' }, vi.fn());
    const responded = vi.fn();
    void response.promise.then(responded);
    await Promise.resolve();
    expect(responded).not.toHaveBeenCalled();
    for (const listener of listeners) listener(cancelMessage(req), sender, vi.fn());
    await expect(response.promise).resolves.toMatchObject({ error: { code: 'CANCELLED' } });
    creation.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sendMessage).not.toHaveBeenCalled();
    remove();
  });
  it('registers adjacent scan/cancel messages synchronously and blocks untrusted offscreen callers', async () => {
    const { runtime, listeners } = mockRuntime();
    let signal: AbortSignal | undefined;
    const remove = installPiiServer(runtime, 'offscreen', async (_req, receivedSignal) => {
      signal = receivedSignal;
      return new Promise(() => undefined);
    });
    const req = { ...request('adjacent', 'pii:scan-text'), target: 'offscreen' as const, ownerKey: 'owned' };
    const response = deferred<unknown>();
    const background: MessageSender = { id: runtime.id, url: runtime.getURL('background.js') };
    for (const listener of listeners) listener(req, background, response.resolve);
    for (const listener of listeners) listener(cancelMessage(req), background, vi.fn());
    await expect(response.promise).resolves.toMatchObject({ error: { code: 'CANCELLED' } });
    expect(signal?.aborted).toBe(true);
    const fake = vi.fn();
    for (const listener of listeners) {
      listener({ ...req, requestId: 'popup' }, { id: runtime.id, url: runtime.getURL('popup.html') }, fake);
      listener({ ...req, requestId: 'foreign' }, { id: 'foreign' }, fake);
    }
    expect(fake).not.toHaveBeenCalled();
    expect(requestKey(req)).not.toEqual(requestKey({ ...req, ownerKey: 'other' }));
    remove();
  });
});
