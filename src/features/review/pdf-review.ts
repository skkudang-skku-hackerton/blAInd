import { analyzeDetections } from '../../alert/policy';
import { mountPrivacyAlert } from '../../alert/PrivacyAlert';
import type { ReviewItem as UiItem } from '../../alert/types';
import type { AlertReviewDecision, AlertReviewRequest, ReviewItem, ReviewPdf } from '../../modules/documents/pdf/types';

/** Flatten only for display. Decisions always carry the original page and offsets. */
export function preparePdfReview(request: AlertReviewRequest) {
  let text = '';
  const detections: AlertReviewRequest['segments'][number]['detections'] = [];
  const originals = new Map<string, ReviewItem>();
  const labels = new Map<number, string>();
  for (const [page, segment] of request.segments.entries()) {
    const offset = text.length;
    text += segment.text + '\n';
    for (const detection of segment.detections) {
      const span = { start: offset + detection.span.start, end: offset + detection.span.end };
      detections.push({ ...detection, span });
      originals.set(JSON.stringify([detection.type, span.start, span.end]), {
        segmentId: segment.id, type: detection.type, span: { ...detection.span }, word: detection.word,
      });
      labels.set(span.start, `${page + 1}페이지`);
    }
  }
  return {
    analysis: analyzeDetections(text, detections, 'pdf-review'),
    labels,
    restore(items: UiItem[]): ReviewItem[] {
      return items.map(item => {
        const original = originals.get(JSON.stringify([item.type, item.span.start, item.span.end]));
        if (!original || original.word !== item.word) throw new Error('Invalid PDF review selection');
        return { ...original, span: { ...original.span } };
      });
    },
  };
}

/** Serialize dialogs across files; abort removes both visible and queued reviews. */
export function createPdfReviewQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  const controllers = new Set<AbortController>();
  const review: ReviewPdf = (request, { signal }) => {
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const result = tail.then(() => new Promise<AlertReviewDecision>((resolve, reject) => {
      if (controller.signal.aborted) { resolve({ status: 'cancelled' }); return; }
      const host = document.createElement('div');
      host.dataset.blaindPdfReview = 'true';
      (document.body ?? document.documentElement).append(host);
      let cleanup: (() => void) | undefined;
      const finish = (decision: AlertReviewDecision) => {
        cleanup?.(); host.remove();
        controller.signal.removeEventListener('abort', cancel);
        resolve(decision);
      };
      const cancel = () => finish({ status: 'cancelled' });
      controller.signal.addEventListener('abort', cancel, { once: true });
      try {
        const prepared = preparePdfReview(request);
        cleanup = mountPrivacyAlert(host, {
          analysis: prepared.analysis,
          itemContext: detection => prepared.labels.get(detection.span.start) ?? '',
          onCancel: cancel,
          onComplete(decision) {
            try {
              finish({ status: 'approved', autoMask: prepared.restore(decision.autoMask), confirm: {
                masking: prepared.restore(decision.confirm.masking), nonMasking: prepared.restore(decision.confirm.nonMasking),
              } });
            } catch (error) { cancel(); }
          },
        });
      } catch (error) { cancel(); reject(error); }
    })).finally(() => {
      signal.removeEventListener('abort', abort);
      controllers.delete(controller);
    });
    tail = result.catch(() => {});
    return result;
  };
  return { review, dispose() { for (const controller of controllers) controller.abort(); } };
}
