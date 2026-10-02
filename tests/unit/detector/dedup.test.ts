import { describe, expect, it } from 'vitest';
import { deduplicateDetections } from '../../../src/core/detector/ko-pii/dedup';
import type { ChunkDetection } from '../../../src/core/detector/ko-pii/postprocess';

const detection = (start: number, end: number, chunkIndex: number, extra: Partial<ChunkDetection> = {}): ChunkDetection => ({
  type: 'PERSON', confidence: 0.9, span: { start, end }, chunkIndex,
  truncatedStart: false, truncatedEnd: false, ...extra,
});

describe('overlap reconciliation', () => {
  it('keeps the complete entity over a confident clipped fragment and highest exact confidence', () => {
    const result = deduplicateDetections([
      detection(10, 12, 0, { truncatedEnd: true, confidence: 0.99 }),
      detection(10, 20, 1, { confidence: 0.8 }),
      detection(10, 20, 2, { confidence: 0.95 }),
      detection(18, 20, 3, { truncatedStart: true }),
    ]);
    expect(result).toEqual([{ type: 'PERSON', confidence: 0.95, span: { start: 10, end: 20 } }]);
  });

  it('joins complementary clipped fragments, preserves adjacent entities, and resolves conflicting types', () => {
    expect(deduplicateDetections([
      detection(0, 10, 0, { truncatedEnd: true }),
      detection(8, 20, 1, { truncatedStart: true }),
      detection(20, 30, 2),
      detection(0, 10, 3, { type: 'PHONE' }),
    ]).map((item) => [item.type, item.span])).toEqual([
      ['PERSON', { start: 0, end: 20 }],
      ['PERSON', { start: 20, end: 30 }],
    ]);
  });

  it('preserves adjacent entities observed separately in the same chunk', () => {
    expect(deduplicateDetections([
      detection(0, 10, 0), detection(10, 20, 0),
      detection(0, 10, 1), detection(10, 20, 1),
    ])).toHaveLength(2);
    expect(deduplicateDetections([
      detection(0, 10, 0), detection(9, 10, 0), detection(0, 10, 1),
    ])).toHaveLength(1);
  });

  it.each([
    ['different types', [detection(0, 10, 0), detection(5, 15, 1, { type: 'PHONE', confidence: 0.95 })], [5, 15]],
    ['same-chunk containment', [detection(0, 10, 0), detection(2, 8, 0)], [0, 10]],
    ['partial overlap', [detection(0, 10, 0), detection(5, 15, 1, { confidence: 0.95 })], [5, 15]],
    ['complete over clipped', [detection(0, 10, 0, { confidence: 0.7 }), detection(5, 15, 1, { confidence: 0.99, truncatedStart: true })], [0, 10]],
    ['length tie-break', [detection(0, 10, 0), detection(5, 20, 1)], [5, 20]],
    ['start tie-break', [detection(0, 10, 0), detection(5, 15, 1)], [0, 10]],
    ['type tie-break', [detection(0, 10, 0, { type: 'PHONE' }), detection(0, 10, 1)], [0, 10]],
  ] as const)('resolves %s deterministically', (_, candidates, span) => {
    const result = deduplicateDetections(candidates);
    expect(result).toHaveLength(1);
    expect(result[0]?.span).toEqual({ start: span[0], end: span[1] });
    expect(deduplicateDetections([...candidates].reverse())).toEqual(result);
    if (candidates[0].span.start === candidates[1].span.start && candidates[0].type !== candidates[1].type) {
      expect(result[0]?.type).toBe('PERSON');
    }
  });

  it('retains non-overlapping candidates in an overlap chain and sorts by offset', () => {
    const result = deduplicateDetections([
      detection(8, 14, 2, { confidence: 0.95 }),
      detection(4, 10, 1, { confidence: 0.8 }),
      detection(0, 6, 0),
      detection(14, 20, 3),
    ]);
    expect(result.map(({ span }) => span)).toEqual([
      { start: 0, end: 6 }, { start: 8, end: 14 }, { start: 14, end: 20 },
    ]);
  });

  it('chooses stronger complete near-duplicates and averages unique token evidence for joined fragments', () => {
    expect(deduplicateDetections([
      detection(0, 10, 0, { confidence: 0.7 }), detection(0, 9, 1, { confidence: 0.95 }),
    ])[0]?.span).toEqual({ start: 0, end: 9 });
    const result = deduplicateDetections([
      detection(0, 3, 0, { truncatedEnd: true, tokenConfidences: [
        { tokenIndex: 0, confidence: 0.6 }, { tokenIndex: 1, confidence: 0.7 }, { tokenIndex: 2, confidence: 0.8 },
      ] }),
      detection(2, 4, 1, { truncatedStart: true, tokenConfidences: [
        { tokenIndex: 2, confidence: 0.9 }, { tokenIndex: 3, confidence: 1 },
      ] }),
    ]);
    expect(result[0]?.span).toEqual({ start: 0, end: 4 });
    expect(result[0]?.confidence).toBeCloseTo((0.6 + 0.7 + 0.9 + 1) / 4);
  });
});
