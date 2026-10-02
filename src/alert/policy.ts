import type { ApprovedReview, Detection, DetectionPolicy, PiiType, PrivacyAnalysis } from './types';
import { expandDetections } from '../core/api/detections';
import { getMaskingPreferences, type MaskingPreferences } from '../core/pii/preferences';

export function classifyDetection(type: PiiType, preferences = getMaskingPreferences()): DetectionPolicy {
  return preferences[type];
}

export function analyzeDetections(text: string, detections: Detection[], segmentId = 'text', preferences: MaskingPreferences = getMaskingPreferences()): PrivacyAnalysis {
  const seen = new Set<string>();
  const usableDetections = expandDetections(detections).filter(({ type, span }) => {
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end)
      || span.start < 0 || span.end <= span.start || span.end > text.length) return false;
    const key = `${type}:${span.start}:${span.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const autoMaskedDetections = usableDetections.filter(({ type }) => classifyDetection(type, preferences) === 'AUTO_MASK');
  const confirmDetections = usableDetections.filter(({ type }) => classifyDetection(type, preferences) === 'CONFIRM');
  return {
    segmentId,
    originalText: text,
    autoMaskedDetections,
    confirmDetections,
    hasConfirmItems: confirmDetections.length > 0,
  };
}

/** Returns decisions for a processor; does not modify the original text. */
export function buildReviewResult(
  analysis: PrivacyAnalysis,
  selectedConfirm: readonly Detection[] = [],
  selectedAuto: readonly Detection[] = analysis.autoMaskedDetections,
): ApprovedReview {
  const selected = new Set(selectedConfirm);
  const selectedDefaults = new Set(selectedAuto);
  if (selectedConfirm.some(item => !analysis.confirmDetections.includes(item))
    || selectedAuto.some(item => !analysis.autoMaskedDetections.includes(item))) {
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
    autoMask: analysis.autoMaskedDetections.filter(detection => selectedDefaults.has(detection)).map(item),
    confirm: {
      masking: analysis.confirmDetections.filter(detection => selected.has(detection)).map(item),
      nonMasking: [
        ...analysis.confirmDetections.filter(detection => !selected.has(detection)),
        ...analysis.autoMaskedDetections.filter(detection => !selectedDefaults.has(detection)),
      ].map(item),
    },
  };
}
