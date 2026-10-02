import type { Detection, DetectionPolicy, PiiType, PrivacyAnalysis } from './types';
import { applyMasking } from './masking';

const AUTO_MASK_TYPES = new Set<PiiType>([
  'RRN', 'FRN', 'CARD_NUMBER', 'ACCOUNT_NUMBER', 'SECRET', 'PASSPORT',
  'DRIVER_LICENSE', 'CVC', 'IPIN', 'PHONE', 'EMAIL',
]);

export function classifyDetection(type: PiiType): DetectionPolicy {
  return AUTO_MASK_TYPES.has(type) ? 'AUTO_MASK' : 'CONFIRM';
}

export function analyzeDetections(text: string, detections: Detection[]): PrivacyAnalysis {
  const seen = new Set<string>();
  const usableDetections = detections.filter(({ type, span }) => {
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
    originalText: text,
    autoMaskedText: applyMasking(text, autoMaskedDetections),
    autoMaskedDetections,
    confirmDetections,
    hasConfirmItems: confirmDetections.length > 0,
  };
}

export function createFinalText(analysis: PrivacyAnalysis, selectedConfirm: readonly Detection[] = []): string {
  if (selectedConfirm.length === 0) return analysis.autoMaskedText;
  return applyMasking(analysis.originalText, [...analysis.autoMaskedDetections, ...selectedConfirm]);
}
