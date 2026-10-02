import type { PiiDetectorApi } from '../../../core/api/pii-detector';
import type { TextSegment } from '../../../core/api/types';
import type { ReviewDocument, SegmentMasks } from '../shared/types';

export type {
  AlertReviewRequest, AlertReviewDecision, ReviewItem, ReviewDocument, Span, SegmentMasks,
} from '../shared/types';

export interface HwpxLimits {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxEntries: number;
  maxUncompressedBytes: number;
  maxParagraphs: number;
  maxCharacters: number;
}
export const DEFAULT_LIMITS: Readonly<HwpxLimits> = {
  maxInputBytes: 25 * 1024 * 1024,
  maxOutputBytes: 50 * 1024 * 1024,
  maxEntries: 2048,
  maxUncompressedBytes: 100 * 1024 * 1024,
  maxParagraphs: 10_000,
  maxCharacters: 1_000_000,
};

export interface HwpxSession {
  segments: TextSegment[];
  rebuild(masks: SegmentMasks[], signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
  close(): void;
}
export type OpenHwpx = (bytes: ArrayBuffer, limits: HwpxLimits, signal: AbortSignal) => Promise<HwpxSession>;
export type HwpxStage = 'extracting' | 'scanning' | 'reviewing' | 'rebuilding';
export interface HwpxProcessorOptions {
  detector: PiiDetectorApi;
  review: ReviewDocument;
  openHwpx?: OpenHwpx;
  limits?: Partial<HwpxLimits>;
  onStage?: (stage: HwpxStage, file: File) => void;
  onError?: (error: unknown, file: File) => void;
}
