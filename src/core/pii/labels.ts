import { PII_TYPES, type PiiType } from './types';

export type BioLabel = { prefix: 'B' | 'I'; type: PiiType } | { prefix: 'O' };

/** Unknown model categories are errors, rather than silently disappearing PII. */
export function parseBioLabel(label: string): BioLabel {
  if (label === 'O') return { prefix: 'O' };
  const match = /^(B|I)-(.+)$/.exec(label);
  if (!match || !PII_TYPES.includes(match[2] as PiiType)) {
    throw new Error(`Unsupported BIO label: ${label}`);
  }
  return { prefix: match[1] as 'B' | 'I', type: match[2] as PiiType };
}

export function validateLabels(labels: Readonly<Record<string, string>>, count: number): BioLabel[] {
  if (Object.keys(labels).length !== count) throw new Error('Logit class count does not match labels');
  return Array.from({ length: count }, (_, index) => {
    const label = labels[String(index)];
    if (typeof label !== 'string') throw new Error(`Missing label for class ${index}`);
    return parseBioLabel(label);
  });
}
