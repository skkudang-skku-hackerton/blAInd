import type { Detection, PiiDetectorStatus, ScanOptions, SegmentDetectionResult, TextSegment } from './types';
export interface PiiDetectorApi {
  initialize(): Promise<void>;
  /** Returns sorted, non-overlapping regions preserving detected coverage. Merged regions retain constituents; adjacent spans stay separate. */
  scanText(text: string, options?: ScanOptions): Promise<Detection[]>;
  /** Each segment has the same coverage-preserving region/constituent contract as scanText. */
  scanSegments(segments: TextSegment[], options?: ScanOptions): Promise<SegmentDetectionResult[]>;
  onStatus?(listener: (status: PiiDetectorStatus) => void): () => void;
}
