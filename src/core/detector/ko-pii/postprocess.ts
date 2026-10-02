import type { Detection } from '../../api/types';
import type { ModelOutput, TokenizedInput } from '../types';
import { validateLabels } from '../../pii/labels';
import { validateTokenizedInput } from './chunker';

export interface ChunkDetection extends Detection {
  chunkIndex: number;
  truncatedStart: boolean;
  truncatedEnd: boolean;
  /** Internal evidence for averaging entities joined across chunk boundaries. */
  tokenConfidences?: { tokenIndex: number; confidence: number }[];
}

export interface DecodeContext {
  chunkIndex: number;
  hasPrevious: boolean;
  hasNext: boolean;
  tokenStart?: number;
}

function safeBoundary(text: string, offset: number, end: boolean): number {
  // Byte-level tokenizers may assign two tokens to the same Unicode character.
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  if (offset > 0 && offset < text.length &&
      previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
    return offset + (end ? 1 : -1);
  }
  return offset;
}

export function decodeBio(
  output: ModelOutput,
  input: TokenizedInput,
  labels: Readonly<Record<string, string>>,
  text: string,
  context: DecodeContext = { chunkIndex: 0, hasPrevious: false, hasNext: false },
): ChunkDetection[] {
  validateTokenizedInput(input, text);
  const [batch, tokens, classes] = output.dims;
  if (output.dims.length !== 3 || batch !== 1 || tokens !== input.ids.length ||
      classes === undefined || !Number.isSafeInteger(classes) || classes < 1 ||
      output.logits.length !== tokens * classes) {
    throw new Error('Invalid token-classification logit dimensions');
  }
  const parsed = validateLabels(labels, classes);
  const content = input.offsets.flatMap(([start, end], i) =>
    !input.specialTokensMask[i] && input.attentionMask[i] && end > start ? [i] : []);
  const first = content[0];
  const last = content[content.length - 1];
  const results: ChunkDetection[] = [];
  let active: ChunkDetection | undefined;
  let sum = 0;
  let count = 0;
  let contentIndex = -1;
  const flush = () => {
    if (active) {
      active.confidence = sum / count;
      results.push(active);
    }
    active = undefined;
    sum = 0;
    count = 0;
  };

  for (const [i, [rawStart, rawEnd]] of input.offsets.entries()) {
    if (!input.specialTokensMask[i]) contentIndex++;
    const row = output.logits.subarray(i * classes, (i + 1) * classes);
    let best = 0;
    let max = -Infinity;
    for (const [c, value] of row.entries()) {
      if (!Number.isFinite(value)) throw new Error('Non-finite model logits');
      if (value > max) { max = value; best = c; }
    }
    let denominator = 0;
    for (const value of row) denominator += Math.exp(value - max);
    const confidence = 1 / denominator;
    if (input.specialTokensMask[i] || !input.attentionMask[i] || rawStart === rawEnd) {
      // Special/padding tokens never create entities, even with nonzero offsets.
      flush();
      continue;
    }
    const label = parsed[best];
    if (!label) throw new Error('Missing predicted BIO label');
    if (label.prefix === 'O') { flush(); continue; }
    const start = safeBoundary(text, rawStart, false);
    const end = safeBoundary(text, rawEnd, true);
    if (label.prefix === 'B' || !active || active.type !== label.type) {
      flush();
      active = {
        type: label.type, confidence: 0, span: { start, end },
        chunkIndex: context.chunkIndex,
        truncatedStart: context.hasPrevious && i === first,
        truncatedEnd: false,
        tokenConfidences: [],
      };
    } else {
      // Canonical normalization can reorder combining marks in the source.
      active.span.start = Math.min(active.span.start, start);
      active.span.end = Math.max(active.span.end, end);
    }
    active.truncatedEnd = context.hasNext && i === last;
    active.tokenConfidences!.push({ tokenIndex: (context.tokenStart ?? 0) + contentIndex, confidence });
    sum += confidence;
    count++;
  }
  flush();
  return results;
}
