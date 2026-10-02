import type { PiiDetectorApi } from '../../../core/api/pii-detector';
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
export type ReviewPdf = (
  request: AlertReviewRequest,
  options: { signal: AbortSignal },
) => Promise<AlertReviewDecision>;

export interface Span { start: number; end: number }
export interface PageMasks { segmentId: string; spans: Span[] }
export interface PdfLimits {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxPages: number;
  maxCharacters: number;
  maxPixelsPerPage: number;
  scale: number;
}
export const DEFAULT_LIMITS: Readonly<PdfLimits> = {
  maxInputBytes: 25 * 1024 * 1024,
  maxOutputBytes: 50 * 1024 * 1024,
  maxPages: 100,
  maxCharacters: 1_000_000,
  maxPixelsPerPage: 16_000_000,
  scale: 2,
};

export interface PdfSession {
  segments: TextSegment[];
  rebuild(masks: PageMasks[], signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
  close(): void;
}
export type OpenPdf = (
  bytes: ArrayBuffer,
  limits: PdfLimits,
  signal: AbortSignal,
) => Promise<PdfSession>;
export type PdfStage = 'extracting' | 'scanning' | 'reviewing' | 'rebuilding';
export interface PdfProcessorOptions {
  detector: PiiDetectorApi;
  review: ReviewPdf;
  openPdf?: OpenPdf;
  limits?: Partial<PdfLimits>;
  onStage?: (stage: PdfStage, file: File) => void;
  onError?: (error: unknown, file: File) => void;
}
