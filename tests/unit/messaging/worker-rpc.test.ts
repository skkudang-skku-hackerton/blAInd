import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkerRpc } from '../../../src/entrypoints/offscreen/rpc';
import { PII_CHANNEL } from '../../../src/shared/messaging/types';
import { MockWorker, ready, request, requiredAt } from './helpers';
afterEach(() => vi.useRealTimers());

describe('offscreen worker RPC', () => {
  it('creates one worker for concurrent requests and resolves out-of-order replies', async () => {
    const worker = new MockWorker();
    const createWorker = vi.fn(() => worker);
    const rpc = createWorkerRpc({ createWorker });
    const first = rpc.request(request('first'));
    const second = rpc.request(request('second'));
    expect(createWorker).toHaveBeenCalledTimes(1);
    worker.emit('message', { data: ready({ requestId: 'second' }) });
    worker.emit('message', { data: ready({ requestId: 'first' }) });
    await expect(second).resolves.toMatchObject({ requestId: 'second', type: 'pii:ready' });
    await expect(first).resolves.toMatchObject({ requestId: 'first', type: 'pii:ready' });
    expect(requiredAt(worker.postMessage.mock.calls, 0)[0]).toMatchObject({ target: 'worker' });
    rpc.dispose();
  });
  it.each(['error', 'messageerror'])('fails all pending calls on %s and starts a new worker on retry', async event => {
    const firstWorker = new MockWorker();
    const nextWorker = new MockWorker();
    const createWorker = vi.fn().mockReturnValueOnce(firstWorker).mockReturnValueOnce(nextWorker);
    const onStatus = vi.fn();
    const rpc = createWorkerRpc({ createWorker, onStatus });
    const pending = [rpc.request(request('a')), rpc.request(request('b'))];
    firstWorker.emit(event, { preventDefault: vi.fn() });
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ type: 'pii:error', error: { code: 'INFERENCE_FAILED' } });
    expect(firstWorker.terminate).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledTimes(1);
    const retry = rpc.request(request('retry'));
    firstWorker.emit('message', { data: ready({ requestId: 'retry' }) });
    nextWorker.emit('message', { data: ready({ requestId: 'retry' }) });
    await expect(retry).resolves.toMatchObject({ type: 'pii:ready' });
    rpc.dispose();
  });
  it('times out, clears every pending timer, and permits restart', async () => {
    vi.useFakeTimers();
    const workers = [new MockWorker(), new MockWorker()] as const;
    const rpc = createWorkerRpc({ createWorker: vi.fn().mockReturnValueOnce(workers[0]).mockReturnValueOnce(workers[1]), requestTimeoutMs: 50 });
    const first = rpc.request(request('a'));
    const second = rpc.request(request('b'));
    await vi.advanceTimersByTimeAsync(50);
    for (const result of await Promise.all([first, second])) expect(result).toMatchObject({ type: 'pii:error', error: { message: expect.stringContaining('timed out') } });
    expect(vi.getTimerCount()).toBe(0);
    const retry = rpc.request(request('retry'));
    workers[1].emit('message', { data: ready({ requestId: 'retry' }) });
    await expect(retry).resolves.toMatchObject({ type: 'pii:ready' });
    rpc.dispose();
  });
  it('recovers from worker construction and postMessage failures without leaking raw errors', async () => {
    const worker = new MockWorker();
    worker.postMessage.mockImplementationOnce(() => { throw new Error('raw input'); });
    const factory = vi.fn().mockImplementationOnce(() => { throw new Error('raw worker'); }).mockReturnValue(worker);
    const rpc = createWorkerRpc({ createWorker: factory });
    for (const id of ['construction', 'post']) {
      await expect(rpc.request(request(id))).resolves.toMatchObject({ type: 'pii:error', error: { code: 'MODEL_LOAD_FAILED', message: 'Could not start the PII inference worker.' } });
    }
    const retry = rpc.request(request('retry'));
    worker.emit('message', { data: ready({ requestId: 'retry' }) });
    await expect(retry).resolves.toMatchObject({ type: 'pii:ready' });
    rpc.dispose();
  });
  it('honors a propagated client deadline longer than the host default', async () => {
    vi.useFakeTimers();
    const worker = new MockWorker();
    const rpc = createWorkerRpc({ createWorker: () => worker, requestTimeoutMs: 10 });
    const pending = rpc.request({ ...request('long-init'), requestTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(50);
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.emit('message', { data: ready({ requestId: 'long-init' }) });
    await expect(pending).resolves.toMatchObject({ type: 'pii:ready' });
    expect(vi.getTimerCount()).toBe(0);
    rpc.dispose();
  });
  it('validates replies, fans each status out once, and rejects duplicate IDs', async () => {
    const worker = new MockWorker();
    const onStatus = vi.fn();
    const rpc = createWorkerRpc({ createWorker: () => worker, onStatus });
    const first = rpc.request(request('first'));
    await expect(rpc.request(request('first'))).resolves.toMatchObject({ type: 'pii:error', error: { code: 'INVALID_INPUT' } });
    worker.emit('message', { data: { channel: PII_CHANNEL, type: 'pii:status', target: 'background', status: { state: 'loading' } } });
    expect(onStatus).toHaveBeenCalledTimes(1);
    worker.emit('message', { data: { channel: PII_CHANNEL, clientId: 'test-client', requestId: 'first', type: 'pii:result', result: [] } });
    await expect(first).resolves.toMatchObject({ type: 'pii:error', error: { code: 'INFERENCE_FAILED' } });
    const pending = rpc.request(request('dispose'));
    rpc.dispose();
    await expect(pending).resolves.toMatchObject({ type: 'pii:error', error: { code: 'MODEL_NOT_READY' } });
    await expect(rpc.request(request('after'))).resolves.toMatchObject({ type: 'pii:error', error: { code: 'MODEL_NOT_READY' } });
  });
});
