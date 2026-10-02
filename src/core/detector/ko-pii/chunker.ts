import type { TokenizedInput } from '../types';

// Content tokens only; prepare() adds the model's special tokens afterwards.
export const DEFAULT_CHUNK_SIZE = 512;
export const DEFAULT_OVERLAP = 128;

export interface TokenChunk {
  input: TokenizedInput;
  tokenStart: number;
  tokenEnd: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export function validateTokenizedInput(input: TokenizedInput, text: string): void {
  const count = input.ids.length;
  if (input.attentionMask.length !== count || input.offsets.length !== count ||
      input.specialTokensMask.length !== count) throw new Error('Inconsistent tokenizer array lengths');
  for (let i = 0; i < count; i++) {
    const id = input.ids[i];
    const attention = input.attentionMask[i];
    const special = input.specialTokensMask[i];
    const offset = input.offsets[i];
    if (id === undefined || !Number.isSafeInteger(id) || id < 0 ||
        (attention !== 0 && attention !== 1) || (special !== 0 && special !== 1) ||
        !offset || offset.length !== 2 || !Number.isInteger(offset[0]) || !Number.isInteger(offset[1]) ||
        offset[0] < 0 || offset[1] < offset[0] || offset[1] > text.length) {
      throw new Error('Invalid tokenizer input or offsets');
    }
  }
}

/** Slice tokens, never text: re-encoding substrings can change token IDs and offsets. */
export function chunkTokens(
  input: TokenizedInput,
  chunkSize = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_OVERLAP,
): TokenChunk[] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 ||
      !Number.isSafeInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
    throw new Error('Chunk size must be positive and overlap smaller than chunk size');
  }
  if (input.specialTokensMask.some((value) => value !== 0)) {
    throw new Error('Chunking requires content tokens without special tokens');
  }
  const chunks: TokenChunk[] = [];
  for (let start = 0; start < input.ids.length; start += chunkSize - overlap) {
    const end = Math.min(start + chunkSize, input.ids.length);
    chunks.push({
      tokenStart: start,
      tokenEnd: end,
      hasPrevious: start > 0,
      hasNext: end < input.ids.length,
      input: {
        ids: input.ids.slice(start, end),
        attentionMask: input.attentionMask.slice(start, end),
        offsets: input.offsets.slice(start, end),
        specialTokensMask: input.specialTokensMask.slice(start, end),
      },
    });
    if (end === input.ids.length) break;
  }
  return chunks;
}
