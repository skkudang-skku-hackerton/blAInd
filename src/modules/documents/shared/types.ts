import type { Detection, PiiType, TextSegment } from '../../../core/api/types';

/** Exact payload defined by docs/alert-review-api.md. */
export interface AlertReviewRequest {
  segments: Array<TextSegment & { detections: Array<Detection & { word: string }> }>;
}
export interface ReviewItem {
  segmentId: string;
  type: PiiType;
  span: { start: number; end: number };
  word: string;
}
export type AlertReviewDecision =
  | { status: 'cancelled' }
  | {
      status: 'approved';
      autoMask: ReviewItem[];
      confirm: { masking: ReviewItem[]; nonMasking: ReviewItem[] };
    };

/** Signal is local call context, never a field in the Alert data payload. */
export type ReviewDocument = (
  request: AlertReviewRequest,
  options: { signal: AbortSignal },
) => Promise<AlertReviewDecision>;

export interface Span { start: number; end: number }
export interface SegmentMasks { segmentId: string; spans: Span[] }
