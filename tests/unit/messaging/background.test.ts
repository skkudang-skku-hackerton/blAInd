import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({ browser: {} }));
vi.mock('wxt/utils/define-background', () => ({ defineBackground: (main: unknown) => main }));
import { createOffscreenManager, installPiiBackground } from '../../../src/entrypoints/background';
import { installPiiServer } from '../../../src/shared/messaging/pii-server';
import { PII_CHANNEL, type PiiRequest } from '../../../src/shared/messaging/types';
import { deferred, mockRuntime, ready, request, requiredAt } from './helpers';
afterEach(() => vi.useRealTimers());

describe('MV3 background routing', () => {
  it('shares creation across concurrent calls and rechecks live state after SW restart', async () => {
    const creation = deferred<void>();
    let exists = false;
    const offscreen = { hasDocument: vi.fn(async () => exists), createDocument: vi.fn(async () => {
      await creation.promise;
      exists = true;
    }) };
    const ensure = createOffscreenManager(offscreen);
    const a = ensure();
    const b = ensure();
    expect(a).toBe(b);
    await Promise.resolve();
    expect(offscreen.createDocument).toHaveBeenCalledTimes(1);
    expect(offscreen.createDocument).toHaveBeenCalledWith(expect.objectContaining({ url: 'offscreen.html', reasons: ['WORKERS'] }));
    creation.resolve();
    await Promise.all([a, b]);
    await createOffscreenManager(offscreen)();
    expect(offscreen.createDocument).toHaveBeenCalledTimes(1);
  });
  it('accepts a browser-wide creation race and retries genuine creation failures', async () => {
    const racing = { hasDocument: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      createDocument: vi.fn().mockRejectedValue(new Error('already exists')) };
    await expect(createOffscreenManager(racing)()).resolves.toBeUndefined();
    const offscreen = { hasDocument: vi.fn().mockResolvedValue(false), createDocument: vi.fn()
      .mockRejectedValueOnce(new Error('raw creation error')).mockResolvedValueOnce(undefined) };
    const ensure = createOffscreenManager(offscreen);
    await expect(ensure()).rejects.toMatchObject({ code: 'MODEL_LOAD_FAILED', message: 'Could not create the PII offscreen document.' });
    await expect(ensure()).resolves.toBeUndefined();
    expect(offscreen.createDocument).toHaveBeenCalledTimes(2);
  });
  it('bounds stalled creation and rechecks browser state on retry', async () => {
    vi.useFakeTimers();
    const offscreen = { hasDocument: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      createDocument: vi.fn(() => new Promise<void>(() => undefined)) };
    const ensure = createOffscreenManager(offscreen, 50);
    const assertion = expect(ensure()).rejects.toMatchObject({ code: 'MODEL_LOAD_FAILED', message: expect.stringContaining('timed out') });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    await expect(ensure()).resolves.toBeUndefined();
    expect(offscreen.createDocument).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('routes content-script requests once with explicit targets and rejects foreign senders', async () => {
    const { runtime, listeners, sendMessage } = mockRuntime();
    const offscreen = { hasDocument: vi.fn().mockResolvedValue(true), createDocument: vi.fn() };
    const tabs = { query: vi.fn().mockResolvedValue([]), sendMessage: vi.fn() };
    const remove = installPiiBackground(runtime, offscreen, tabs);
    const offscreenHandle = vi.fn(async req => ready(req));
    const removeOffscreen = installPiiServer(runtime, 'offscreen', offscreenHandle);
    sendMessage.mockImplementation(message => new Promise(resolve => {
      for (const listener of listeners) listener(message, { id: runtime.id }, resolve);
    }));
    const req: PiiRequest = { ...request(), target: 'background' };
    const response = deferred<unknown>();
    const respond = vi.fn(response.resolve);
    const claims = [...listeners].filter(listener => listener(req,
      { id: runtime.id, url: 'https://chatgpt.com/', tab: { id: 42 } }, respond) === true);
    expect(claims).toHaveLength(1);
    await expect(response.promise).resolves.toMatchObject({ type: 'pii:ready', requestId: req.requestId });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(offscreenHandle).toHaveBeenCalledTimes(1);
    expect(requiredAt(sendMessage.mock.calls, 0)[0]).toMatchObject({ target: 'offscreen' });
    for (const listener of listeners) expect(listener(req, { id: 'another-extension' }, vi.fn())).toBeUndefined();
    // Content scripts cannot bypass background and talk directly to the offscreen target.
    for (const listener of listeners) expect(listener({ ...req, target: 'offscreen' },
      { id: runtime.id, tab: { id: 42 } }, vi.fn())).toBeUndefined();
    remove();
    removeOffscreen();
    expect(listeners.size).toBe(0);
  });
  it('fans offscreen status out once per transport and ignores its own fanout', async () => {
    const { runtime, listeners, sendMessage } = mockRuntime();
    sendMessage.mockResolvedValue(undefined);
    const tabs = { query: vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }, {}]),
      sendMessage: vi.fn().mockResolvedValue(undefined) };
    const remove = installPiiBackground(runtime,
      { hasDocument: vi.fn().mockResolvedValue(true), createDocument: vi.fn() }, tabs);
    const event = { channel: PII_CHANNEL, type: 'pii:status', target: 'background', status: { state: 'loading' } };
    for (const listener of listeners) {
      listener(event, { id: runtime.id, url: 'https://chatgpt.com/' }, vi.fn());
      listener(event, { id: runtime.id, url: runtime.getURL('offscreen.html') }, vi.fn());
      listener({ ...event, target: 'client' }, { id: runtime.id }, vi.fn());
    }
    await vi.waitFor(() => expect(tabs.sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(requiredAt(sendMessage.mock.calls, 0)[0]).toMatchObject({ target: 'client' });
    remove();
  });
});
