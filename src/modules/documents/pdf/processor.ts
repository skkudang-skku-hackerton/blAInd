import { createReviewRequest, resolveReview } from './review';
import { openPdfInWorker } from './worker-client';
import { DEFAULT_LIMITS, type PdfProcessorOptions, type PdfSession } from './types';

/** Cancels the wait even if an injected review implementation ignores its signal. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new DOMException('PDF processing cancelled', 'AbortError'));
    };
    if (signal.aborted) { promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createPdfProcessor(options: PdfProcessorOptions) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const value of Object.values(limits)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid PDF limits');
  }
  return async function processPdf(file: File, signal: AbortSignal): Promise<File | null> {
    let session: PdfSession | undefined;
    try {
      signal.throwIfAborted();
      if (!file.size || file.size > limits.maxInputBytes) throw new Error('PDF input size limit exceeded');
      options.onStage?.('extracting', file);
      const bytes = await abortable(file.arrayBuffer(), signal);
      signal.throwIfAborted();
      session = await (options.openPdf ?? openPdfInWorker)(bytes, limits, signal);
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
      if (output.byteLength > limits.maxOutputBytes) throw new Error('PDF output size limit exceeded');
      // Do not carry a potentially sensitive source filename into the upload metadata.
      return new File([output], 'masked-document.pdf', { type: 'application/pdf' });
    } catch (error) {
      const cancelled = signal.aborted || (error as { code?: string } | null)?.code === 'CANCELLED';
      if (!cancelled) options.onError?.(error, file);
      return null;
    } finally {
      session?.close();
    }
  };
}
