import { describe, expect, it } from 'vitest';
import { applyMasking } from '../../src/alert/masking';
import { analyzeDetections, buildReviewResult } from '../../src/alert/policy';
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

describe('editable default masking decisions', () => {
  it('keeps automatic defaults unless explicitly deselected and includes every unchecked item', () => {
    const analysis = analyzeDetections('김민수 010-1234-5678', [
      detection(0, 3, 'PERSON'), detection(4, 17, 'PHONE'),
    ]);
    const snapshot = structuredClone(analysis);
    expect(buildReviewResult(analysis).autoMask.map(item => item.type)).toEqual(['PHONE']);
    const decision = buildReviewResult(analysis, analysis.confirmDetections, []);
    expect(decision.autoMask).toEqual([]);
    expect(decision.confirm.masking.map(item => item.type)).toEqual(['PERSON']);
    expect(decision.confirm.nonMasking).toEqual([
      { segmentId: 'text', type: 'PHONE', span: { start: 4, end: 17 }, word: '010-1234-5678' },
    ]);
    expect(buildReviewResult(analysis, [], []).confirm.nonMasking.map(item => item.type)).toEqual(['PERSON', 'PHONE']);
    expect(analysis).toEqual(snapshot);
  });

  it('rejects selected detections from another policy or review', () => {
    const analysis = analyzeDetections('김민수 010-1234-5678', [
      detection(0, 3, 'PERSON'), detection(4, 17, 'PHONE'),
    ]);
    expect(() => buildReviewResult(analysis, [analysis.autoMaskedDetections[0]!])).toThrow('does not belong');
    expect(() => buildReviewResult(analysis, [], [analysis.confirmDetections[0]!])).toThrow('does not belong');
    expect(() => buildReviewResult(analysis, [], [detection(4, 17, 'PHONE')])).toThrow('does not belong');
  });
});

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

  it.each([
    ['partial overlap', detection(0, 5, 'PHONE'), detection(3, 10, 'PERSON')],
    ['contained mask', detection(3, 5, 'PHONE'), detection(0, 10, 'PERSON')],
    ['contained keep', detection(0, 10, 'PHONE'), detection(3, 5, 'PERSON')],
    ['identical spans with conflicting types', detection(0, 10, 'PHONE'), detection(0, 10, 'GENERIC_ID')],
    ['selected Confirm', detection(0, 5, 'PERSON'), detection(3, 10, 'PERSON')],
    ['unchecked Auto Mask', detection(0, 5, 'PERSON'), detection(3, 10, 'PHONE')],
    ['two Auto Mask items', detection(0, 5, 'RRN'), detection(3, 10, 'PHONE')],
    ['adjacent spans', detection(0, 5, 'PHONE'), detection(5, 10, 'PERSON')],
  ] as const)('resolves document %s without extending masks into unselected-only coverage', (_, masked, kept) => {
    const text = 'abcdefghij';
    const detections = regions([masked, kept]);
    const analysis = analyzeDetections(text, detections, 's');
    const isSelected = (d: Detection) =>
      d.type === masked.type && d.span.start === masked.span.start && d.span.end === masked.span.end;
    const decision = buildReviewResult(analysis,
      analysis.confirmDetections.filter(isSelected), analysis.autoMaskedDetections.filter(isSelected));
    expect(decision.confirm.nonMasking).toHaveLength(1);
    const request = createReviewRequest([{ id: 's', text }, { id: 'other', text }], [
      { segmentId: 's', detections }, { segmentId: 'other', detections: [] },
    ]);
    const snapshot = structuredClone({ request, decision });
    expect(resolveReview(request, decision)).toEqual([
      { segmentId: 's', spans: [masked.span] }, { segmentId: 'other', spans: [] },
    ]);
    expect({ request, decision }).toEqual(snapshot);
  });
});
