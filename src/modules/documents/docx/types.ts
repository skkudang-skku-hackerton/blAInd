import type { PiiDetectorApi } from '../../../core/api/pii-detector';
import type { TextSegment } from '../../../core/api/types';
import type { ReviewDocument, SegmentMasks } from '../shared/types';

export type {
  AlertReviewRequest, AlertReviewDecision, ReviewItem, ReviewDocument, Span, SegmentMasks,
} from '../shared/types';

export type ReviewDocx = ReviewDocument;

export interface DocxLimits {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxEntries: number;
  maxUncompressedBytes: number;
  maxParagraphs: number;
  maxCharacters: number;
}
export const DEFAULT_LIMITS: Readonly<DocxLimits> = {
  maxInputBytes: 25 * 1024 * 1024,
  maxOutputBytes: 50 * 1024 * 1024,
  maxEntries: 2048,
  maxUncompressedBytes: 100 * 1024 * 1024,
  maxParagraphs: 10_000,
  maxCharacters: 1_000_000,
};

export interface DocxSession {
  segments: TextSegment[];
  rebuild(masks: SegmentMasks[], signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
  close(): void;
}
export type OpenDocx = (
  bytes: ArrayBuffer,
  limits: DocxLimits,
  signal: AbortSignal,
) => Promise<DocxSession>;
export type DocxStage = 'extracting' | 'scanning' | 'reviewing' | 'rebuilding';
export interface DocxProcessorOptions {
  detector: PiiDetectorApi;
  review: ReviewDocx;
  openDocx?: OpenDocx;
  limits?: Partial<DocxLimits>;
  onStage?: (stage: DocxStage, file: File) => void;
  onError?: (error: unknown, file: File) => void;
}
