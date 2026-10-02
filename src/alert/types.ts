import type { Detection, PiiType } from '../core/api/types';

export type { Detection, PiiType };

export type DetectionPolicy = 'AUTO_MASK' | 'CONFIRM';

export interface PrivacyAnalysis {
  originalText: string;
  autoMaskedText: string;
  autoMaskedDetections: Detection[];
  confirmDetections: Detection[];
  hasConfirmItems: boolean;
}
