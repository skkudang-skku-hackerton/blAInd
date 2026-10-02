import { describe, expect, it } from 'vitest';
import { KoPiiTokenizer } from '../../../src/core/detector/ko-pii/tokenizer';
import { auditTokenizerFixture, tokenizerConfigFixture, tokenizerFixture } from './fixture';

const tokenizer = () => new KoPiiTokenizer(tokenizerFixture, tokenizerConfigFixture);
describe('pinned NFC WordPiece source mapping', () => {
  it('uses actual model sequence wrapper IDs and original Korean spans after emoji', () => {
    const text = '😀 김민수 한국어';
    const input = tokenizer().encode(text);
    expect(input.ids).toEqual([0, 19754, 13483, 20369, 20311, 18383, 20298, 20382, 1]);
    expect(input.offsets).toEqual([[0, 0], [0, 2], [3, 4], [4, 5], [5, 6], [7, 8], [8, 9], [9, 10], [0, 0]]);
    expect(input.offsets.slice(1, -1).map(([s, e]) => text.slice(s, e))).toEqual(['😀', '김', '민', '수', '한', '국', '어']);
  });
  it('maps NFC composition to decomposed original accents and Korean Jamo', () => {
    const text = 'e\u0301 가 각';
    const input = tokenizer().encode(text, false);
    expect(input.ids).toEqual([202, 13161, 13162]);
    expect(input.offsets).toEqual([[0, 2], [3, 5], [6, 9]]);
    expect(input.offsets.map(([s, e]) => text.slice(s, e))).toEqual(['e\u0301', '가', '각']);
  });
  it('maps unknown tokens to their entire original word, including surrogate pairs', () => {
    const text = '🛸unknown 김민🛸';
    const input = tokenizer().encode(text, false);
    expect(input.ids).toEqual([2, 2]);
    expect(input.offsets).toEqual([[0, 9], [10, 14]]);
    expect(input.offsets.map(([s, e]) => text.slice(s, e))).toEqual(['🛸unknown', '김민🛸']);
  });
  it('preserves input special-token literals and whitespace positions', () => {
    const text = ' \t<cls>김민수\r\n<s>é';
    const input = tokenizer().encode(text, false);
    expect(input.ids).toEqual([5, 13483, 20369, 20311, 0, 202]);
    expect(input.offsets.map(([s, e]) => text.slice(s, e))).toEqual(['<cls>', '김', '민', '수', '<s>', 'é']);
    expect(input.specialTokensMask).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it('wraps chunk slices without rebasing offsets or mutating them', () => {
    const instance = tokenizer();
    const all = instance.encode('😀 김민수', false);
    const slice = { ids: all.ids.slice(2), offsets: all.offsets.slice(2), attentionMask: all.attentionMask.slice(2), specialTokensMask: all.specialTokensMask.slice(2) };
    expect(instance.prepare(slice)).toEqual({ ids: [0, 20369, 20311, 1], offsets: [[0, 0], [4, 5], [5, 6], [0, 0]], attentionMask: [1, 1, 1, 1], specialTokensMask: [1, 0, 0, 1] });
    expect(slice.offsets).toEqual([[4, 5], [5, 6]]);
    expect(() => instance.prepare(instance.encode('김'))).toThrow();
  });
  it('handles empty text, BERT punctuation and repeated substrings deterministically', () => {
    expect(tokenizer().encode('  \n').ids).toEqual([0, 1]);
    const text = '김민수.김민수@010-1';
    const input = tokenizer().encode(text, false);
    expect(input.ids).toEqual([13483, 20369, 20311, 50, 13483, 20369, 20311, 68, 37779, 49, 53]);
    expect(input.offsets.map(([s, e]) => text.slice(s, e)).join('')).toBe(text);
  });
  it('handles a long unknown word without overflowing the JS argument stack', () => {
    const text = 'a'.repeat(150_000);
    expect(tokenizer().encode(text, false)).toEqual({ ids: [2], offsets: [[0, text.length]], attentionMask: [1], specialTokensMask: [0] });
  });
});

describe('full pinned vocabulary audit snapshots', () => {
  const tokenizer = () => new KoPiiTokenizer(auditTokenizerFixture, tokenizerConfigFixture);
  it('matches full-vocabulary Korean and phone IDs and source positions', () => {
    const text = '😀 김민수의 전화번호는 010-1234-5678입니다.';
    const input = tokenizer().encode(text, false);
    expect(input.ids).toEqual([19754, 34455, 20311, 20528, 31693, 21157, 20364, 20430, 37779, 49, 38683, 20320, 49, 33924, 43614, 35634, 50]);
    expect(input.offsets).toEqual([[0, 2], [3, 5], [5, 6], [6, 7], [8, 10], [10, 11], [11, 12], [12, 13], [14, 17], [17, 18], [18, 21], [21, 22], [22, 23], [23, 25], [25, 27], [27, 30], [30, 31]]);
  });
  it('preserves provenance during canonical reorder and one-to-many decomposition', () => {
    const text = 'a\u0327\u0301 á\u0327 a\u0301\u0327 \u0344';
    const input = tokenizer().encode(text, false);
    expect(input.ids).toEqual([194, 23934, 194, 23934, 194, 23934, 498, 23761]);
    // The á token in the first word needs both a and acute, so its smallest
    // source interval includes intervening cedilla. Do not force monotonicity.
    expect(input.offsets).toEqual([[0, 3], [1, 2], [4, 5], [5, 6], [7, 9], [9, 10], [11, 12], [11, 12]]);
    expect(input.offsets.map(([s, e]) => text.slice(s, e))).toEqual(['á̧', '̧', 'á', '̧', 'á', '̧', '̈́', '̈́']);
  });
  it('splits emoji graphemes without splitting surrogate pairs or extending individual tokens', () => {
    const text = '😀️ 🇰🇷 👍🏽';
    const input = tokenizer().encode(text, false);
    expect(input.ids).toEqual([19754, 23797, 19234, 25369, 19536, 27244]);
    expect(input.offsets).toEqual([[0, 2], [2, 3], [4, 6], [6, 8], [9, 11], [11, 13]]);
    expect(input.offsets.map(([s, e]) => text.slice(s, e))).toEqual(['😀', '️', '🇰', '🇷', '👍', '🏽']);
  });
  it('retains non-monotonic source positions when leading combining marks reorder', () => {
    const text = '\u0301\u0327';
    const input = tokenizer().encode(text, false);
    expect(input.ids).toEqual([523, 23761]);
    expect(input.offsets).toEqual([[1, 2], [0, 1]]);
    expect(input.offsets.map(([s, e]) => text.slice(s, e))).toEqual(['̧', '́']);
  });
  it('retains real IDs and positions of adjacent literal added tokens', () => {
    const text = '<mask><cls><s><\\s><sep><unk><pad>김민수<mask><cls>';
    const input = tokenizer().encode(text, false);
    expect(input.ids).toEqual([4, 5, 0, 1, 3, 2, 49999, 34455, 20311, 4, 5]);
    expect(input.offsets).toEqual([[0, 6], [6, 11], [11, 14], [14, 18], [18, 23], [23, 28], [28, 33], [33, 35], [35, 36], [36, 42], [42, 47]]);
    expect(input.specialTokensMask).toEqual(Array(11).fill(0));
  });
  it('maps real multi-syllable subwords to full original decomposed Jamo ranges', () => {
    const text = '각 한글 김민수';
    const input = tokenizer().encode(text, false);
    expect(input.ids).toEqual([13162, 35220, 34455, 20311]);
    expect(input.offsets).toEqual([[0, 3], [4, 10], [11, 17], [17, 19]]);
  });
});
