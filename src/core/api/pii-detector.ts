import type { Detection, PiiDetectorStatus, ScanOptions, SegmentDetectionResult, TextSegment } from './types';
export interface PiiDetectorApi {
  initialize(): Promise<void>;
  scanText(text: string, options?: ScanOptions): Promise<Detection[]>;
  scanSegments(segments: TextSegment[], options?: ScanOptions): Promise<SegmentDetectionResult[]>;
  onStatus?(listener: (status: PiiDetectorStatus) => void): () => void;
}
