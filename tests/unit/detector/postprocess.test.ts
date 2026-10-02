import { describe, expect, it } from 'vitest';
import { decodeBio } from '../../../src/core/detector/ko-pii/postprocess';
import { contentInput, fakeRuntime, labels, logitsFor } from './fakes';

describe('BIO decoding', () => {
  it('separates adjacent B entities, recovers orphan I, and averages stable softmax confidence', () => {
    const input = contentInput('김민수AB12');
    const output = logitsFor([2, 2, 0, 1, 1, 3, 4], [1000, 1002]);
    output.logits[1 * 5 + 2] = 1004;
    const detections = decodeBio(output, input, labels, '김민수AB12');
    expect(detections.map(({ type, span }) => ({ type, span }))).toEqual([
      { type: 'PERSON', span: { start: 0, end: 2 } },
      { type: 'PERSON', span: { start: 3, end: 4 } },
      { type: 'PERSON', span: { start: 4, end: 5 } },
      { type: 'PHONE', span: { start: 5, end: 7 } },
    ]);
    expect(detections[0]?.confidence).toBeCloseTo((1 / (1 + 4 * Math.exp(-2)) + 1 / (1 + 4 * Math.exp(-4))) / 2);
  });

  it('ignores special tokens even when their offsets and predictions are nonzero', () => {
    const { tokenizer } = fakeRuntime();
    const input = tokenizer.prepare(contentInput('김민'));
    input.offsets[0] = [0, 1];
    input.offsets[3] = [1, 2];
    const detections = decodeBio(logitsFor([3, 1, 2, 3]), input, labels, '김민');
    expect(detections).toHaveLength(1);
    expect(detections[0]?.span).toEqual({ start: 0, end: 2 });
  });

  it('returns slice-safe surrogate boundaries and skips zero-length offsets', () => {
    const input = contentInput('😀김');
    input.offsets = [[1, 2], [2, 3]];
    expect(decodeBio(logitsFor([1, 0]), input, labels, '😀김')[0]?.span).toEqual({ start: 0, end: 2 });
    input.offsets[0] = [0, 0];
    expect(decodeBio(logitsFor([1, 0]), input, labels, '😀김')).toEqual([]);
  });

  it('unions B/I source offsets reordered by canonical normalization without merging the next B entity', () => {
    // NFC reorders these combining marks; q does not compose with either mark.
    const text = 'q\u0315\u0300B';
    expect(text.normalize('NFC')).toBe('q\u0300\u0315B');
    const input = contentInput(text);
    input.offsets = [[0, 1], [2, 3], [1, 2], [3, 4]];
    const output = logitsFor([0, 1, 2, 1]);
    output.logits[1 * 5 + 1] = 2;
    const detections = decodeBio(output, input, labels, text);
    expect(detections.map(({ type, span }) => ({ type, span }))).toEqual([
      { type: 'PERSON', span: { start: 1, end: 3 } },
      { type: 'PERSON', span: { start: 3, end: 4 } },
    ]);
    expect(detections.map(({ span }) => text.slice(span.start, span.end))).toEqual(['\u0315\u0300', 'B']);
    expect(detections[0]?.confidence).toBeCloseTo((1 / (1 + 4 * Math.exp(-4)) + 1 / (1 + 4 * Math.exp(-6))) / 2);
  });

  it('rejects malformed shapes, missing labels, and non-finite logits', () => {
    const input = contentInput('a');
    for (const dims of [[1, 2, 5], [2, 1, 5], [1, 1, 0], [1, 5]]) {
      expect(() => decodeBio({ ...logitsFor([1]), dims }, input, labels, 'a')).toThrow();
    }
    const output = logitsFor([1]);
    output.logits[0] = NaN;
    expect(() => decodeBio(output, input, labels, 'a')).toThrow(/Non-finite/);
    expect(() => decodeBio(logitsFor([1]), input, { '0': 'O' }, 'a')).toThrow(/count/);
  });
});
