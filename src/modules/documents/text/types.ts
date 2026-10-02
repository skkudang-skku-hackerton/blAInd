import type { PiiDetectorApi } from '../../../core/api/pii-detector';
import type { ReviewDocument } from '../shared/types';

export type TextDocumentStage = 'extracting' | 'scanning' | 'reviewing' | 'rebuilding';
export interface TextDocumentLimits {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxCharacters: number;
}
export const DEFAULT_LIMITS: Readonly<TextDocumentLimits> = {
  maxInputBytes: 10 * 1024 * 1024,
  maxOutputBytes: 12 * 1024 * 1024,
  maxCharacters: 5_000_000,
};
export interface TextDocumentProcessorOptions {
  detector: PiiDetectorApi;
  review: ReviewDocument;
  limits?: Partial<TextDocumentLimits>;
  onStage?: (stage: TextDocumentStage, file: File) => void;
  onError?: (error: unknown, file: File) => void;
}
