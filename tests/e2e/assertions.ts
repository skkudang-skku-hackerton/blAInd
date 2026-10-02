import { expect } from '@playwright/test';
import type { Detection } from '../../src/core/api/types';

export function assertSpans(text: string, detections: Detection[]) {
  for (const detection of detections) {
    expect(Number.isInteger(detection.span.start)).toBe(true);
    expect(Number.isInteger(detection.span.end)).toBe(true);
    expect(detection.span.start).toBeGreaterThanOrEqual(0);
    expect(detection.span.end).toBeGreaterThan(detection.span.start);
    expect(detection.span.end).toBeLessThanOrEqual(text.length);
    expect(Number.isFinite(detection.confidence)).toBe(true);
    expect(detection.confidence).toBeGreaterThanOrEqual(0);
    expect(detection.confidence).toBeLessThanOrEqual(1);
    expect(text.slice(detection.span.start, detection.span.end)).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u);
  }
  expect(new Set(detections.map(d => `${d.type}:${d.span.start}:${d.span.end}`)).size).toBe(detections.length);
}

export function assertEntity(text: string, detections: Detection[], type: string, value: string) {
  const start = text.indexOf(value);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(detections.filter(d => d.type === type && d.span.start === start && d.span.end === start + value.length),
    `Expected exactly one ${type} span for ${JSON.stringify(value)}; received ${JSON.stringify(detections)}`).toHaveLength(1);
}
