import { describe, expect, it } from 'vitest';
import { chunkTokens, validateTokenizedInput } from '../../../src/core/detector/ko-pii/chunker';
import { contentInput } from './fakes';

describe('token chunking', () => {
  it('uses 512 content tokens and 128 overlap with absolute UTF-16 offsets', () => {
    const input = contentInput('😀' + '가'.repeat(899));
    const chunks = chunkTokens(input);
    expect(chunks.map((chunk) => [chunk.tokenStart, chunk.tokenEnd])).toEqual([[0, 512], [384, 896], [768, 900]]);
    expect(chunks[1]?.input.ids).toEqual(input.ids.slice(384, 896));
    expect(chunks[1]?.input.offsets[0]).toEqual([385, 386]);
    expect(chunks.map((chunk) => [chunk.hasPrevious, chunk.hasNext])).toEqual([[false, true], [true, true], [true, false]]);
  });

  it('has no redundant final chunk or empty chunk', () => {
    expect(chunkTokens(contentInput('')).length).toBe(0);
    expect(chunkTokens(contentInput('a'.repeat(512))).length).toBe(1);
    expect(chunkTokens(contentInput('a'.repeat(896))).length).toBe(2);
  });

  it('rejects invalid chunk settings and tokenizer arrays', () => {
    for (const [size, overlap] of [[0, 0], [2, 2], [2, -1], [1.5, 0]]) {
      expect(() => chunkTokens(contentInput('abc'), size, overlap)).toThrow();
    }
    const input = contentInput('a');
    input.specialTokensMask[0] = 1;
    expect(() => chunkTokens(input)).toThrow(/without special/);
    input.offsets[0] = [0, 2];
    expect(() => validateTokenizedInput(input, 'a')).toThrow(/offsets/);
  });
});
