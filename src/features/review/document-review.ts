import { analyzeDetections, mountPrivacyAlert, type ReviewResult } from '../../alert';
import type { AlertReviewDecision, ReviewDocument } from '../../modules/documents/shared/types';

/** One dialog for every page/paragraph; return original segment coordinates to
 * the processor rather than the combined UI coordinates. Queue concurrent files. */
export function createDocumentReview(): ReviewDocument {
  let queue: Promise<unknown> = Promise.resolve();
  return (request, { signal }) => {
    const run = () => new Promise<AlertReviewDecision>(resolve => {
      if (signal.aborted) { resolve({ status: 'cancelled' }); return; }
      let text = '';
      const origins = new Map<string, { segmentId: string; offset: number }>();
      const detections = request.segments.flatMap(segment => {
        const offset = text.length;
        text += segment.text + '\n';
        return segment.detections.map(d => {
          const span = { start: d.span.start + offset, end: d.span.end + offset };
          origins.set(JSON.stringify([d.type, span.start, span.end]), { segmentId: segment.id, offset });
          return { ...d, span };
        });
      });
      const host = document.createElement('div');
      host.id = 'blaind-document-review';
      host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647';
      const container = document.createElement('div');
      host.attachShadow({ mode: 'open' }).append(container);
      (document.body ?? document.documentElement).append(host);
      let cleanup: (() => void) | undefined;
      let settled = false;
      const finish = (result: ReviewResult) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        cleanup?.();
        host.remove();
        if (result.status === 'cancelled') { resolve(result); return; }
        const restore = (items: typeof result.autoMask) => items.map(item => {
          const origin = origins.get(JSON.stringify([item.type, item.span.start, item.span.end]))!;
          return { ...item, type: item.type as import('../../core/api/types').PiiType,
            segmentId: origin.segmentId,
            span: { start: item.span.start - origin.offset, end: item.span.end - origin.offset } };
        });
        resolve({ status: 'approved', autoMask: restore(result.autoMask),
          confirm: { masking: restore(result.confirm.masking), nonMasking: restore(result.confirm.nonMasking) } });
      };
      const cancel = () => finish({ status: 'cancelled' });
      signal.addEventListener('abort', cancel, { once: true });
      cleanup = mountPrivacyAlert(container, {
        analysis: analyzeDetections(text, detections, 'document'),
        itemContext: d => origins.get(JSON.stringify([d.type, d.span.start, d.span.end]))?.segmentId ?? '',
        onComplete: finish, onCancel: cancel,
      });
    });
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  };
}
