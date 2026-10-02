export type { PiiDetectorApi } from './pii-detector';
export type {
  Detection, DetectionConstituent, PiiDetectorError, PiiDetectorStatus, PiiErrorCode, PiiType,
  ScanOptions, SegmentDetectionResult, TextSegment,
} from './types';
export { PiiError } from './errors';
export { expandDetections } from './detections';
export { createPiiDetectorClient } from '../../shared/messaging/pii-client';
export type { PiiDetectorClient, PiiDetectorClientOptions } from '../../shared/messaging/pii-client';
