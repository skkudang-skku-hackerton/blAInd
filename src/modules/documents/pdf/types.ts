import type { PiiDetectorApi } from '../../../core/api/pii-detector';
import type { TextSegment } from '../../../core/api/types';
import type { ReviewDocument, SegmentMasks } from '../shared/types';

export type { AlertReviewRequest, AlertReviewDecision, ReviewItem, Span } from '../shared/types';
export type ReviewPdf = ReviewDocument;
export type PageMasks = SegmentMasks;
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
