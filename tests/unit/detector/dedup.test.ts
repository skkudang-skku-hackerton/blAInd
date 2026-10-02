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

  it('joins complementary clipped fragments but never merely touching entities or different types', () => {
    expect(deduplicateDetections([
      detection(0, 10, 0, { truncatedEnd: true }),
      detection(8, 20, 1, { truncatedStart: true }),
      detection(20, 30, 2),
      detection(0, 10, 3, { type: 'PHONE' }),
    ]).map((item) => [item.type, item.span])).toEqual([
      ['PHONE', { start: 0, end: 10 }], ['PERSON', { start: 0, end: 20 }],
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
    ])).toHaveLength(2);
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
