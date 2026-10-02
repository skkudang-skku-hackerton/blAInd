import { afterEach, expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({ browser: {} }));
import { preparePdfReview } from '../../src/features/review/pdf-review';
import { buildReviewResult } from '../../src/alert/policy';
import { createPdfSessionHost, createRemotePdfOpener, encodeBytes, PDF_CHANNEL } from '../../src/shared/messaging/pdf-session';
import { DEFAULT_LIMITS } from '../../src/modules/documents/pdf/types';

afterEach(() => vi.useRealTimers());

it('restores page-specific offsets when the same name appears on different pages', () => {
  const prepared = preparePdfReview({ segments: ['page-1', 'page-2'].map(id => ({ id, text: '김민수', detections: [
    { type: 'PERSON', confidence: 1, span: { start: 0, end: 3 }, word: '김민수' },
  ] })) });
  const decision = buildReviewResult(prepared.analysis, [prepared.analysis.confirmDetections[0]!]);
  expect(prepared.restore(decision.confirm.masking)).toEqual([{ segmentId: 'page-1', type: 'PERSON', span: { start: 0, end: 3 }, word: '김민수' }]);
  expect(prepared.restore(decision.confirm.nonMasking)[0]!.segmentId).toBe('page-2');
});

it('round-trips binary PDF output larger than a transport chunk and releases the session', async () => {
  const output = Uint8Array.from({ length: 700_000 }, (_, i) => i % 256);
  const close = vi.fn();
  const host = createPdfSessionHost(async () => ({ segments: [{ id: 'page-1', text: 'test' }], rebuild: async () => output, close }));
  try {
    const open = createRemotePdfOpener(request => host.handle({ ...request, owner: 'tab-1' }));
    const session = await open(new Uint8Array([1, 2, 3]).buffer, DEFAULT_LIMITS, new AbortController().signal);
    expect(await session.rebuild([], new AbortController().signal)).toEqual(output);
    session.close();
    expect(close).toHaveBeenCalledOnce();
  } finally { host.dispose(); }
});

it('isolates owners and closes an in-flight open after cancellation', async () => {
  let resolve!: (value: any) => void;
  const close = vi.fn();
  const host = createPdfSessionHost(() => new Promise(done => { resolve = done; }));
  const base = { channel: PDF_CHANNEL, target: 'offscreen', sessionId: 'a', owner: 'tab-1' } as const;
  try {
    const opening = host.handle({ ...base, op: 'open', data: encodeBytes(new Uint8Array([1])), limits: DEFAULT_LIMITS });
    expect(await host.handle({ ...base, owner: 'tab-2', op: 'read', offset: 0 })).toMatchObject({ ok: false });
    await host.handle({ ...base, op: 'close' });
    resolve({ segments: [], rebuild: vi.fn(), close });
    expect(await opening).toMatchObject({ ok: false });
    expect(close).toHaveBeenCalledOnce();
  } finally { host.dispose(); }
});

it('expires abandoned sessions without keeping document data indefinitely', async () => {
  vi.useFakeTimers();
  const close = vi.fn();
  const host = createPdfSessionHost(async () => ({ segments: [], rebuild: vi.fn(), close }));
  try {
    await host.handle({ channel: PDF_CHANNEL, target: 'offscreen', sessionId: 'a', owner: 'tab', op: 'open', data: 'AQ==', limits: DEFAULT_LIMITS });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(close).toHaveBeenCalledOnce();
  } finally { host.dispose(); }
});
