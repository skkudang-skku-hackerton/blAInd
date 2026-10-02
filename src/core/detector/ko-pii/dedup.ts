import type { Detection } from '../../api/types';
import type { ChunkDetection } from './postprocess';

function duplicate(a: ChunkDetection, b: ChunkDetection): boolean {
  if (a.chunkIndex === b.chunkIndex || a.type !== b.type) return false;
  const overlap = Math.min(a.span.end, b.span.end) - Math.max(a.span.start, b.span.start);
  if (overlap <= 0) return false; // Touching BIO entities must stay separate.
  const union = Math.max(a.span.end, b.span.end) - Math.min(a.span.start, b.span.start);
  if (overlap / union > 0.8) return true;
  // A clipped chunk-edge fragment can be much shorter than the complete entity.
  const contained = (small: ChunkDetection, large: ChunkDetection) =>
    small.span.start >= large.span.start && small.span.end <= large.span.end &&
    ((small.truncatedStart && small.span.end === large.span.end) ||
     (small.truncatedEnd && small.span.start === large.span.start) ||
     (small.truncatedStart && small.truncatedEnd));
  return contained(a, b) || contained(b, a);
}

export function deduplicateDetections(candidates: readonly ChunkDetection[]): Detection[] {
  // Prefer complete spans over high-confidence fragments; exact duplicates use confidence.
  const ranked = [...candidates].sort((a, b) =>
    Number(a.truncatedStart || a.truncatedEnd) - Number(b.truncatedStart || b.truncatedEnd) ||
    (a.truncatedStart || a.truncatedEnd
      ? (b.span.end - b.span.start) - (a.span.end - a.span.start)
      : b.confidence - a.confidence) ||
    (b.span.end - b.span.start) - (a.span.end - a.span.start) || b.confidence - a.confidence ||
    a.chunkIndex - b.chunkIndex);
  const kept: { detection: ChunkDetection; chunks: Set<number> }[] = [];
  for (const candidate of ranked) {
    const group = kept.find((item) => !item.chunks.has(candidate.chunkIndex) && duplicate(item.detection, candidate));
    const existing = group?.detection;
    if (existing) {
      if (existing.span.start === candidate.span.start && existing.span.end === candidate.span.end) {
        existing.confidence = Math.max(existing.confidence, candidate.confidence);
      }
      group!.chunks.add(candidate.chunkIndex);
      continue;
    }
    // Both views may be clipped for entities longer than the overlap. Join only
    // complementary boundary fragments from different chunks with strict overlap.
    const crossingGroup = kept.find(({ detection: item, chunks }) => !chunks.has(candidate.chunkIndex) && item.type === candidate.type &&
      ((item.truncatedEnd && candidate.truncatedStart && item.span.start < candidate.span.start &&
        candidate.span.start < item.span.end && item.span.end < candidate.span.end) ||
       (candidate.truncatedEnd && item.truncatedStart && candidate.span.start < item.span.start &&
        item.span.start < candidate.span.end && candidate.span.end < item.span.end)) &&
      !kept.some((other) => other.detection !== item &&
        (other.chunks.has(candidate.chunkIndex) || [...chunks].some((index) => other.chunks.has(index))) &&
        other.detection.span.start < Math.max(item.span.end, candidate.span.end) &&
        other.detection.span.end > Math.min(item.span.start, candidate.span.start)));
    const crossing = crossingGroup?.detection;
    if (crossing) {
      const left = crossing.span.start < candidate.span.start ? crossing : candidate;
      const right = left === crossing ? candidate : crossing;
      crossing.span = { start: left.span.start, end: right.span.end };
      crossing.confidence = (crossing.confidence + candidate.confidence) / 2;
      if (crossing.tokenConfidences && candidate.tokenConfidences) {
        const scores = new Map<number, number>();
        for (const { tokenIndex, confidence } of [...crossing.tokenConfidences, ...candidate.tokenConfidences]) {
          scores.set(tokenIndex, Math.max(scores.get(tokenIndex) ?? 0, confidence));
        }
        crossing.tokenConfidences = [...scores].map(([tokenIndex, confidence]) => ({ tokenIndex, confidence }));
        crossing.confidence = [...scores.values()].reduce((sum, value) => sum + value, 0) / scores.size;
      }
      crossing.truncatedStart = left.truncatedStart;
      crossing.truncatedEnd = right.truncatedEnd;
      crossingGroup!.chunks.add(candidate.chunkIndex);
    } else {
      kept.push({ detection: { ...candidate, span: { ...candidate.span } }, chunks: new Set([candidate.chunkIndex]) });
    }
  }
  return kept.map((item) => item.detection)
    .sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end || a.type.localeCompare(b.type))
    .map(({ type, confidence, span }) => ({ type, confidence, span }));
}
