import { describe, expect, it } from 'vitest';
import { parseBioLabel, validateLabels } from '../../../src/core/pii/labels';
import { PII_TYPES } from '../../../src/core/pii/types';

describe('model label mapping', () => {
  it('accepts all public PII categories in either BIO position', () => {
    expect(parseBioLabel('O')).toEqual({ prefix: 'O' });
    for (const type of PII_TYPES) {
      expect(parseBioLabel(`B-${type}`)).toEqual({ prefix: 'B', type });
      expect(parseBioLabel(`I-${type}`)).toEqual({ prefix: 'I', type });
    }
  });
  it('rejects unknown or malformed labels and non-contiguous indices', () => {
    for (const label of ['PERSON', 'B-UNKNOWN', 'S-PHONE', 'b-PERSON', '']) {
      expect(() => parseBioLabel(label)).toThrow(/Unsupported/);
    }
    expect(() => validateLabels({ '0': 'O', '2': 'B-PERSON' }, 2)).toThrow(/Missing/);
  });
});
