import { assert, describe, expect, it, vi } from 'vitest';
import { KoPiiDetector } from '../../../src/core/detector/ko-pii/detector';
import { PiiError } from '../../../src/core/api/errors';
import { scanSegments } from '../../../src/core/workflow/scan-segments';
import { fakeRuntime, logitsFor } from './fakes';

// The real runtime has its own tests; detector unit tests never load model assets.
vi.mock('../../../src/core/detector/ko-pii/runtime', async () => {
  const { fakeRuntime } = await import('./fakes');
  return { KoPiiRuntime: vi.fn(function () { return fakeRuntime().runtime; }) };
});

describe('KoPiiDetector', () => {
  it('supports constructing with the default runtime', async () => {
    await expect(new KoPiiDetector().scanText('김민수')).resolves.toEqual([]);
  });
  it('initializes once concurrently and retries failed initialization', async () => {
    const { runtime } = fakeRuntime();
    runtime.initialize.mockRejectedValueOnce(new Error('load failed'));
    const detector = new KoPiiDetector(runtime);
    const failed = await Promise.allSettled([detector.initialize(), detector.initialize()]);
    expect(failed.every((result) => result.status === 'rejected')).toBe(true);
    expect(runtime.initialize).toHaveBeenCalledTimes(1);
    await Promise.all([detector.initialize(), detector.scanText(''), detector.initialize()]);
    expect(runtime.initialize).toHaveBeenCalledTimes(2);
  });

  it('auto-initializes, tokenizes once, wraps token slices, and reconciles chunk boundary spans', async () => {
    const text = '😀' + '가'.repeat(899);
    const { runtime, tokenizer } = fakeRuntime([
      { start: 500, end: 530 }, { start: 800, end: 810, label: 3 },
    ]);
    const result = await new KoPiiDetector(runtime).scanText(text);
    expect(result.map(({ type, span }) => ({ type, span }))).toEqual([
      { type: 'PERSON', span: { start: 500, end: 530 } },
      { type: 'PHONE', span: { start: 800, end: 810 } },
    ]);
    const [person] = result;
    assert.isDefined(person);
    expect(text.slice(person.span.start, person.span.end)).toBe('가'.repeat(30));
    expect(tokenizer.encode).toHaveBeenCalledExactlyOnceWith(text, false);
    expect(tokenizer.prepare).toHaveBeenCalledTimes(3);
    expect(runtime.infer.mock.calls.map(([input]) => input.ids.length)).toEqual([514, 514, 134]);
  });

  it('preserves segment IDs, duplicate IDs, empty segments and order', async () => {
    const { runtime } = fakeRuntime([{ start: 0, end: 2 }]);
    const detector = new KoPiiDetector(runtime);
    const result = await scanSegments(detector, [{ id: 'same', text: '김민' }, { id: '', text: '' }, { id: 'same', text: 'AB' }]);
    expect(result.map((item) => item.segmentId)).toEqual(['same', '', 'same']);
    expect(result[1]?.detections).toEqual([]);
    expect(result[2]?.detections[0]?.span).toEqual({ start: 0, end: 2 });
    expect(await detector.scanSegments([])).toEqual([]);
  });

  it('reconciles an entity longer than the overlap across three chunks', async () => {
    const { runtime } = fakeRuntime([{ start: 350, end: 1000 }]);
    const result = await new KoPiiDetector(runtime).scanText('a'.repeat(1100));
    expect(result).toHaveLength(1);
    const [entity] = result;
    assert.isDefined(entity);
    expect(entity.span).toEqual({ start: 350, end: 1000 });
    expect(entity.confidence).toBeCloseTo(1 / (1 + 4 * Math.exp(-6)));
    expect(Object.keys(entity).sort()).toEqual(['confidence', 'span', 'type']);
  });

  it('returns non-overlapping spans for text and segments when chunks disagree on entity types', async () => {
    const { runtime } = fakeRuntime();
    runtime.infer.mockImplementation(async (input) => {
      const firstChunk = input.offsets[1]?.[0] === 0;
      const start = firstChunk ? 400 : 420;
      const end = firstChunk ? 450 : 460;
      const label = firstChunk ? 1 : 3;
      return logitsFor(input.offsets.map(([tokenStart, tokenEnd], i) =>
        !input.specialTokensMask[i] && tokenStart >= start && tokenEnd <= end
          ? label + Number(tokenStart !== start) : 0), [-2, firstChunk ? 3 : 4]);
    });
    const detector = new KoPiiDetector(runtime);
    const text = 'a'.repeat(600);
    const detections = await detector.scanText(text);
    expect(detections).toEqual([
      { type: 'PHONE', confidence: expect.any(Number), span: { start: 400, end: 460 }, constituents: [
        { type: 'PERSON', confidence: expect.any(Number), span: { start: 400, end: 450 } },
        { type: 'PHONE', confidence: expect.any(Number), span: { start: 420, end: 460 } },
      ] },
    ]);
    expect(await detector.scanSegments([{ id: 'first', text }, { id: 'second', text }])).toEqual([
      { segmentId: 'first', detections }, { segmentId: 'second', detections },
    ]);
  });

  it('rejects malformed inputs before initialization or partial batch inference', async () => {
    const { runtime } = fakeRuntime();
    const detector = new KoPiiDetector(runtime);
    await expect(detector.scanText(null as unknown as string)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (const segments of [null, [{ id: 'ok', text: 'a' }, { id: 2, text: 'a' }], Array(2)]) {
      await expect(detector.scanSegments(segments as never)).rejects.toBeInstanceOf(PiiError);
    }
    expect(runtime.initialize).not.toHaveBeenCalled();
    expect(runtime.infer).not.toHaveBeenCalled();
  });

  it('serializes concurrent inference and recovers the queue after a failure', async () => {
    const { runtime } = fakeRuntime();
    let running = 0;
    let maximum = 0;
    let calls = 0;
    runtime.infer.mockImplementation(async (input) => {
      running++;
      maximum = Math.max(maximum, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      if (calls++ === 0) throw new Error('session failure');
      return logitsFor(input.ids.map(() => 0));
    });
    const detector = new KoPiiDetector(runtime);
    const results = await Promise.allSettled([detector.scanText('a'), detector.scanText('b'), detector.scanSegments([{ id: 'c', text: 'c' }])]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'INFERENCE_FAILED' } });
    expect(results.slice(1).every((item) => item.status === 'fulfilled')).toBe(true);
    expect(maximum).toBe(1);
  });

  it('normalizes malformed outputs and preserves runtime PiiError codes', async () => {
    const { runtime } = fakeRuntime();
    runtime.infer.mockResolvedValueOnce({ logits: new Float32Array(0), dims: [1, 0, 5] });
    runtime.infer.mockRejectedValueOnce(new PiiError('OUT_OF_MEMORY', 'allocation failed'));
    const detector = new KoPiiDetector(runtime);
    await expect(detector.scanText('a')).rejects.toMatchObject({ code: 'INFERENCE_FAILED' });
    await expect(detector.scanText('a')).rejects.toMatchObject({ code: 'OUT_OF_MEMORY' });
  });
});
