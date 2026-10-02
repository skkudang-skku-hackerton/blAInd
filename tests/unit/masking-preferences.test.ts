import { afterEach, describe, expect, it } from 'vitest';
import { PII_TYPES } from '../../src/core/pii/types';
import { DEFAULT_MASKING_PREFERENCES, getMaskingPreferences, normalizeMaskingPreferences, setMaskingPreferences } from '../../src/core/pii/preferences';
import { analyzeDetections, buildReviewResult } from '../../src/alert/policy';
import { createReviewRequest, resolveReview } from '../../src/modules/documents/shared/review';

afterEach(() => setMaskingPreferences(null));

describe('user masking preferences', () => {
  it('preserves all 18 existing defaults and sanitizes partial or invalid stored values', () => {
    const preferences = normalizeMaskingPreferences({ PERSON: 'AUTO_MASK', PHONE: 'ignore', unknown: 'CONFIRM' });
    expect(Object.keys(preferences)).toEqual([...PII_TYPES]);
    expect(preferences.PERSON).toBe('AUTO_MASK');
    expect(preferences.PHONE).toBe('AUTO_MASK');
    expect(preferences.ADDRESS).toBe('CONFIRM');
    expect(normalizeMaskingPreferences(null)).toEqual(DEFAULT_MASKING_PREFERENCES);
    expect(Object.values(DEFAULT_MASKING_PREFERENCES).filter(value => value === 'AUTO_MASK')).toHaveLength(11);
  });

  it('applies both promotion to automatic and demotion to confirm in text review', () => {
    setMaskingPreferences({ PERSON: 'AUTO_MASK', PHONE: 'CONFIRM' });
    const analysis = analyzeDetections('김민수 010-1234-5678', [
      { type: 'PERSON', confidence: 1, span: { start: 0, end: 3 } },
      { type: 'PHONE', confidence: 1, span: { start: 4, end: 17 } },
    ]);
    expect(analysis.autoMaskedDetections.map(d => d.type)).toEqual(['PERSON']);
    expect(analysis.confirmDetections.map(d => d.type)).toEqual(['PHONE']);
    const decision = buildReviewResult(analysis);
    expect(decision.confirm.nonMasking[0]!.type).toBe('PHONE');
    expect(decision.autoMask[0]!.type).toBe('PERSON');
  });

  it('validates document decisions with the saved request snapshot even after settings change', () => {
    setMaskingPreferences({ PERSON: 'AUTO_MASK', PHONE: 'CONFIRM' });
    const text = '김민수 010-1234-5678';
    const detections = [
      { type: 'PERSON' as const, confidence: 1, span: { start: 0, end: 3 } },
      { type: 'PHONE' as const, confidence: 1, span: { start: 4, end: 17 } },
    ];
    const request = createReviewRequest([{ id: 's', text }], [{ segmentId: 's', detections }]);
    const decision = buildReviewResult(analyzeDetections(text, detections, 's', request.maskingPreferences));
    setMaskingPreferences(null);
    expect(resolveReview(request, decision)).toEqual([{ segmentId: 's', spans: [{ start: 0, end: 3 }] }]);
    const incorrectlyGrouped = { ...decision, autoMask: [], confirm: {
      masking: decision.autoMask, nonMasking: decision.confirm.nonMasking,
    } };
    expect(() => resolveReview(request, incorrectlyGrouped)).toThrow('incorrectly grouped');
  });

  it('returns independent copies so editing a draft cannot change active preferences', () => {
    const draft = getMaskingPreferences();
    draft.PERSON = 'AUTO_MASK';
    expect(getMaskingPreferences().PERSON).toBe('CONFIRM');
  });

  it('allows unchecking a user-configured automatic item without changing saved preferences', () => {
    setMaskingPreferences({ PERSON: 'AUTO_MASK', PHONE: 'CONFIRM' });
    const text = '김민수 010-1234-5678';
    const detections = [
      { type: 'PERSON' as const, confidence: 1, span: { start: 0, end: 3 } },
      { type: 'PHONE' as const, confidence: 1, span: { start: 4, end: 17 } },
    ];
    const request = createReviewRequest([{ id: 's', text }], [{ segmentId: 's', detections }]);
    const analysis = analyzeDetections(text, detections, 's', request.maskingPreferences);
    const decision = buildReviewResult(analysis, analysis.confirmDetections, []);
    expect(decision.autoMask).toEqual([]);
    expect(decision.confirm.nonMasking.map(item => item.type)).toEqual(['PERSON']);
    expect(getMaskingPreferences().PERSON).toBe('AUTO_MASK');
    setMaskingPreferences(null);
    expect(resolveReview(request, decision)).toEqual([{ segmentId: 's', spans: [{ start: 4, end: 17 }] }]);
    expect(request.maskingPreferences?.PERSON).toBe('AUTO_MASK');
  });
});
