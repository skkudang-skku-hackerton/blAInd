import type { Detection, PiiDetectorStatus, ScanOptions, SegmentDetectionResult, TextSegment } from './types';
export interface PiiDetectorApi {
  initialize(): Promise<void>;
  /** Returns detections sorted by start offset, with no overlapping spans. Adjacent spans are allowed. */
  scanText(text: string, options?: ScanOptions): Promise<Detection[]>;
  /** Each segment's detections are sorted by start offset and contain no overlapping spans. */
  scanSegments(segments: TextSegment[], options?: ScanOptions): Promise<SegmentDetectionResult[]>;
  onStatus?(listener: (status: PiiDetectorStatus) => void): () => void;
}
