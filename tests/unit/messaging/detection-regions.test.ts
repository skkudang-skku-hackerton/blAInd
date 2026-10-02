import { describe, expect, it } from 'vitest';
import { PII_CHANNEL, validateResponse, type PiiRequest } from '../../../src/shared/messaging/types';
import type { Detection } from '../../../src/core/api/types';

const region: Detection = {
  type: 'PERSON', confidence: 0.95, span: { start: 0, end: 10 }, constituents: [
    { type: 'PHONE', confidence: 0.9, span: { start: 0, end: 5 } },
    { type: 'PERSON', confidence: 0.95, span: { start: 3, end: 10 } },
  ],
};
const request: PiiRequest = {
  channel: PII_CHANNEL, target: 'background', clientId: 'client', requestId: 'request',
  type: 'pii:scan-text', text: 'abcdefghij',
};
const response = (result: unknown) => ({ channel: PII_CHANNEL, clientId: 'client', requestId: 'request', type: 'pii:result', result });

describe('merged detection regions over RPC', () => {
  it('preserves constituent metadata for both text and segment results', () => {
    const textResponse = structuredClone(response([region]));
    expect(validateResponse(textResponse, request)).toEqual(textResponse);
    const segmentRequest: PiiRequest = { ...request, type: 'pii:scan-segments', segments: [{ id: 's', text: 'abcdefghij' }] };
    const segmentResponse = structuredClone(response([{ segmentId: 's', detections: [region] }]));
    expect(validateResponse(segmentResponse, segmentRequest)).toEqual(segmentResponse);
  });

  it.each([
    null, [], [region.constituents![0]], Array(2),
    [{ type: 'PHONE', confidence: 0.9, span: { start: 0, end: 5 } },
      { type: 'PERSON', confidence: 0.95, span: { start: 6, end: 10 } }],
    [{ type: 'PHONE', confidence: 0.9, span: { start: 0, end: 5 } },
      { type: 'PERSON', confidence: 0.95, span: { start: 5, end: 10 } }],
    [{ type: 'PHONE', confidence: 0.9, span: { start: 1, end: 5 } },
      { type: 'PERSON', confidence: 0.95, span: { start: 3, end: 10 } }],
    [{ type: 'PHONE', confidence: 0.9, span: { start: 0, end: 5 } },
      { type: 'PERSON', confidence: 0.95, span: { start: 3, end: 9 } }],
    [{ type: 'UNKNOWN', confidence: 0.9, span: { start: 0, end: 5 } }, region.constituents![1]],
    [{ type: 'PHONE', confidence: NaN, span: { start: 0, end: 5 } }, region.constituents![1]],
    [{ type: 'PHONE', confidence: 0.9, span: { start: -1, end: 5 } }, region.constituents![1]],
    [{ ...region.constituents![0], constituents: [] }, region.constituents![1]],
  ].map(constituents => [constituents]))('rejects malformed or incomplete constituent coverage: %j', constituents => {
    expect(() => validateResponse(response([{ ...region, constituents }]), request)).toThrow('Invalid PII RPC response.');
  });
});
