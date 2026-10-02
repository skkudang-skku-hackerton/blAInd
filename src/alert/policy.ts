import type { ApprovedReview, Detection, DetectionPolicy, PiiType, PrivacyAnalysis } from './types';
import { expandDetections } from '../core/api/detections';

const AUTO_MASK_TYPES = new Set<PiiType>([
  'RRN', 'FRN', 'CARD_NUMBER', 'ACCOUNT_NUMBER', 'SECRET', 'PASSPORT',
  'DRIVER_LICENSE', 'CVC', 'IPIN', 'PHONE', 'EMAIL',
]);

export function classifyDetection(type: PiiType): DetectionPolicy {
  return AUTO_MASK_TYPES.has(type) ? 'AUTO_MASK' : 'CONFIRM';
}

export function analyzeDetections(text: string, detections: Detection[], segmentId = 'text'): PrivacyAnalysis {
  const seen = new Set<string>();
  const usableDetections = expandDetections(detections).filter(({ type, span }) => {
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end)
      || span.start < 0 || span.end <= span.start || span.end > text.length) return false;
    const key = `${type}:${span.start}:${span.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const autoMaskedDetections = usableDetections.filter(({ type }) => classifyDetection(type) === 'AUTO_MASK');
  const confirmDetections = usableDetections.filter(({ type }) => classifyDetection(type) === 'CONFIRM');
  return {
    segmentId,
    originalText: text,
    autoMaskedDetections,
    confirmDetections,
    hasConfirmItems: confirmDetections.length > 0,
  };
}

/** Returns decisions for a processor; does not modify the original text. */
export function buildReviewResult(analysis: PrivacyAnalysis, selectedConfirm: readonly Detection[] = []): ApprovedReview {
  const selected = new Set(selectedConfirm);
  if (selectedConfirm.some(item => !analysis.confirmDetections.includes(item))) {
    throw new Error('Selected item does not belong to this review');
  }
  const item = (detection: Detection) => ({
    segmentId: analysis.segmentId,
    type: detection.type,
    span: { ...detection.span },
    word: analysis.originalText.slice(detection.span.start, detection.span.end),
  });
  return {
    status: 'approved',
    autoMask: analysis.autoMaskedDetections.map(item),
    confirm: {
      masking: analysis.confirmDetections.filter(detection => selected.has(detection)).map(item),
      nonMasking: analysis.confirmDetections.filter(detection => !selected.has(detection)).map(item),
    },
  };
}
