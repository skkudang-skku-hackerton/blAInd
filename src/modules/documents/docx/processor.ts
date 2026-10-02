import { abortable } from '../shared/abortable';
import { readFileBytes } from '../shared/read-file';
import { createReviewRequest, resolveReview } from '../shared/review';
import { openDocxInWorker } from './worker-client';
import { DEFAULT_LIMITS, type DocxProcessorOptions, type DocxSession } from './types';

export function createDocxProcessor(options: DocxProcessorOptions) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const value of Object.values(limits)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid DOCX limits');
  }
  return async function processDocx(file: File, signal: AbortSignal): Promise<File | null> {
    let session: DocxSession | undefined;
    try {
      signal.throwIfAborted();
      if (!file.size || file.size > limits.maxInputBytes) throw new Error('DOCX input size limit exceeded');
      options.onStage?.('extracting', file);
      const bytes = await readFileBytes(file, signal);
      signal.throwIfAborted();
      session = await (options.openDocx ?? openDocxInWorker)(bytes, limits, signal);
      signal.throwIfAborted();
      options.onStage?.('scanning', file);
      await abortable(options.detector.initialize(), signal);
      signal.throwIfAborted();
      const segments = session.segments.map((segment) => ({ ...segment }));
      const results = await abortable(options.detector.scanSegments(
        segments.map((segment) => ({ ...segment })), { signal },
      ), signal);
      signal.throwIfAborted();
      const snapshot = createReviewRequest(segments, results);
      options.onStage?.('reviewing', file);
      const decision = await abortable(options.review(structuredClone(snapshot), { signal }), signal);
      signal.throwIfAborted();
      const masks = resolveReview(snapshot, decision);
      if (masks === null) return null;
      options.onStage?.('rebuilding', file);
      const output = await session.rebuild(masks, signal);
      signal.throwIfAborted();
      if (output.byteLength > limits.maxOutputBytes) throw new Error('DOCX output size limit exceeded');
      // Do not carry a potentially sensitive source filename into the upload metadata.
      return new File([output], 'masked-document.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
    } catch (error) {
      const cancelled = signal.aborted || (error as { code?: string } | null)?.code === 'CANCELLED';
      if (!cancelled) options.onError?.(error, file);
      return null;
    } finally {
      session?.close();
    }
  };
}
