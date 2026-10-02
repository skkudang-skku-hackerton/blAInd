import { PII_TYPES } from '../../../core/pii/types';
import type { SegmentDetectionResult, TextSegment } from '../../../core/api/types';
import type { AlertReviewDecision, AlertReviewRequest, SegmentMasks, ReviewItem, Span } from './types';

const AUTO = new Set([
  'RRN', 'FRN', 'CARD_NUMBER', 'ACCOUNT_NUMBER', 'SECRET', 'PASSPORT',
  'DRIVER_LICENSE', 'CVC', 'IPIN', 'PHONE', 'EMAIL',
]);
const CONFIRM = new Set(['USER_ID', 'PERSON', 'ADDRESS', 'ZIPCODE', 'DATE', 'GENERIC_ID', 'CARD_EXPIRY']);
const key = (item: Pick<ReviewItem, 'segmentId' | 'type' | 'span'>): string =>
  JSON.stringify([item.segmentId, item.type, item.span.start, item.span.end]);

function checkSpan(text: string, span: Span): void {
  if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end) ||
      span.start < 0 || span.end <= span.start || span.end > text.length) {
    throw new Error('Invalid detection span');
  }
  // A UTF-16 span must not cut a surrogate pair in half.
  for (const offset of [span.start, span.end]) {
    if (offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text.charAt(offset - 1)) &&
        /[\uDC00-\uDFFF]/.test(text.charAt(offset))) throw new Error('Split Unicode character');
  }
}

export function createReviewRequest(
  segments: TextSegment[], results: SegmentDetectionResult[],
): AlertReviewRequest {
  const ids = new Set(segments.map((segment) => segment.id));
  if (ids.size !== segments.length || results.length !== segments.length) throw new Error('Invalid segment results');
  const byId = new Map<string, SegmentDetectionResult>();
  for (const result of results) {
    if (!ids.has(result.segmentId) || byId.has(result.segmentId)) throw new Error('Unknown or duplicate segment');
    byId.set(result.segmentId, result);
  }
  return { segments: segments.map(({ id, text }) => {
    const seen = new Set<string>();
    return { id, text, detections: byId.get(id)!.detections.map((detection) => {
      checkSpan(text, detection.span);
      if (!PII_TYPES.includes(detection.type) || !Number.isFinite(detection.confidence) ||
          detection.confidence < 0 || detection.confidence > 1) throw new Error('Invalid detection');
      const identity = key({ segmentId: id, ...detection });
      if (seen.has(identity)) throw new Error('Duplicate detection');
      seen.add(identity);
      return { type: detection.type, confidence: detection.confidence,
        span: { ...detection.span }, word: text.slice(detection.span.start, detection.span.end) };
    }) };
  }) };
}

export function mergeSpans(spans: Span[]): Span[] {
  const merged: Span[] = [];
  for (const span of spans.map((s) => ({ ...s })).sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push(span);
  }
  return merged;
}

/** Validates all three groups against the saved detector snapshot, never UI coordinates alone. */
export function resolveReview(request: AlertReviewRequest, decision: AlertReviewDecision): SegmentMasks[] | null {
  if (decision.status === 'cancelled') return null;
  if (decision.status !== 'approved') throw new Error('Invalid review status');
  const expected = new Map<string, ReviewItem>();
  for (const segment of request.segments) for (const detection of segment.detections) {
    const item = { segmentId: segment.id, type: detection.type, span: detection.span, word: detection.word };
    expected.set(key(item), item);
  }
  const selected = new Map<string, Span[]>();
  for (const [items, policy, mask] of [
    [decision.autoMask, AUTO, true],
    [decision.confirm.masking, CONFIRM, true],
    [decision.confirm.nonMasking, CONFIRM, false],
  ] as const) {
    if (!Array.isArray(items)) throw new Error('Invalid review group');
    for (const item of items) {
      const identity = key(item);
      const original = expected.get(identity);
      if (!original || !policy.has(original.type) || item.word !== original.word) {
        throw new Error('Unknown, duplicate, or incorrectly grouped review item');
      }
      expected.delete(identity);
      if (mask) selected.set(original.segmentId, [...(selected.get(original.segmentId) ?? []), original.span]);
    }
  }
  if (expected.size) throw new Error('Review omitted detections');
  const masks = request.segments.map(({ id }) => ({ segmentId: id, spans: mergeSpans(selected.get(id) ?? []) }));
  // The current Alert contract promises nonMasking stays unchanged. Reject contradictory
  // overlap rather than silently introducing an undocumented masking-priority policy.
  for (const item of decision.confirm.nonMasking) {
    if (masks.find((m) => m.segmentId === item.segmentId)!.spans.some(
      (span) => span.start < item.span.end && item.span.start < span.end,
    )) throw new Error('Masking overlaps an explicitly retained detection');
  }
  return masks;
}
