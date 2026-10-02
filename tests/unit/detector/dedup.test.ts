import { describe, expect, it } from 'vitest';
import { deduplicateDetections } from '../../../src/core/detector/ko-pii/dedup';
import type { ChunkDetection } from '../../../src/core/detector/ko-pii/postprocess';
import { expandDetections } from '../../../src/core/api/detections';

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
    ['different types', [detection(0, 10, 0), detection(5, 15, 1, { type: 'PHONE', confidence: 0.95 })], [0, 15]],
    ['same-chunk containment', [detection(0, 10, 0), detection(2, 8, 0)], [0, 10]],
    ['partial overlap', [detection(0, 10, 0), detection(5, 15, 1, { confidence: 0.95 })], [0, 15]],
    ['complete over clipped', [detection(0, 10, 0, { confidence: 0.7 }), detection(5, 15, 1, { confidence: 0.99, truncatedStart: true })], [0, 15]],
    ['length tie-break', [detection(0, 10, 0), detection(5, 20, 1)], [0, 20]],
    ['start tie-break', [detection(0, 10, 0), detection(5, 15, 1)], [0, 15]],
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

  it('merges the full overlap chain, preserves adjacency, and sorts by offset', () => {
    const result = deduplicateDetections([
      detection(8, 14, 2, { confidence: 0.95 }),
      detection(4, 10, 1, { confidence: 0.8 }),
      detection(0, 6, 0),
      detection(14, 20, 3),
    ]);
    expect(result.map(({ span }) => span)).toEqual([
      { start: 0, end: 14 }, { start: 14, end: 20 },
    ]);
  });

  it('chooses stronger complete near-duplicates and averages unique token evidence for joined fragments', () => {
    expect(deduplicateDetections([
      detection(0, 10, 0, { confidence: 0.7 }), detection(0, 9, 1, { confidence: 0.95 }),
    ])[0]).toEqual({ type: 'PERSON', confidence: 0.95, span: { start: 0, end: 10 } });
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

  it('preserves the reported CARD_NUMBER tail even when the complete fragment is preferred', () => {
    const result = deduplicateDetections([
      detection(1121, 1349, 0, { type: 'CARD_NUMBER', confidence: 0.7503368399, truncatedEnd: true }),
      detection(1344, 1356, 1, { type: 'CARD_NUMBER', confidence: 0.6225434127 }),
    ]);
    expect(result).toEqual([{
      type: 'CARD_NUMBER', confidence: 0.6225434127, span: { start: 1121, end: 1356 },
      constituents: [
        { type: 'CARD_NUMBER', confidence: 0.7503368399, span: { start: 1121, end: 1349 } },
        { type: 'CARD_NUMBER', confidence: 0.6225434127, span: { start: 1344, end: 1356 } },
      ],
    }]);
  });

  it('keeps original type, confidence, and span for policy decisions without mutating candidates', () => {
    const candidates = [detection(0, 5, 0, { type: 'PHONE' }), detection(3, 10, 1)];
    const snapshot = structuredClone(candidates);
    const result = deduplicateDetections(candidates);
    expect(expandDetections(result)).toEqual([
      { type: 'PHONE', confidence: 0.9, span: { start: 0, end: 5 } },
      { type: 'PERSON', confidence: 0.9, span: { start: 3, end: 10 } },
    ]);
    expect(candidates).toEqual(snapshot);
  });

  it('preserves every covered character in both regions and constituents, with no region overlap', () => {
    const candidates = [
      detection(0, 10, 0), detection(0, 9, 1, { confidence: 0.95 }),
      detection(8, 15, 2, { type: 'PHONE' }), detection(14, 18, 3),
      detection(18, 20, 0), detection(25, 30, 1), detection(26, 29, 1),
    ];
    const covered = (items: readonly { span: { start: number; end: number } }[]) =>
      Array.from({ length: 32 }, (_, offset) => items.some(({ span }) => span.start <= offset && offset < span.end));
    const result = deduplicateDetections(candidates);
    expect(covered(result)).toEqual(covered(candidates));
    expect(covered(expandDetections(result))).toEqual(covered(candidates));
    expect(result.every((item, index) => index === 0 || result[index - 1]!.span.end <= item.span.start)).toBe(true);
  });
});
