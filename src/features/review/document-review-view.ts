import { analyzeDetections, mountPrivacyAlert, type ReviewResult } from '../../alert';
import type { AlertReviewDecision, AlertReviewRequest } from '../../modules/documents/shared/types';
import { normalizeMaskingPreferences } from '../../core/pii/preferences';

function documentLocationLabel(segmentId: string): string {
  const match = /^docx:word\/(document|header(\d+)|footer(\d+)|footnotes|endnotes)\.xml:p(\d+)$/.exec(segmentId);
  if (!match) return segmentId;
  const [, part, header, footer, paragraph] = match;
  const section = part === 'document' ? '본문'
    : header ? `머리글 ${header}`
    : footer ? `바닥글 ${footer}`
    : part === 'footnotes' ? '각주' : '미주';
  return `${section} · ${Number(paragraph) + 1}번째 문단`;
}

/** Render inside the extension page; translate combined UI spans back to segments. */
export function mountDocumentReview(
  container: HTMLElement, request: AlertReviewRequest, onDecision: (result: AlertReviewDecision) => void,
): () => void {
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
  const finish = (result: ReviewResult) => {
    if (result.status === 'cancelled') { onDecision(result); return; }
    const restore = (items: typeof result.autoMask) => items.map(item => {
      const origin = origins.get(JSON.stringify([item.type, item.span.start, item.span.end]))!;
      return { ...item, type: item.type as import('../../core/api/types').PiiType,
        segmentId: origin.segmentId,
        span: { start: item.span.start - origin.offset, end: item.span.end - origin.offset } };
    });
    onDecision({ status: 'approved', autoMask: restore(result.autoMask),
      confirm: { masking: restore(result.confirm.masking), nonMasking: restore(result.confirm.nonMasking) } });
  };
  return mountPrivacyAlert(container, {
    analysis: analyzeDetections(text, detections, 'document', normalizeMaskingPreferences(request.maskingPreferences)),
    itemContext: d => documentLocationLabel(
      origins.get(JSON.stringify([d.type, d.span.start, d.span.end]))?.segmentId ?? '',
    ),
    onComplete: finish, onCancel: () => finish({ status: 'cancelled' }),
  });
}
