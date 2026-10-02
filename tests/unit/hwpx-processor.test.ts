import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { createHwpxProcessor } from '../../src/modules/documents/hwpx';
import { openHwpx } from '../../src/modules/documents/hwpx/engine';
import { DEFAULT_LIMITS } from '../../src/modules/documents/hwpx/types';
import type { AlertReviewDecision, AlertReviewRequest, ReviewItem } from '../../src/modules/documents/shared/types';
import type { PiiDetectorApi } from '../../src/core/api/pii-detector';

const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const section = `<hp:sec xmlns:hp="${HP}"><hp:p><hp:run><hp:t>안녕하세요 김</hp:t></hp:run><hp:run><hp:t>민수 전화 010-</hp:t></hp:run><hp:run><hp:t>1234-5678 안전한 문장</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>두 번째 문단</hp:t></hp:run></hp:p></hp:sec>`;
function fixture(sectionXml = section): Uint8Array<ArrayBuffer> {
  return new Uint8Array(zipSync({
    mimetype: strToU8('application/hwp+zip'),
    'version.xml': strToU8('<HCFVersion version="1.5.0.0"/>'),
    'META-INF/manifest.xml': strToU8('<manifest/>'),
    'Contents/content.hpf': strToU8('<opf/>'),
    'Contents/header.xml': strToU8(`<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"/>`),
    'Contents/section0.xml': strToU8(sectionXml),
  }));
}

const detector: PiiDetectorApi = {
  initialize: async () => {}, scanText: async () => [],
  scanSegments: async (segments) => segments.map(({ id, text }) => ({ segmentId: id, detections: Array.from(text.matchAll(/김민수|010-1234-5678/g), (match) => ({
    type: match[0] === '김민수' ? 'PERSON' as const : 'PHONE' as const,
    confidence: 0.99, span: { start: match.index, end: match.index + match[0].length },
  })) })),
};

function approve(request: AlertReviewRequest): AlertReviewDecision {
  const autoMask: ReviewItem[] = [], masking: ReviewItem[] = [], nonMasking: ReviewItem[] = [];
  for (const segment of request.segments) for (const detection of segment.detections) {
    const item = { segmentId: segment.id, type: detection.type, span: { ...detection.span }, word: detection.word };
    (detection.type === 'PHONE' ? autoMask : masking).push(item);
  }
  return { status: 'approved', autoMask, confirm: { masking, nonMasking } };
}

describe('HWPX processor demo flow', () => {
  it('extracts paragraphs across split runs, reviews spans and rebuilds a masked HWPX package', async () => {
    const errors: unknown[] = [], stages: string[] = [];
    const processor = createHwpxProcessor({ detector, review: async (request) => approve(request), openHwpx,
      onError: (error) => errors.push(error), onStage: (stage) => stages.push(stage) });
    const source = fixture();
    const result = await processor(new File([source], 'demo.hwpx', { type: 'application/hwp+zip' }), new AbortController().signal);
    expect(errors).toEqual([]);
    expect(stages).toEqual(['extracting', 'scanning', 'reviewing', 'rebuilding']);
    expect(result?.name).toBe('masked-document.hwpx');
    expect(result?.type).toBe('application/hwp+zip');
    const parts = unzipSync(new Uint8Array(await result!.arrayBuffer()));
    const outputBytes = new Uint8Array(await result!.arrayBuffer());
    const zipView = new DataView(outputBytes.buffer, outputBytes.byteOffset, outputBytes.byteLength);
    expect(zipView.getUint16(8, true)).toBe(0);
    expect(new TextDecoder().decode(outputBytes.slice(30, 38))).toBe('mimetype');
    const xml = strFromU8(parts['Contents/section0.xml']!);
    const parsed = new DOMParser().parseFromString(xml, 'application/xml');
    const text = Array.from(parsed.getElementsByTagNameNS(HP, 't')).map((node) => node.textContent).join('');
    expect(text).toContain('안녕하세요 ');
    expect(text).toContain('안전한 문장');
    expect(text).not.toContain('김민수');
    expect(text).not.toContain('010-1234-5678');
    expect(strFromU8(parts.mimetype!)).toBe('application/hwp+zip');
    const reopened = await openHwpx((await result!.arrayBuffer()), DEFAULT_LIMITS, new AbortController().signal);
    try { expect(reopened.segments.map(({ text: value }) => value).join('')).not.toContain('010-1234-5678'); }
    finally { reopened.close(); }
  });

  it('fails closed for non-HWPX packages and skips rebuild on review cancellation', async () => {
    const wrong = new Uint8Array(zipSync({ 'plain.txt': strToU8('no') }));
    await expect(openHwpx(wrong.buffer, DEFAULT_LIMITS, new AbortController().signal)).rejects.toThrow();
    const processor = createHwpxProcessor({ detector, openHwpx, review: async () => ({ status: 'cancelled' }) });
    const result = await processor(new File([fixture()], 'demo.hwpx'), new AbortController().signal);
    expect(result).toBeNull();
  });
});
