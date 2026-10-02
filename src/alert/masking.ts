import type { Detection, PiiType } from './types';

export function getMaskLabel(type: PiiType, index: number): string {
  return `[${type}_${index}]`;
}

function valid(d: Detection, textLength: number): boolean {
  return Number.isInteger(d.span.start) && Number.isInteger(d.span.end)
    && d.span.start >= 0 && d.span.end > d.span.start && d.span.end <= textLength;
}

/** Applies original-text UTF-16 spans from right to left; exact duplicates and overlaps are ignored. */
export function applyMasking(text: string, detections: readonly Detection[]): string {
  const candidates = detections
    .filter((d) => valid(d, text.length))
    .map((d, order) => ({ detection: d, order }))
    .sort((a, b) => a.detection.span.start - b.detection.span.start
      || b.detection.span.end - a.detection.span.end || a.order - b.order);
  const accepted: typeof candidates = [];
  let occupiedUntil = -1;
  for (const candidate of candidates) {
    const { start, end } = candidate.detection.span;
    if (start < occupiedUntil) continue;
    accepted.push(candidate);
    occupiedUntil = end;
  }
  const counts = new Map<PiiType, number>();
  const replacements = accepted.map(({ detection }) => {
    const next = (counts.get(detection.type) ?? 0) + 1;
    counts.set(detection.type, next);
    return { ...detection.span, label: getMaskLabel(detection.type, next) };
  });
  return replacements.sort((a, b) => b.start - a.start)
    .reduce((result, item) => result.slice(0, item.start) + item.label + result.slice(item.end), text);
}

/** Redacts values shown for automatically protected detections in the alert. */
export function maskPreview(value: string, type: PiiType): string {
  if (type === 'EMAIL') {
    const at = value.indexOf('@');
    if (at > 0) return `${value.slice(0, Math.min(2, at))}${'•'.repeat(Math.max(3, at - 2))}${value.slice(at)}`;
  }
  if (type === 'PHONE' || type === 'CARD_NUMBER') {
    const digits = value.replace(/\D/g, '');
    const visibleFrom = Math.max(0, digits.length - 4);
    let index = 0;
    return value.replace(/\d/g, () => {
      const current = index++;
      return current < visibleFrom ? '•' : digits[current] ?? '•';
    });
  }
  if (type === 'SECRET') return `${value.slice(0, Math.min(3, value.length))}${'•'.repeat(Math.min(12, Math.max(4, value.length - 3)))}`;
  return value.length > 4 ? `${value.slice(0, 2)}${'•'.repeat(Math.min(8, value.length - 4))}${value.slice(-2)}` : '•'.repeat(value.length);
}
