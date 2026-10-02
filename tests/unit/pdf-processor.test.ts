import { describe, expect, it, vi } from 'vitest';
import * as mupdf from 'mupdf';
import { createPdfProcessor } from '../../src/modules/documents/pdf';
import { openPdf } from '../../src/modules/documents/pdf/engine';
import { createReviewRequest, resolveReview } from '../../src/modules/documents/pdf/review';
import { DEFAULT_LIMITS, type AlertReviewDecision, type AlertReviewRequest, type ReviewItem } from '../../src/modules/documents/pdf/types';
import type { PiiDetectorApi } from '../../src/core/api/pii-detector';
import { PII_TYPES } from '../../src/core/pii/types';

function fixture(lines = ['김민수 전화 010-1234-5678', '김민수 retained']): Uint8Array<ArrayBuffer> {
  const buffer = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buffer, 'pdf', '');
  const font = new mupdf.Font('ko');
  try {
    for (const line of lines) {
      const device = writer.beginPage([0, 0, 400, 200]);
      const text = new mupdf.Text();
      try {
        text.showString(font, [14, 0, 0, -14, 20, 50], line);
        device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1);
        device.close();
        writer.endPage();
      } finally { text.destroy(); device.destroy(); }
    }
    writer.close();
    return new Uint8Array(buffer.asUint8Array());
  } finally { writer.destroy(); buffer.destroy(); font.destroy(); }
}

const detector: PiiDetectorApi = {
  initialize: async () => {},
  scanText: async () => [],
  scanSegments: async (segments) => segments.map(({ id, text }) => ({
    segmentId: id,
    detections: [
      ...Array.from(text.matchAll(/김민수/g), (match) => ({ type: 'PERSON' as const, confidence: 0.9,
        span: { start: match.index, end: match.index + match[0].length } })),
      ...Array.from(text.matchAll(/010-1234-5678/g), (match) => ({ type: 'PHONE' as const, confidence: 0.99,
        span: { start: match.index, end: match.index + match[0].length } })),
    ],
  })),
};

function approve(request: AlertReviewRequest): AlertReviewDecision & { status: 'approved' } {
  const autoMask: ReviewItem[] = [], masking: ReviewItem[] = [], nonMasking: ReviewItem[] = [];
  for (const segment of request.segments) for (const d of segment.detections) {
    const item: ReviewItem = { segmentId: segment.id, type: d.type, span: { ...d.span }, word: d.word };
    if (d.type === 'PHONE') autoMask.push(item);
    else if (segment.id === 'page-1') masking.push(item);
    else nonMasking.push(item);
  }
  return { status: 'approved', autoMask, confirm: { masking, nonMasking } };
}

async function sampleRequest() {
  const segments = [{ id: 'page-1', text: '김민수 전화 010-1234-5678' }, { id: 'page-2', text: '김민수' }];
  return createReviewRequest(segments, await detector.scanSegments(segments));
}

describe('PDF review contract', () => {
  it('enforces every documented Auto Mask and Confirm category', () => {
    const auto = new Set(['RRN', 'FRN', 'CARD_NUMBER', 'ACCOUNT_NUMBER', 'SECRET', 'PASSPORT',
      'DRIVER_LICENSE', 'CVC', 'IPIN', 'PHONE', 'EMAIL']);
    for (const type of PII_TYPES) {
      const request = createReviewRequest([{ id: 'page-1', text: 'sample' }], [{ segmentId: 'page-1',
        detections: [{ type, confidence: 1, span: { start: 0, end: 6 } }] }]);
      const item: ReviewItem = { segmentId: 'page-1', type, word: 'sample', span: { start: 0, end: 6 } };
      const decision: AlertReviewDecision = { status: 'approved', autoMask: auto.has(type) ? [item] : [],
        confirm: { masking: [], nonMasking: auto.has(type) ? [] : [item] } };
      expect(resolveReview(request, decision)![0]!.spans.length).toBe(auto.has(type) ? 1 : 0);
    }
  });

  it('sends exact documented fields, preserving detector results', async () => {
    const segments = [{ id: 'page-1', text: '😀 김민수' }];
    const results = await detector.scanSegments(segments);
    const before = structuredClone(results);
    const request = createReviewRequest(segments, results);
    expect(request.segments[0]!.detections[0]).toEqual({ type: 'PERSON', confidence: 0.9,
      span: { start: 3, end: 6 }, word: '김민수' });
    expect(results).toEqual(before);
    expect(Object.keys(request)).toEqual(['segments']);
  });

  it('applies Auto Mask and chosen Confirm while retaining the same word on another page', async () => {
    const request = await sampleRequest();
    expect(resolveReview(request, approve(request))).toEqual([
      { segmentId: 'page-1', spans: [{ start: 0, end: 3 }, { start: 7, end: 20 }] },
      { segmentId: 'page-2', spans: [] },
    ]);
  });

  it.each(['omitted', 'duplicate', 'wrong-policy', 'forged-word', 'forged-span'])('rejects %s review data', async (kind) => {
    const request = await sampleRequest();
    const decision = approve(request);
    if (kind === 'omitted') decision.autoMask = [];
    if (kind === 'duplicate') decision.autoMask.push(structuredClone(decision.autoMask[0]!));
    if (kind === 'wrong-policy') decision.confirm.nonMasking.push(decision.autoMask.pop()!);
    if (kind === 'forged-word') decision.autoMask[0]!.word = 'other';
    if (kind === 'forged-span') decision.autoMask[0]!.span.start++;
    expect(() => resolveReview(request, decision)).toThrow();
  });

  it('rejects conflicting mask/keep spans rather than silently violating nonMasking', () => {
    const request = createReviewRequest([{ id: 'page-1', text: '123456' }], [{ segmentId: 'page-1', detections: [
      { type: 'PHONE', confidence: 1, span: { start: 0, end: 6 } },
      { type: 'GENERIC_ID', confidence: 1, span: { start: 1, end: 4 } },
    ] }]);
    const items = request.segments[0]!.detections.map(({ type, span, word }) => ({ segmentId: 'page-1', type, span, word }));
    expect(() => resolveReview(request, { status: 'approved', autoMask: [items[0]!],
      confirm: { masking: [], nonMasking: [items[1]!] } })).toThrow(/overlaps/);
  });
});

describe('PDF pipeline with real PDFs', () => {
  it('rebuilds raster pages and invisible Korean text with only approved spans removed', async () => {
    const errors: unknown[] = [];
    const review = vi.fn(async (request: AlertReviewRequest) => approve(request));
    const processor = createPdfProcessor({ detector, review, openPdf, onError: (error) => errors.push(error) });
    const file = await processor(new File([fixture()], '김민수.pdf'), new AbortController().signal);
    expect(errors).toEqual([]);
    expect(file).not.toBeNull();
    expect(file!.name).toBe('masked-document.pdf');
    const output = mupdf.Document.openDocument(await file!.arrayBuffer(), 'application/pdf');
    try {
      expect(output.countPages()).toBe(2);
      for (let index = 0; index < 2; index++) {
        const page = output.loadPage(index);
        const text = page.toStructuredText('preserve-images');
        try {
          expect(text.asText()).not.toContain('010-1234-5678');
          if (index === 0) expect(text.asText()).not.toContain('김민수');
          else expect(text.asText()).toContain('김민수');
          let images = 0;
          text.walk({ onImageBlock(_box, _transform, image) { images++; image.destroy(); } });
          expect(images).toBe(1);
        } finally { text.destroy(); page.destroy(); }
      }
    } finally { output.destroy(); }
    expect(review).toHaveBeenCalledOnce();
  });

  it('removes source pixels, keeps unselected pixels, and adds no visible text overlay', async () => {
    const sourceBytes = fixture(['김민수 전화 010-1234-5678']);
    const session = await openPdf(sourceBytes.buffer, DEFAULT_LIMITS, new AbortController().signal);
    const text = session.segments[0]!.text;
    const begin = text.indexOf('010');
    const output = await session.rebuild([{ segmentId: 'page-1', spans: [{ start: begin, end: begin + 13 }] }], new AbortController().signal);
    session.close();
    const original = mupdf.Document.openDocument(sourceBytes, 'application/pdf');
    const rebuilt = mupdf.Document.openDocument(output, 'application/pdf');
    const a = original.loadPage(0), b = rebuilt.loadPage(0);
    const st = a.toStructuredText('');
    const maskedBoxes: mupdf.Rect[] = [];
    let offset = 0;
    st.walk({ onChar(char, _origin, font, _size, quad) {
      if (offset >= begin && offset < begin + 13) maskedBoxes.push([
        Math.min(quad[0], quad[2], quad[4], quad[6]), Math.min(quad[1], quad[3], quad[5], quad[7]),
        Math.max(quad[0], quad[2], quad[4], quad[6]), Math.max(quad[1], quad[3], quad[5], quad[7]),
      ]);
      offset += char.length; font.destroy();
    } });
    const before = a.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, false);
    const after = b.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, false);
    try {
      const actual = after.getPixels(), source = before.getPixels();
      const stride = after.getStride();
      for (const box of maskedBoxes) {
        for (let y = Math.ceil(box[1] * 2); y < Math.floor(box[3] * 2); y++) {
          for (let x = Math.ceil(box[0] * 2); x < Math.floor(box[2] * 2); x++) {
            expect(actual[y * stride + x * 3]).toBe(0);
          }
        }
      }
      // Left portion contains retained Korean text; pixels must be identical.
      for (let y = 0; y < after.getHeight(); y++) {
        expect(actual.slice(y * stride, y * stride + 100 * 3)).toEqual(source.slice(y * stride, y * stride + 100 * 3));
      }
    } finally {
      before.destroy(); after.destroy(); st.destroy(); a.destroy(); b.destroy(); original.destroy(); rebuilt.destroy();
    }
  });

  it('rejects scan-only PDFs rather than silently treating them as PII-free', async () => {
    const session = await openPdf(fixture(['hello']).buffer, DEFAULT_LIMITS, new AbortController().signal);
    const raster = await session.rebuild([{ segmentId: 'page-1', spans: [{ start: 0, end: 5 }] }], new AbortController().signal);
    session.close();
    await expect(openPdf(raster.buffer, DEFAULT_LIMITS, new AbortController().signal)).rejects.toThrow(/OCR/);
  });

  it('rejects review mutations and does not regenerate after invalid approval', async () => {
    const rebuild = vi.fn();
    const processor = createPdfProcessor({ detector, openPdf: async () => ({
      segments: [{ id: 'page-1', text: '010-1234-5678' }], rebuild, close() {},
    }), review: async (request) => {
      request.segments[0]!.detections = [];
      return { status: 'approved', autoMask: [], confirm: { masking: [], nonMasking: [] } };
    } });
    expect(await processor(new File(['test'], 'test.pdf'), new AbortController().signal)).toBeNull();
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('keeps concurrent document cancellation scoped to its signal', async () => {
    let release!: () => void;
    const initialization = new Promise<void>((resolve) => { release = resolve; });
    const scanSegments = vi.fn(detector.scanSegments);
    const rebuild = vi.fn(async () => new Uint8Array([1]));
    const processor = createPdfProcessor({ detector: { ...detector, scanSegments, initialize: () => initialization },
      openPdf: async () => ({ segments: [], rebuild, close() {} }), review: async () => ({
        status: 'approved', autoMask: [], confirm: { masking: [], nonMasking: [] },
      }) });
    const first = new AbortController(), second = new AbortController();
    const a = processor(new File(['test'], 'a.pdf'), first.signal);
    const b = processor(new File(['test'], 'b.pdf'), second.signal);
    first.abort();
    release();
    expect(await a).toBeNull();
    expect(await b).toBeInstanceOf(File);
    expect(scanSegments).toHaveBeenCalledExactlyOnceWith([], { signal: second.signal });
  });

  it('does not rebuild after the user cancels', async () => {
    const rebuild = vi.fn();
    const close = vi.fn();
    const processor = createPdfProcessor({ detector, review: async () => ({ status: 'cancelled' }),
      openPdf: async () => ({ segments: [{ id: 'page-1', text: '김민수' }], rebuild, close }) });
    expect(await processor(new File(['%PDF-test'], 'test.pdf'), new AbortController().signal)).toBeNull();
    expect(rebuild).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('cancels a pending review and discards a late approval', async () => {
    const controller = new AbortController();
    let resolve!: (decision: AlertReviewDecision) => void;
    let started!: () => void;
    const ready = new Promise<void>((r) => { started = r; });
    const rebuild = vi.fn();
    const close = vi.fn();
    const processor = createPdfProcessor({ detector,
      review: (_request, { signal }) => {
        expect(signal).toBe(controller.signal);
        started(); return new Promise((r) => { resolve = r; });
      }, openPdf: async () => ({ segments: [], rebuild, close }) });
    const pending = processor(new File(['%PDF-test'], 'test.pdf'), controller.signal);
    await ready;
    controller.abort();
    expect(await pending).toBeNull();
    resolve({ status: 'approved', autoMask: [], confirm: { masking: [], nonMasking: [] } });
    await Promise.resolve();
    expect(rebuild).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects invalid files and page limits', async () => {
    const signal = new AbortController().signal;
    await expect(openPdf(new TextEncoder().encode('not a pdf').buffer, DEFAULT_LIMITS, signal)).rejects.toThrow();
    await expect(openPdf(fixture().buffer, { ...DEFAULT_LIMITS, maxPages: 1 }, signal)).rejects.toThrow(/page count/);
  });
});
