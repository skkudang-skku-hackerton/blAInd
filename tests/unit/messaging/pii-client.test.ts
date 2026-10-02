import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({ browser: {} }));
import { PiiError } from '../../../src/core/api/errors';
import { createPiiDetectorClient } from '../../../src/shared/messaging/pii-client';
import { DEFAULT_REQUEST_TIMEOUT_MS, PII_CHANNEL, type PiiRequest } from '../../../src/shared/messaging/types';
import { deferred, mockRuntime, ready, requiredAt } from './helpers';

afterEach(() => vi.useRealTimers());
describe('PII browser client', () => {
  it('shares page preload with concurrent scans and correlates unique scan requests', async () => {
    const { runtime, sendMessage } = mockRuntime();
    const init = deferred<unknown>();
    sendMessage.mockImplementation(async message => {
      const req = message as PiiRequest;
      if (req.type === 'pii:init') return init.promise;
      return { channel: PII_CHANNEL, clientId: req.clientId, requestId: req.requestId, type: 'pii:result', result: [] };
    });
    const client = createPiiDetectorClient({ runtime });
    const preload = client.initialize();
    const scans = [client.scanText('one'), client.scanText('two')];
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    init.resolve(ready(requiredAt(sendMessage.mock.calls, 0)[0] as PiiRequest));
    await expect(preload).resolves.toBeUndefined();
    await expect(Promise.all(scans)).resolves.toEqual([[], []]);
    const messages = sendMessage.mock.calls.map(([message]) => message as PiiRequest);
    expect(new Set(messages.map(message => message.requestId)).size).toBe(3);
    expect(messages.every(message => message.target === 'background')).toBe(true);
    client.dispose();
  });
  it('restores typed remote errors and permits initialization retry', async () => {
    const { runtime, sendMessage } = mockRuntime();
    sendMessage.mockImplementationOnce(async message => ({ channel: PII_CHANNEL,
      requestId: (message as PiiRequest).requestId, clientId: (message as PiiRequest).clientId, type: 'pii:error',
      error: { code: 'MODEL_DOWNLOAD_FAILED', message: 'Download failed.' } }));
    const client = createPiiDetectorClient({ runtime });
    await expect(client.initialize()).rejects.toBeInstanceOf(PiiError);
    sendMessage.mockImplementation(async message => ready(message as PiiRequest));
    await expect(client.initialize()).resolves.toBeUndefined();
    client.dispose();
  });
  it('rejects a response with mismatched ID or invalid result spans', async () => {
    const { runtime, sendMessage } = mockRuntime();
    const client = createPiiDetectorClient({ runtime });
    sendMessage.mockResolvedValue(ready({ requestId: 'wrong-id' }));
    await expect(client.initialize()).rejects.toMatchObject({ code: 'INFERENCE_FAILED' });
    sendMessage.mockImplementation(async message => {
      const req = message as PiiRequest;
      return req.type === 'pii:init' ? ready(req) : { channel: PII_CHANNEL, requestId: req.requestId, clientId: req.clientId,
        type: 'pii:result', result: [{ type: 'PERSON', confidence: 0.9, span: { start: 0, end: 100 } }] };
    });
    await expect(client.scanText('김민수')).rejects.toMatchObject({ code: 'INFERENCE_FAILED' });
    client.dispose();
  });
  it('times out at the 10-minute default, ignores late replies, and retries', async () => {
    vi.useFakeTimers();
    const { runtime, sendMessage } = mockRuntime();
    const late = deferred<unknown>();
    sendMessage.mockReturnValueOnce(late.promise);
    const client = createPiiDetectorClient({ runtime });
    const first = client.initialize();
    const assertion = expect(first).rejects.toMatchObject({ code: 'INFERENCE_FAILED', message: expect.stringContaining('timed out') });
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
    await assertion;
    sendMessage.mockImplementation(async message => ready(message as PiiRequest));
    await expect(client.initialize()).resolves.toBeUndefined();
    late.resolve(ready(requiredAt(sendMessage.mock.calls, 0)[0] as PiiRequest));
    await Promise.resolve();
    client.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('supports status unsubscribe, owned senders, and disposal while pending', async () => {
    const { runtime, sendMessage, listeners } = mockRuntime();
    sendMessage.mockReturnValue(new Promise(() => undefined));
    const client = createPiiDetectorClient({ runtime, requestTimeoutMs: 20 });
    const status = vi.fn();
    const unsubscribe = client.onStatus(status);
    const event = { channel: PII_CHANNEL, target: 'client', type: 'pii:status', status: { state: 'loading' } };
    for (const listener of listeners) {
      listener(event, { id: 'foreign-extension' }, vi.fn());
      listener(event, { id: runtime.id }, vi.fn());
    }
    expect(status).toHaveBeenCalledTimes(1);
    unsubscribe();
    for (const listener of listeners) listener(event, { id: runtime.id }, vi.fn());
    expect(status).toHaveBeenCalledTimes(1);
    const init = client.initialize();
    const assertion = expect(init).rejects.toMatchObject({ code: 'MODEL_NOT_READY' });
    client.dispose();
    client.dispose();
    await assertion;
    expect(listeners.size).toBe(0);
    await expect(client.scanText('text')).rejects.toMatchObject({ code: 'MODEL_NOT_READY' });
  });
  it('does not expose raw transport exceptions and rejects invalid input before messaging', async () => {
    const { runtime, sendMessage } = mockRuntime();
    const client = createPiiDetectorClient({ runtime });
    await expect(client.scanText(123 as unknown as string)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(sendMessage).not.toHaveBeenCalled();
    sendMessage.mockRejectedValue(new Error('private raw details'));
    await expect(client.initialize()).rejects.toMatchObject({ message: 'PII messaging unavailable.' });
    client.dispose();
  });
});
