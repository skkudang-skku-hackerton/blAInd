import type { Detection, PiiType } from '../core/api/types';

export type { Detection, PiiType };

export type DetectionPolicy = 'AUTO_MASK' | 'CONFIRM';

export interface PrivacyAnalysis {
  segmentId: string;
  originalText: string;
  autoMaskedDetections: Detection[];
  confirmDetections: Detection[];
  hasConfirmItems: boolean;
}

export interface ReviewItem {
  segmentId: string;
  type: PiiType;
  span: { start: number; end: number };
  word: string;
}

export interface ApprovedReview {
  status: 'approved';
  /** AUTO_MASK items that remain selected after review. */
  autoMask: ReviewItem[];
  /** nonMasking includes unchecked items from either configured policy. */
  confirm: { masking: ReviewItem[]; nonMasking: ReviewItem[] };
}

export type ReviewResult = ApprovedReview | { status: 'cancelled' };
