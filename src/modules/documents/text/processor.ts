import { abortable } from '../shared/abortable';
import { readFileBytes } from '../shared/read-file';
import { createReviewRequest, resolveReview } from '../shared/review';
import type { TextSegment } from '../../../core/api/types';
import { DEFAULT_LIMITS, type TextDocumentProcessorOptions } from './types';

const OUTPUT_TYPES: Readonly<Record<string, string>> = {
  txt: 'text/plain;charset=utf-8',
  md: 'text/markdown;charset=utf-8',
  markdown: 'text/markdown;charset=utf-8',
};

function extension(file: File): string {
  return file.name.split('.').pop()?.toLowerCase() ?? '';
}

/** Apply validated UTF-16 source ranges from right to left so earlier offsets stay stable. */
export function replaceSpans(text: string, spans: readonly { start: number; end: number }[]): string {
  let output = text;
  for (const { start, end } of [...spans].sort((a, b) => b.start - a.start)) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) {
      throw new Error('Invalid text mask span');
    }
    output = output.slice(0, start) + '█'.repeat(end - start) + output.slice(end);
  }
  return output;
}

/** Plain UTF-8 and Markdown processor. Markdown syntax is preserved as source text. */
export function createTextDocumentProcessor(options: TextDocumentProcessorOptions) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid text document limits');
  }

  return async function processTextDocument(file: File, signal: AbortSignal): Promise<File | null> {
    try {
      signal.throwIfAborted();
      if (!file.size || file.size > limits.maxInputBytes) throw new Error('Text file input size limit exceeded');
      const ext = extension(file);
      if (!Object.hasOwn(OUTPUT_TYPES, ext)) throw new Error('Unsupported text document extension');

      options.onStage?.('extracting', file);
      const bytes = new Uint8Array(await readFileBytes(file, signal));
      signal.throwIfAborted();
      let hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      const source = new TextDecoder('utf-8', { fatal: true }).decode(hasBom ? bytes.subarray(3) : bytes);
      if (source.includes('\0')) throw new Error('Binary content is not a supported text file');
      if (source.length > limits.maxCharacters) throw new Error('Text file character limit exceeded');

      const segment: TextSegment = { id: 'text', text: source };
      options.onStage?.('scanning', file);
      await abortable(options.detector.initialize(), signal);
      signal.throwIfAborted();
      const detections = await abortable(options.detector.scanSegments([{ ...segment }], { signal }), signal);
      signal.throwIfAborted();
      const request = createReviewRequest([{ ...segment }], detections);

      options.onStage?.('reviewing', file);
      const decision = await abortable(options.review(structuredClone(request), { signal }), signal);
      signal.throwIfAborted();
      const masks = resolveReview(request, decision);
      if (masks === null) return null;

      options.onStage?.('rebuilding', file);
      const text = replaceSpans(source, masks.find(({ segmentId }) => segmentId === 'text')?.spans ?? []);
      const output = new TextEncoder().encode(`${hasBom ? '\uFEFF' : ''}${text}`);
      signal.throwIfAborted();
      if (output.byteLength > limits.maxOutputBytes) throw new Error('Text file output size limit exceeded');
      // Keep only the recognized source suffix, never an attacker-controlled path/name.
      return new File([output], `masked-document.${ext}`, { type: OUTPUT_TYPES[ext] });
    } catch (error) {
      const cancelled = signal.aborted || (error as { code?: string } | null)?.code === 'CANCELLED';
      if (!cancelled) options.onError?.(error, file);
      return null;
    }
  };
}
