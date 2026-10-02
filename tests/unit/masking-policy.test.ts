import { describe, expect, it } from 'vitest';
import { applyMasking } from '../../src/alert/masking';
import { analyzeDetections } from '../../src/alert/policy';
import type { Detection, PiiType } from '../../src/core/api/types';
import { deduplicateDetections } from '../../src/core/detector/ko-pii/dedup';
import { createReviewRequest, resolveReview } from '../../src/modules/documents/shared/review';

const detection = (start: number, end: number, type: PiiType = 'RRN'): Detection =>
  ({ type, confidence: 0.9, span: { start, end } });
const regions = (detections: Detection[]) => deduplicateDetections(detections.map((d, chunkIndex) => ({
  ...d, chunkIndex, truncatedStart: false, truncatedEnd: false,
})));
const finalText = (analysis: ReturnType<typeof analyzeDetections>, selected: readonly Detection[] = []) =>
  applyMasking(analysis.originalText, [...analysis.autoMaskedDetections, ...selected]);

describe('selected-span union masking', () => {
  it.each([
    ['partial overlap across types', [detection(0, 5), detection(3, 10, 'PHONE')], '[RRN_1]'],
    ['exact duplicates', [detection(0, 10), detection(0, 10)], '[RRN_1]'],
    ['containment', [detection(0, 10), detection(3, 5, 'PHONE')], '[RRN_1]'],
    ['overlap chain', [detection(0, 4), detection(3, 7, 'PHONE'), detection(6, 10)], '[RRN_1]'],
    ['adjacent spans', [detection(0, 5), detection(5, 10, 'PHONE')], '[RRN_1][PHONE_1]'],
    ['separate spans', [detection(0, 3), detection(7, 10, 'PHONE')], '[RRN_1]defg[PHONE_1]'],
  ] as const)('protects %s', (_, detections, expected) => {
    const snapshot = structuredClone(detections);
    expect(applyMasking('abcdefghij', detections)).toBe(expected);
    expect(applyMasking('abcdefghij', [...detections].reverse())).toBe(expected);
    expect(detections).toEqual(snapshot);
  });

  it('preserves UTF-16 coordinates, untouched suffixes, and repeated merged aliases', () => {
    expect(applyMasking('😀abcde😀Z', [detection(0, 5), detection(4, 9, 'PHONE')])).toBe('[RRN_1]Z');
    expect(applyMasking('abcdefghij abcdefghij', [
      detection(0, 5), detection(3, 10, 'PHONE'), detection(11, 16), detection(14, 21, 'PHONE'),
    ])).toBe('[RRN_1] [RRN_1]');
  });

  it('ignores invalid spans without extending a valid selected region', () => {
    expect(applyMasking('abcdefghij', [
      detection(0, 5), detection(-1, 10), detection(3, 11), detection(5, 5), detection(3.5, 10),
    ])).toBe('[RRN_1]fghij');
  });
});

describe('merged model regions → policy → masking', () => {
  it('protects the complete selected union from the issue reproduction', () => {
    const detections = regions([detection(0, 5), detection(3, 10, 'PHONE')]);
    expect(detections).toHaveLength(1);
    const analysis = analyzeDetections('abcdefghij', detections);
    expect(analysis.autoMaskedDetections).toHaveLength(2);
    expect(finalText(analysis)).toBe('[RRN_1]');
  });

  it('masks both fragments of the reported real-model CARD_NUMBER spans', () => {
    const detections = deduplicateDetections([
      { ...detection(1121, 1349, 'CARD_NUMBER'), chunkIndex: 0, truncatedStart: false, truncatedEnd: true },
      { ...detection(1344, 1356, 'CARD_NUMBER'), chunkIndex: 1, truncatedStart: false, truncatedEnd: false },
    ]);
    const text = 'a'.repeat(1121) + 'x'.repeat(235) + ' untouched';
    expect(finalText(analyzeDetections(text, detections))).toBe('a'.repeat(1121) + '[CARD_NUMBER_1] untouched');
  });

  it.each([
    [detection(0, 5, 'PHONE'), detection(3, 10, 'PERSON'), '[PHONE_1]fghij'],
    [detection(3, 5, 'PHONE'), detection(0, 10, 'PERSON'), 'abc[PHONE_1]fghij'],
    [detection(3, 10, 'PHONE'), detection(0, 5, 'PERSON'), 'abc[PHONE_1]'],
  ] as const)('applies constituent policies rather than the representative type', (auto, confirm, expected) => {
    const analysis = analyzeDetections('abcdefghij', regions([auto, confirm]));
    expect(analysis.autoMaskedDetections).toEqual([auto]);
    expect(analysis.confirmDetections).toEqual([confirm]);
    expect(finalText(analysis)).toBe(expected);
    const selected = finalText(analysis, analysis.confirmDetections);
    expect(selected).not.toMatch(/[a-j]/);
  });

  it('preserves separate confirmation choices inside an overlapping same-type region', () => {
    const analysis = analyzeDetections('abcdefghij', regions([
      detection(0, 5, 'PERSON'), detection(3, 10, 'PERSON'),
    ]));
    expect(finalText(analysis)).toBe('abcdefghij');
    expect(analysis.confirmDetections).toHaveLength(2);
    expect(finalText(analysis, [analysis.confirmDetections[0]!])).toBe('[PERSON_1]fghij');
    expect(finalText(analysis, [analysis.confirmDetections[1]!])).toBe('abc[PERSON_1]');
    expect(finalText(analysis, analysis.confirmDetections)).toBe('[PERSON_1]');
  });

  it('expands merged regions for document review and masks the selected union', () => {
    const detections = regions([detection(0, 5), detection(3, 10, 'PHONE')]);
    const request = createReviewRequest([{ id: 's', text: 'abcdefghij' }], [{ segmentId: 's', detections }]);
    const items = request.segments[0]!.detections.map(({ type, span, word }) => ({ segmentId: 's', type, span, word }));
    expect(items.map(({ type, span }) => ({ type, span }))).toEqual([
      { type: 'RRN', span: { start: 0, end: 5 } }, { type: 'PHONE', span: { start: 3, end: 10 } },
    ]);
    expect(resolveReview(request, { status: 'approved', autoMask: items, confirm: { masking: [], nonMasking: [] } }))
      .toEqual([{ segmentId: 's', spans: [{ start: 0, end: 10 }] }]);
  });
});
