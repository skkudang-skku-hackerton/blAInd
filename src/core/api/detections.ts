import type { Detection, DetectionConstituent } from './types';

/** Expand merged regions before applying type-specific policies or user selections. */
export function expandDetections(detections: readonly Detection[]): DetectionConstituent[] {
  return detections.flatMap((detection) => detection.constituents ?? [detection]);
}
