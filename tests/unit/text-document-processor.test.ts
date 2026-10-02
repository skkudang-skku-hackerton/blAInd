import { describe, expect, it, vi } from 'vitest';
import { createTextDocumentProcessor, replaceSpans } from '../../src/modules/documents/text';
import type { PiiDetectorApi } from '../../src/core/api/pii-detector';
import type { AlertReviewDecision, AlertReviewRequest, ReviewItem } from '../../src/modules/documents/shared/types';

const detector: PiiDetectorApi = {
  initialize: async () => {},
  scanText: async () => [],
  scanSegments: async (segments) => segments.map(({ id, text }) => ({
    segmentId: id,
    detections: Array.from(text.matchAll(/김민수|010-1234-5678|minsu@example\.com/g), (match) => ({
      type: match[0] === '김민수' ? 'PERSON' as const : match[0] === 'minsu@example.com' ? 'EMAIL' as const : 'PHONE' as const,
      confidence: 0.99,
      span: { start: match.index, end: match.index + match[0].length },
    })),
  })),
};

function approve(request: AlertReviewRequest, maskPerson = true): AlertReviewDecision {
  const autoMask: ReviewItem[] = [], masking: ReviewItem[] = [], nonMasking: ReviewItem[] = [];
  for (const segment of request.segments) for (const detection of segment.detections) {
    const item = { segmentId: segment.id, type: detection.type, span: detection.span, word: detection.word };
    if (detection.type === 'PHONE' || detection.type === 'EMAIL') autoMask.push(item);
    else (maskPerson ? masking : nonMasking).push(item);
  }
  return { status: 'approved', autoMask, confirm: { masking, nonMasking } };
}

describe('plain text and Markdown processor', () => {
  it.each([
    ['txt', '안녕하세요\r\n김민수 010-1234-5678\r\n마지막 줄', 'masked-document.txt', 'text/plain;charset=utf-8'],
    ['md', '# 제목\n\n**김민수**\n\n[메일](mailto:minsu@example.com)\n', 'masked-document.md', 'text/markdown;charset=utf-8'],
    ['markdown', '- 이름: 김민수\n', 'masked-document.markdown', 'text/markdown;charset=utf-8'],
  ])('masks selected spans and preserves the %s source format', async (ext, input, name, type) => {
    const stages: string[] = [], requests: AlertReviewRequest[] = [];
    const process = createTextDocumentProcessor({ detector, review: async (request) => {
      requests.push(request); return approve(request);
    }, onStage: (stage) => stages.push(stage) });
    const output = await process(new File([input], `sensitive.${ext}`), new AbortController().signal);
    expect(output).not.toBeNull();
    expect(output!.name).toBe(name);
    expect(output!.type).toBe(type);
    const result = await output!.text();
    expect(result).toContain('█');
    expect(result).not.toContain('010-1234-5678');
    expect(result).not.toContain('minsu@example.com');
    expect(stages).toEqual(['extracting', 'scanning', 'reviewing', 'rebuilding']);
    expect(requests[0]!.segments[0]!.id).toBe('text');
    expect(requests[0]!.segments[0]!.text).toBe(input);
  });

  it('uses exact UTF-16 spans for emoji and preserves a UTF-8 BOM', async () => {
    const input = '\uFEFF😀 김민수\n';
    const process = createTextDocumentProcessor({ detector, review: async (request) => approve(request) });
    const output = await process(new File([input], 'file.txt'), new AbortController().signal);
    const bytes = new Uint8Array(await output!.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toBe('😀 ███\n');
  });

  it('replaces spans from the end without shifting earlier offsets', () => {
    expect(replaceSpans('0123456789', [{ start: 1, end: 3 }, { start: 7, end: 9 }])).toBe('0██3456██9');
  });

  it('returns null and never rebuilds/transmits original after user cancellation', async () => {
    const process = createTextDocumentProcessor({ detector, review: async () => ({ status: 'cancelled' }) });
    expect(await process(new File(['김민수'], 'test.txt'), new AbortController().signal)).toBeNull();
  });

  it('discards a late approval when its signal is aborted', async () => {
    const controller = new AbortController();
    let resolve!: (decision: AlertReviewDecision) => void;
    const ready = new Promise<void>((r) => {
      const review = (_request: AlertReviewRequest, { signal }: { signal: AbortSignal }) => {
        expect(signal).toBe(controller.signal); r(); return new Promise<AlertReviewDecision>((done) => { resolve = done; });
      };
      const process = createTextDocumentProcessor({ detector, review });
      void process(new File(['김민수'], 'test.txt'), controller.signal).then((result) => { expect(result).toBeNull(); });
    });
    await ready; controller.abort();
    resolve({ status: 'approved', autoMask: [], confirm: { masking: [], nonMasking: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });

  it.each([
    ['invalid UTF-8', new Uint8Array([0xc3, 0x28])],
    ['NUL binary', new Uint8Array([0x41, 0, 0x42])],
  ])('holds %s content', async (_label, bytes) => {
    const onError = vi.fn();
    const process = createTextDocumentProcessor({ detector, review: async (request) => approve(request), onError });
    expect(await process(new File([bytes], 'data.txt'), new AbortController().signal)).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('rejects unsupported extensions and size limits before detector work', async () => {
    const initialize = vi.fn();
    const process = createTextDocumentProcessor({ detector: { ...detector, initialize },
      review: async (request) => approve(request), limits: { maxInputBytes: 2 } });
    expect(await process(new File(['large'], 'data.txt'), new AbortController().signal)).toBeNull();
    const defaultLimits = createTextDocumentProcessor({ detector: { ...detector, initialize }, review: async (request) => approve(request) });
    expect(await defaultLimits(new File(['a,b'], 'data.csv'), new AbortController().signal)).toBeNull();
    expect(initialize).not.toHaveBeenCalled();
  });

  it('keeps an explicitly retained Confirm value while applying Auto Mask', async () => {
    const process = createTextDocumentProcessor({ detector, review: async (request) => approve(request, false) });
    const output = await process(new File(['김민수 010-1234-5678'], 'test.txt'), new AbortController().signal);
    expect(await output!.text()).toBe('김민수 █████████████');
  });
});
