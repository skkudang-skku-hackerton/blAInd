import { describe, expect, it, vi } from 'vitest';
import { KoPiiDetector } from '../../../src/core/detector/ko-pii/detector';
import { PiiError } from '../../../src/core/api/errors';
import type { ScanOptions } from '../../../src/core/api/types';
import type { ModelOutput, TokenizedInput } from '../../../src/core/detector/types';
import { scanSegments } from '../../../src/core/workflow/scan-segments';
import { contentInput, deferred, fakeRuntime, holdInference, logitsFor } from './fakes';

vi.mock('../../../src/core/detector/ko-pii/runtime', async () => {
  const { fakeRuntime } = await import('./fakes');
  return { KoPiiRuntime: vi.fn(function () { return fakeRuntime().runtime; }) };
});

const scanKinds = ['text', 'segments', 'empty text', 'empty segments'] as const;
type ScanKind = typeof scanKinds[number];
function invoke(detector: KoPiiDetector, kind: ScanKind, options?: ScanOptions) {
  switch (kind) {
    case 'text': return detector.scanText('김민수', options);
    case 'segments': return detector.scanSegments([{ id: 'page', text: '김민수' }], options);
    case 'empty text': return detector.scanText('', options);
    case 'empty segments': return detector.scanSegments([], options);
  }
}

// Observe rejection before aborting, including before deferred initialization/inference settles.
const handled = (promise: Promise<unknown>) => promise.then(
  (value) => ({ status: 'fulfilled' as const, value }),
  (reason: unknown) => ({ status: 'rejected' as const, reason }),
);
const cancelled = { status: 'rejected', reason: { code: 'CANCELLED' } };
const emptyOutput = (input: TokenizedInput) => logitsFor(input.ids.map(() => 0));

function observeListeners(signal: AbortSignal) {
  const add = vi.spyOn(signal, 'addEventListener');
  const remove = vi.spyOn(signal, 'removeEventListener');
  return {
    add, remove,
    expectReleased(count = 1) {
      const listeners = add.mock.calls.filter(([event]) => event === 'abort');
      expect(listeners).toHaveLength(count);
      for (const [, listener] of listeners) {
        expect(remove.mock.calls.filter(([event, removed]) => event === 'abort' && removed === listener)).toHaveLength(1);
      }
    },
  };
}

describe('request-scoped detector cancellation', () => {
  it.each(scanKinds)('rejects pre-aborted %s without initialization or tokenization', async (kind) => {
    const { runtime, tokenizer } = fakeRuntime();
    const controller = new AbortController();
    const listeners = observeListeners(controller.signal);
    controller.abort(new Error('caller reason must not replace CANCELLED'));
    const outcome = await handled(invoke(new KoPiiDetector(runtime), kind, { signal: controller.signal }));
    expect(outcome).toMatchObject(cancelled);
    if (outcome.status === 'rejected') expect(outcome.reason).toBeInstanceOf(PiiError);
    expect(runtime.initialize).not.toHaveBeenCalled();
    expect(tokenizer.encode).not.toHaveBeenCalled();
    expect(runtime.infer).not.toHaveBeenCalled();
    expect(listeners.add).not.toHaveBeenCalled();
  });

  it.each(scanKinds)('cancels initialization-waiting %s promptly while shared initialization continues', async (kind) => {
    const { runtime, tokenizer } = fakeRuntime();
    const initialization = deferred<void>();
    const initializing = deferred<void>();
    runtime.initialize.mockImplementation(() => { initializing.resolve(); return initialization.promise; });
    const detector = new KoPiiDetector(runtime);
    const controller = new AbortController();
    const listeners = observeListeners(controller.signal);
    const first = handled(invoke(detector, kind, { signal: controller.signal }));
    await initializing.promise;
    const sharedInitialization = detector.initialize();
    const second = detector.scanText('other');
    controller.abort();
    expect(await first).toMatchObject(cancelled);
    listeners.expectReleased();
    expect(runtime.initialize).toHaveBeenCalledTimes(1);
    expect(tokenizer.encode).not.toHaveBeenCalled();
    initialization.resolve();
    await sharedInitialization;
    await expect(second).resolves.toEqual([]);
    expect(runtime.initialize).toHaveBeenCalledTimes(1);
    expect(tokenizer.encode).toHaveBeenCalledExactlyOnceWith('other', false);
  });

  it('handles late initialization rejection after cancellation and allows retry', async () => {
    const { runtime } = fakeRuntime();
    const initialization = deferred<void>();
    const initializing = deferred<void>();
    runtime.initialize.mockImplementationOnce(() => { initializing.resolve(); return initialization.promise; });
    const detector = new KoPiiDetector(runtime);
    const controller = new AbortController();
    const outcome = handled(detector.scanText('a', { signal: controller.signal }));
    await initializing.promise;
    const shared = handled(detector.initialize());
    controller.abort();
    expect(await outcome).toMatchObject(cancelled);
    initialization.reject(new Error('late load failure'));
    expect(await shared).toMatchObject({ status: 'rejected', reason: { code: 'MODEL_LOAD_FAILED' } });
    await expect(detector.scanText('b')).resolves.toEqual([]);
    expect(runtime.initialize).toHaveBeenCalledTimes(2);
  });

  it('handles immediate cancellation before the initialization microtask without stopping shared initialization', async () => {
    const { runtime, tokenizer } = fakeRuntime();
    const initialization = deferred<void>();
    runtime.initialize.mockImplementation(() => initialization.promise);
    const detector = new KoPiiDetector(runtime);
    const controller = new AbortController();
    const outcome = handled(detector.scanText('a', { signal: controller.signal }));
    controller.abort();
    expect(await outcome).toMatchObject(cancelled);
    expect(runtime.initialize).toHaveBeenCalledTimes(1);
    expect(tokenizer.encode).not.toHaveBeenCalled();
    initialization.resolve();
    await detector.initialize();
    await expect(detector.scanText('b')).resolves.toEqual([]);
    expect(runtime.initialize).toHaveBeenCalledTimes(1);
  });

  it.each(scanKinds)('removes queued %s promptly without executing it or disturbing the active scan', async (kind) => {
    const { runtime, tokenizer } = fakeRuntime();
    const held = holdInference(runtime);
    const detector = new KoPiiDetector(runtime);
    const active = detector.scanText('active');
    const input = await held.started;
    const controller = new AbortController();
    const listeners = observeListeners(controller.signal);
    const queued = handled(invoke(detector, kind, { signal: controller.signal }));
    const survivor = detector.scanText('survivor');
    controller.abort();
    expect(await queued).toMatchObject(cancelled);
    listeners.expectReleased();
    expect(runtime.infer).toHaveBeenCalledTimes(1);
    held.result.resolve(emptyOutput(input));
    await expect(active).resolves.toEqual([]);
    await expect(survivor).resolves.toEqual([]);
    expect(vi.mocked(tokenizer.encode).mock.calls.map(([text]) => text)).toEqual(['active', 'survivor']);
  });

  it.each(['late result', 'malformed late result', 'late failure'] as const)(
    'rejects active work promptly, discards %s, and retains inference serialization', async (late) => {
      const { runtime, tokenizer } = fakeRuntime();
      const dispose = vi.fn(async () => {});
      const held = holdInference(runtime);
      const detector = new KoPiiDetector({ ...runtime, dispose });
      const controller = new AbortController();
      const listeners = observeListeners(controller.signal);
      const active = handled(detector.scanText('a'.repeat(1100), { signal: controller.signal }));
      const input = await held.started;
      const second = detector.scanText('other');
      controller.abort();
      expect(await active).toMatchObject(cancelled); // Inference remains unresolved here.
      listeners.expectReleased();
      controller.abort();
      controller.signal.dispatchEvent(new Event('abort'));
      listeners.expectReleased();
      expect(dispose).not.toHaveBeenCalled();
      expect(runtime.infer).toHaveBeenCalledTimes(1);
      expect(tokenizer.encode).toHaveBeenCalledTimes(1);
      if (late === 'late failure') held.result.reject(new Error('late backend failure'));
      else if (late === 'malformed late result') held.result.resolve({ logits: new Float32Array(0), dims: [] });
      else held.result.resolve(emptyOutput(input));
      await expect(second).resolves.toEqual([]);
      expect(await active).toMatchObject(cancelled);
      expect(runtime.infer).toHaveBeenCalledTimes(2);
      expect(dispose).not.toHaveBeenCalled();
    },
  );

  it('discards an unfinished segment batch and does not tokenize later segments', async () => {
    const { runtime, tokenizer } = fakeRuntime([{ start: 0, end: 1 }]);
    const original = runtime.infer.getMockImplementation()!;
    const inference = deferred<ModelOutput>();
    const started = deferred<TokenizedInput>();
    // Complete the first segment, then hold the second inference open.
    runtime.infer.mockReset().mockImplementation(original).mockImplementationOnce(original)
      .mockImplementationOnce((input) => {
        started.resolve(input);
        return inference.promise;
      });
    const detector = new KoPiiDetector(runtime);
    const controller = new AbortController();
    const result = handled(detector.scanSegments([
      { id: 'done', text: 'a' }, { id: 'active', text: 'b' }, { id: 'remaining', text: 'c' },
    ], { signal: controller.signal }));
    const input = await started.promise;
    controller.abort();
    expect(await result).toMatchObject(cancelled);
    inference.resolve(emptyOutput(input));
    await detector.scanText('after');
    expect(vi.mocked(tokenizer.encode).mock.calls.map(([text]) => text)).toEqual(['a', 'b', 'after']);
  });

  it.each(['chunks', 'segments'] as const)('yields to event-loop cancellation between %s without partial results', async (kind) => {
    const { runtime, tokenizer } = fakeRuntime([{ start: 0, end: 1 }]);
    const controller = new AbortController();
    const original = runtime.infer.getMockImplementation()!;
    runtime.infer.mockImplementationOnce(async (input) => {
      setTimeout(() => controller.abort(), 0);
      return original(input);
    });
    const detector = new KoPiiDetector(runtime);
    const result = kind === 'chunks'
      ? detector.scanText('a'.repeat(1100), { signal: controller.signal })
      : detector.scanSegments([{ id: 'one', text: 'a' }, { id: 'two', text: 'b' }], { signal: controller.signal });
    expect(await handled(result)).toMatchObject(cancelled);
    await detector.scanText('after');
    expect(runtime.infer).toHaveBeenCalledTimes(2);
    expect(vi.mocked(tokenizer.encode).mock.calls.map(([text]) => text)).toEqual([kind === 'chunks' ? 'a'.repeat(1100) : 'a', 'after']);
  });

  it('intentionally cancels active and queued scans reusing one signal, leaving other signals untouched', async () => {
    const { runtime } = fakeRuntime();
    const held = holdInference(runtime);
    const detector = new KoPiiDetector(runtime);
    const shared = new AbortController();
    const other = new AbortController();
    const listeners = observeListeners(shared.signal);
    const first = handled(detector.scanText('first', { signal: shared.signal }));
    const input = await held.started;
    const second = handled(detector.scanSegments([{ id: 'second', text: 'second' }], { signal: shared.signal }));
    const third = detector.scanText('third', { signal: other.signal });
    shared.abort();
    expect(await first).toMatchObject(cancelled);
    expect(await second).toMatchObject(cancelled);
    listeners.expectReleased(2);
    expect(other.signal.aborted).toBe(false);
    held.result.resolve(emptyOutput(input));
    await expect(third).resolves.toEqual([]);
    expect(runtime.infer).toHaveBeenCalledTimes(2);
  });

  it('yields between empty segments so cancellation cannot be starved by a microtask-only batch', async () => {
    const { runtime, tokenizer } = fakeRuntime();
    const controller = new AbortController();
    const detector = new KoPiiDetector(runtime);
    const result = handled(detector.scanSegments(Array.from({ length: 100 }, (_, index) => ({
      id: String(index), text: '',
    })), { signal: controller.signal }));
    setTimeout(() => controller.abort(), 0);
    expect(await result).toMatchObject(cancelled);
    expect(tokenizer.encode).not.toHaveBeenCalled();
    expect(runtime.infer).not.toHaveBeenCalled();
    await expect(detector.scanText('after')).resolves.toEqual([]);
  });

  it('assigns distinct invocation IDs even without signals and releases cancelled queued state', async () => {
    const { runtime } = fakeRuntime();
    const held = holdInference(runtime);
    const detector = new KoPiiDetector(runtime);
    const active = detector.scanText('active');
    const input = await held.started;
    const signal = new AbortController();
    const first = detector.scanText('one');
    const second = detector.scanSegments([{ id: 'two', text: 'two' }]);
    const third = handled(detector.scanText('three', { signal: signal.signal }));
    // Internal IDs are deliberately not public or derived from caller identifiers.
    const state = detector as unknown as { pending: { request: { id: symbol } }[] };
    const ids = state.pending.map((job) => job.request.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    signal.abort();
    expect(await third).toMatchObject(cancelled);
    expect(state.pending.map((job) => job.request.id)).toEqual(ids.slice(0, 2));
    held.result.resolve(emptyOutput(input));
    await Promise.all([active, first, second]);
    expect(state.pending).toEqual([]);
  });

  it('closes an abort race during listener registration', async () => {
    const { runtime } = fakeRuntime();
    const controller = new AbortController();
    const original = controller.signal.addEventListener.bind(controller.signal);
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    vi.spyOn(controller.signal, 'addEventListener').mockImplementation((...args) => {
      controller.abort(); // Abort before the listener is actually registered.
      original(...args);
    });
    expect(await handled(new KoPiiDetector(runtime).scanText('a', { signal: controller.signal }))).toMatchObject(cancelled);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(runtime.initialize).not.toHaveBeenCalled();
  });

  it('catches cancellation during segment setup and releases its listener', async () => {
    const { runtime } = fakeRuntime();
    const controller = new AbortController();
    const listeners = observeListeners(controller.signal);
    const segment = { id: 'page', get text() { controller.abort(); return 'a'; } };
    expect(await handled(new KoPiiDetector(runtime).scanSegments([segment], { signal: controller.signal }))).toMatchObject(cancelled);
    listeners.expectReleased();
    expect(runtime.initialize).not.toHaveBeenCalled();
  });

  it.each(['encode', 'prepare'] as const)('checks cancellation raised during tokenizer %s before inference', async (stage) => {
    const { runtime, tokenizer } = fakeRuntime();
    const controller = new AbortController();
    if (stage === 'encode') {
      vi.mocked(tokenizer.encode).mockImplementation((text) => { controller.abort(); return contentInput(text); });
    } else {
      const original = vi.mocked(tokenizer.prepare).getMockImplementation()!;
      vi.mocked(tokenizer.prepare).mockImplementation((input) => { controller.abort(); return original(input); });
    }
    expect(await handled(new KoPiiDetector(runtime).scanText('a', { signal: controller.signal }))).toMatchObject(cancelled);
    expect(runtime.infer).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('cancellation wins when inference %s races before scan settlement', async (completion) => {
    const { runtime } = fakeRuntime();
    const held = holdInference(runtime);
    const detector = new KoPiiDetector(runtime);
    const controller = new AbortController();
    const outcome = handled(detector.scanText('a', { signal: controller.signal }));
    const input = await held.started;
    if (completion === 'resolve') held.result.resolve(emptyOutput(input));
    else held.result.reject(new Error('racing failure'));
    controller.abort();
    expect(await outcome).toMatchObject(cancelled);
    await expect(detector.scanText('b')).resolves.toEqual([]);
  });

  it('checks cancellation triggered during final postprocessing before returning results', async () => {
    const { runtime } = fakeRuntime();
    const controller = new AbortController();
    const original = runtime.labels;
    const detector = new KoPiiDetector({ ...runtime, labels: () => { controller.abort(); return original(); } });
    expect(await handled(detector.scanText('a', { signal: controller.signal }))).toMatchObject(cancelled);
  });

  it.each(['success', 'inference failure', 'initialization failure', 'invalid input'] as const)(
    'releases listeners on %s and ignores cancellation after settlement', async (completion) => {
      const { runtime } = fakeRuntime();
      if (completion === 'inference failure') runtime.infer.mockRejectedValueOnce(new Error('failure'));
      if (completion === 'initialization failure') runtime.initialize.mockRejectedValueOnce(new Error('failure'));
      const controller = new AbortController();
      const listeners = observeListeners(controller.signal);
      const detector = new KoPiiDetector(runtime);
      const result = handled(detector.scanText(completion === 'invalid input' ? null as unknown as string : 'a', { signal: controller.signal }));
      const outcome = await result;
      if (completion === 'success') expect(outcome).toMatchObject({ status: 'fulfilled', value: [] });
      else expect(outcome).toMatchObject({ status: 'rejected', reason: { code:
        completion === 'inference failure' ? 'INFERENCE_FAILED' : completion === 'initialization failure' ? 'MODEL_LOAD_FAILED' : 'INVALID_INPUT',
      } });
      listeners.expectReleased();
      controller.abort();
      controller.signal.dispatchEvent(new Event('abort'));
      expect(await result).toBe(outcome);
      listeners.expectReleased();
      await expect(detector.scanText('after')).resolves.toEqual([]);
    },
  );

  it('forwards workflow cancellation and preserves completed scans sharing the signal', async () => {
    const { runtime } = fakeRuntime();
    const held = holdInference(runtime);
    const detector = new KoPiiDetector(runtime);
    const controller = new AbortController();
    // An empty scan initializes but does not consume the held inference.
    const completed = await scanSegments(detector, [], { signal: controller.signal });
    const active = handled(scanSegments(detector, [{ id: 'one', text: 'a' }, { id: 'two', text: 'b' }], { signal: controller.signal }));
    const input = await held.started;
    controller.abort();
    expect(await active).toMatchObject(cancelled);
    expect(completed).toEqual([]);
    held.result.resolve(emptyOutput(input));
    await detector.scanText('after');
    expect(runtime.infer).toHaveBeenCalledTimes(2);
  });
});
