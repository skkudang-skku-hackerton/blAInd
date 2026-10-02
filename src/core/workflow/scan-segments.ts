import type { PiiDetectorApi } from '../api/pii-detector';
import type { ScanOptions, SegmentDetectionResult, TextSegment } from '../api/types';

/** Document modules supply logical segments; model chunking stays in the detector. */
export function scanSegments(
  detector: PiiDetectorApi,
  segments: TextSegment[],
  options?: ScanOptions,
): Promise<SegmentDetectionResult[]> {
  return detector.scanSegments(segments, options);
}
