import type { PiiType } from '../pii/types';
export type { PiiType } from '../pii/types';

export interface TextSegment { id: string; text: string }
export interface ScanOptions { signal?: AbortSignal }
export interface Detection {
  type: PiiType;
  confidence: number;
  /** Half-open UTF-16 offsets into the exact input string. */
  span: { start: number; end: number };
}
export interface SegmentDetectionResult { segmentId: string; detections: Detection[] }
export type PiiErrorCode = 'MODEL_NOT_READY' | 'MODEL_DOWNLOAD_FAILED' |
  'MODEL_LOAD_FAILED' | 'INFERENCE_FAILED' | 'OUT_OF_MEMORY' | 'INVALID_INPUT' | 'CANCELLED';
export interface PiiDetectorError { code: PiiErrorCode; message: string; cause?: unknown }
export type PiiDetectorStatus =
  | { state: 'idle' }
  | { state: 'downloading'; progress: number }
  | { state: 'loading' }
  | { state: 'ready'; backend: 'webgpu' | 'wasm' }
  | { state: 'error'; message: string };
