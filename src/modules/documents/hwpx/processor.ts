import { abortable } from '../shared/abortable';
import { createReviewRequest, resolveReview } from '../shared/review';
import { openHwpxInWorker } from './worker-client';
import { DEFAULT_LIMITS, type HwpxProcessorOptions, type HwpxSession } from './types';

export function createHwpxProcessor(options: HwpxProcessorOptions) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const value of Object.values(limits)) if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid HWPX limits');
  return async function processHwpx(file: File, signal: AbortSignal): Promise<File | null> {
    let session: HwpxSession | undefined;
    try {
      signal.throwIfAborted();
      if (!file.size || file.size > limits.maxInputBytes) throw new Error('HWPX input size limit exceeded');
      options.onStage?.('extracting', file);
      const bytes = await abortable(file.arrayBuffer(), signal);
      session = await (options.openHwpx ?? openHwpxInWorker)(bytes, limits, signal);
      signal.throwIfAborted();
      options.onStage?.('scanning', file);
      await abortable(options.detector.initialize(), signal);
      const segments = session.segments.map((segment) => ({ ...segment }));
      const results = await abortable(options.detector.scanSegments(segments.map((segment) => ({ ...segment })), { signal }), signal);
      const snapshot = createReviewRequest(segments, results);
      options.onStage?.('reviewing', file);
      const decision = await abortable(options.review(structuredClone(snapshot), { signal }), signal);
      signal.throwIfAborted();
      const masks = resolveReview(snapshot, decision);
      if (masks === null) return null;
      options.onStage?.('rebuilding', file);
      const output = await session.rebuild(masks, signal);
      signal.throwIfAborted();
      return new File([output], 'masked-document.hwpx', { type: 'application/hwp+zip' });
    } catch (error) {
      const cancelled = signal.aborted || (error as { code?: string } | null)?.code === 'CANCELLED';
      if (!cancelled) options.onError?.(error, file);
      return null;
    } finally { session?.close(); }
  };
}
