import { PII_TYPES } from '../../../core/pii/types';
import { getMaskingPreferences, normalizeMaskingPreferences, DEFAULT_MASKING_PREFERENCES } from '../../../core/pii/preferences';
import type { SegmentDetectionResult, TextSegment } from '../../../core/api/types';
import { expandDetections } from '../../../core/api/detections';
import type { AlertReviewDecision, AlertReviewRequest, SegmentMasks, ReviewItem, Span } from './types';

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
  return { maskingPreferences: getMaskingPreferences(), segments: segments.map(({ id, text }) => {
    const seen = new Set<string>();
    return { id, text, detections: expandDetections(byId.get(id)!.detections).map((detection) => {
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
  const preferences = normalizeMaskingPreferences(request.maskingPreferences ?? DEFAULT_MASKING_PREFERENCES);
  for (const [items, policy, mask] of [
    [decision.autoMask, 'AUTO_MASK', true],
    [decision.confirm.masking, 'CONFIRM', true],
    [decision.confirm.nonMasking, 'CONFIRM', false],
  ] as const) {
    if (!Array.isArray(items)) throw new Error('Invalid review group');
    for (const item of items) {
      const identity = key(item);
      const original = expected.get(identity);
      if (!original || preferences[original.type] !== policy || item.word !== original.word) {
        throw new Error('Unknown, duplicate, or incorrectly grouped review item');
      }
      expected.delete(identity);
      if (mask) selected.set(original.segmentId, [...(selected.get(original.segmentId) ?? []), original.span]);
    }
  }
  if (expected.size) throw new Error('Review omitted detections');
  // nonMasking adds no mask; it cannot veto automatic or explicitly selected
  // protection over shared characters. Do not extend masks into its exclusive
  // coverage. This matches the text processor's selected-span union policy.
  return request.segments.map(({ id }) => ({ segmentId: id, spans: mergeSpans(selected.get(id) ?? []) }));
}
