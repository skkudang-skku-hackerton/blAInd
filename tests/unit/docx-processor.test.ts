import { describe, expect, it, vi } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { DOMParser, type Document, type Element } from '@xmldom/xmldom';
import { createDocxProcessor } from '../../src/modules/documents/docx';
import { openDocx } from '../../src/modules/documents/docx/engine';
import { DEFAULT_LIMITS } from '../../src/modules/documents/docx/types';
import type { AlertReviewDecision, AlertReviewRequest, ReviewItem } from '../../src/modules/documents/shared/types';
import type { PiiDetectorApi } from '../../src/core/api/pii-detector';
import { PII_TYPES } from '../../src/core/pii/types';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function fixture(overrides: Record<string, string> = {}): Uint8Array<ArrayBuffer> {
  const parts: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
      <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
      <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
      <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
    </Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
    </Relationships>`,
    'word/document.xml': `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>
      <w:p><w:pPr><w:jc w:val="center"/></w:pPr>
        <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">😀 김</w:t></w:r>
        <w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">민수 전화 010-</w:t></w:r>
        <w:r><w:t>1234-5678</w:t></w:r><w:r><w:t xml:space="preserve"> safe &amp; sound</w:t></w:r>
      </w:p>
      <w:p><w:r><w:t>김민수 retained</w:t></w:r></w:p>
      <w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="5000"/></w:tblGrid>
        <w:tr><w:tc><w:p><w:r><w:t>table 010-1234-5678 safe</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
      <w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/></w:sectPr>
    </w:body></w:document>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rIdStyles" Type="${R}/styles" Target="styles.xml"/>
      <Relationship Id="rIdHeader" Type="${R}/header" Target="header1.xml"/>
      <Relationship Id="rIdFooter" Type="${R}/footer" Target="footer1.xml"/>
    </Relationships>`,
    'word/styles.xml': `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="24"/></w:rPr></w:style></w:styles>`,
    'word/header1.xml': `<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>header 010-1234-5678 safe</w:t></w:r></w:p></w:hdr>`,
    'word/footer1.xml': `<w:ftr xmlns:w="${W}"><w:p><w:r><w:t>footer 010-1234-5678 safe</w:t></w:r></w:p></w:ftr>`,
    'docProps/core.xml': `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>PRIVATE_AUTHOR_김민수</dc:creator><dc:description>PRIVATE_DESCRIPTION</dc:description></cp:coreProperties>`,
    ...overrides,
  };
  return new Uint8Array(zipSync(Object.fromEntries(Object.entries(parts).map(([name, xml]) => [name, strToU8(xml)]))));
}

function xml(bytes: Uint8Array, name: string) {
  const part = unzipSync(bytes)[name];
  expect(part, `missing ${name}`).toBeDefined();
  return new DOMParser().parseFromString(strFromU8(part!), 'application/xml');
}

function textOf(element: Document | Element): string {
  return Array.from(element.getElementsByTagNameNS(W, 't')).map((node) => node.textContent).join('');
}

function withBody(body: string): Uint8Array<ArrayBuffer> {
  return fixture({ 'word/document.xml': `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>` });
}

function withStory(kind: 'footnotes' | 'endnotes' | 'comments', contents: string): Uint8Array<ArrayBuffer> {
  const parts = unzipSync(fixture());
  parts[`word/${kind}.xml`] = strToU8(contents);
  parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']!).replace('</Types>',
    `<Override PartName="/word/${kind}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/></Types>`));
  parts['word/_rels/document.xml.rels'] = strToU8(strFromU8(parts['word/_rels/document.xml.rels']!).replace('</Relationships>',
    `<Relationship Id="rIdExtra" Type="${R}/${kind}" Target="${kind}.xml"/></Relationships>`));
  const reference = kind === 'comments'
    ? '<w:commentRangeStart w:id="1"/><w:r><w:t>comment anchor</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>'
    : `<w:r><w:${kind === 'footnotes' ? 'footnote' : 'endnote'}Reference w:id="1"/></w:r>`;
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']!).replace('<w:sectPr>', `<w:p>${reference}</w:p><w:sectPr>`));
  return new Uint8Array(zipSync(parts));
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
  for (const segment of request.segments) for (const detection of segment.detections) {
    const item = { segmentId: segment.id, type: detection.type, word: detection.word, span: { ...detection.span } };
    if (detection.type === 'PHONE') autoMask.push(item);
    else if (segment.text.includes('retained')) nonMasking.push(item);
    else masking.push(item);
  }
  return { status: 'approved', autoMask, confirm: { masking, nonMasking } };
}

describe('DOCX engine and real OOXML pipeline', () => {
  it('extracts split Korean runs, table cells, headers and footers with unique segment IDs', async () => {
    const session = await openDocx(fixture().buffer, DEFAULT_LIMITS, new AbortController().signal);
    try {
      expect(session.segments.map(({ text }) => text)).toEqual(expect.arrayContaining([
        '😀 김민수 전화 010-1234-5678 safe & sound', '김민수 retained',
        'table 010-1234-5678 safe', 'header 010-1234-5678 safe', 'footer 010-1234-5678 safe',
      ]));
      expect(new Set(session.segments.map(({ id }) => id)).size).toBe(session.segments.length);
    } finally { session.close(); }
  });

  it('removes selected source XML text across runs while retaining identical kept text and formatting', async () => {
    const errors: unknown[] = [];
    const review = vi.fn(async (request: AlertReviewRequest) => {
      expect(Object.keys(request)).toEqual(['segments']);
      const first = request.segments.find(({ text }) => text.startsWith('😀'))!;
      expect(first.detections).toContainEqual({ type: 'PERSON', confidence: 0.9, word: '김민수', span: { start: 3, end: 6 } });
      return approve(request);
    });
    const processor = createDocxProcessor({ detector, review, openDocx, onError: (error) => errors.push(error) });
    const file = await processor(new File([fixture()], '김민수.docx', { type: MIME }), new AbortController().signal);
    expect(errors).toEqual([]);
    expect(file).not.toBeNull();
    expect(file!.name).toBe('masked-document.docx');
    expect(file!.type).toBe(MIME);
    const bytes = new Uint8Array(await file!.arrayBuffer());
    const document = xml(bytes, 'word/document.xml');
    const paragraphs = Array.from(document.getElementsByTagNameNS(W, 'p'));
    expect(textOf(paragraphs[0]!)).not.toContain('김민수');
    expect(textOf(paragraphs[0]!)).toContain('😀 ');
    expect(textOf(paragraphs[0]!)).toContain(' safe & sound');
    expect(textOf(paragraphs[1]!)).toBe('김민수 retained');
    expect(textOf(paragraphs[2]!)).toContain('table ');
    expect(document.getElementsByTagNameNS(W, 'b').length).toBe(1);
    expect(document.getElementsByTagNameNS(W, 'i').length).toBe(1);
    expect(document.getElementsByTagNameNS(W, 'jc')[0]!.getAttributeNS(W, 'val')).toBe('center');
    expect(document.getElementsByTagNameNS(W, 'tbl').length).toBe(1);
    expect(xml(bytes, 'word/styles.xml').getElementsByTagNameNS(W, 'sz')[0]!.getAttributeNS(W, 'val')).toBe('24');
    for (const name of ['word/header1.xml', 'word/footer1.xml']) {
      expect(textOf(xml(bytes, name))).toContain(' safe');
      expect(textOf(xml(bytes, name))).not.toContain('010-1234-5678');
    }
    const parts = unzipSync(bytes);
    const allXml = Object.entries(parts).filter(([name]) => /\.(xml|rels)$/.test(name)).map(([, data]) => strFromU8(data)).join('\n');
    expect(allXml).not.toContain('010-1234-5678');
    expect(allXml).not.toContain('PRIVATE_AUTHOR');
    expect(allXml).not.toContain('PRIVATE_DESCRIPTION');
    // Concatenating text nodes also catches sensitive strings split across XML runs.
    expect(textOf(document).match(/김민수/g)).toHaveLength(1);
    expect(review).toHaveBeenCalledOnce();
    const reopened = await openDocx(bytes.buffer, DEFAULT_LIMITS, new AbortController().signal);
    try { expect(reopened.segments.some(({ text }) => text === '김민수 retained')).toBe(true); }
    finally { reopened.close(); }
  });

  it('rejects invalid ZIP and ZIP files without a Word document', async () => {
    const signal = new AbortController().signal;
    await expect(openDocx(new Uint8Array(strToU8('not a zip')).buffer, DEFAULT_LIMITS, signal)).rejects.toThrow();
    const other = new Uint8Array(zipSync({ 'plain.txt': strToU8('hello') }));
    await expect(openDocx(other.buffer, DEFAULT_LIMITS, signal)).rejects.toThrow();
  });

  it.each([
    ['maxInputBytes', 10], ['maxEntries', 2], ['maxUncompressedBytes', 100],
    ['maxParagraphs', 1], ['maxCharacters', 5],
  ] as const)('enforces %s before returning a session', async (key, value) => {
    await expect(openDocx(fixture().buffer, { ...DEFAULT_LIMITS, [key]: value }, new AbortController().signal)).rejects.toThrow();
  });

  it('enforces the expanded archive limit even for highly compressible input', async () => {
    const source = fixture({ 'word/padding.xml': `<padding>${'A'.repeat(200_000)}</padding>` });
    expect(source.byteLength).toBeLessThan(20_000);
    await expect(openDocx(source.buffer, { ...DEFAULT_LIMITS, maxUncompressedBytes: 100_000 }, new AbortController().signal)).rejects.toThrow();
  });

  it('rejects macro-enabled Word content masquerading as DOCX', async () => {
    const parts = unzipSync(fixture());
    parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']!).replace(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
      'application/vnd.ms-word.document.macroEnabled.main+xml'));
    await expect(openDocx(new Uint8Array(zipSync(parts)).buffer, DEFAULT_LIMITS, new AbortController().signal)).rejects.toThrow();
  });

  it('rejects rebuilding beyond the output byte limit', async () => {
    const signal = new AbortController().signal;
    const session = await openDocx(fixture().buffer, { ...DEFAULT_LIMITS, maxOutputBytes: 10 }, signal);
    try {
      await expect(session.rebuild(session.segments.map(({ id }) => ({ segmentId: id, spans: [] })), signal)).rejects.toThrow();
    } finally { session.close(); }
  });

  it('honors an already aborted extraction signal and aborts before rebuilding', async () => {
    const controller = new AbortController();
    const session = await openDocx(fixture().buffer, DEFAULT_LIMITS, controller.signal);
    controller.abort();
    try {
      await expect(openDocx(fixture().buffer, DEFAULT_LIMITS, controller.signal)).rejects.toThrow();
      await expect(session.rebuild(session.segments.map(({ id }) => ({ segmentId: id, spans: [] })), controller.signal)).rejects.toThrow();
    } finally { session.close(); }
  });
});

describe('DOCX text mapping and fail-closed package validation', () => {
  it('maps tabs, both break forms, and UTF-16 spans across runs, then reopens the output', async () => {
    const source = withBody('<w:p><w:r><w:t>😀 김</w:t><w:tab/><w:t>민</w:t><w:br/><w:t>수</w:t><w:cr/><w:t> safe</w:t></w:r></w:p>');
    const signal = new AbortController().signal;
    const session = await openDocx(source.buffer, DEFAULT_LIMITS, signal);
    try {
      const segment = session.segments[0]!;
      expect(segment.text).toBe('😀 김\t민\n수\n safe');
      // Start after the complete surrogate pair; select text, tab, and line break.
      const output = await session.rebuild(session.segments.map(({ id }) => ({
        segmentId: id, spans: id === segment.id ? [{ start: 3, end: 8 }] : [],
      })), signal);
      const reopened = await openDocx(output.buffer, DEFAULT_LIMITS, signal);
      try {
        const text = reopened.segments[0]!.text;
        expect(text.startsWith('😀 ')).toBe(true);
        expect(text.endsWith('\n safe')).toBe(true);
        expect(text).not.toMatch(/[김민수]/);
        expect(text).not.toContain('\t');
        expect(text.match(/\n/g)).toHaveLength(1);
      } finally { reopened.close(); }
      const document = xml(output, 'word/document.xml');
      expect(document.getElementsByTagNameNS(W, 'tab').length).toBe(0);
      expect(document.getElementsByTagNameNS(W, 'br').length).toBe(0);
      expect(document.getElementsByTagNameNS(W, 'cr').length).toBe(1);
    } finally { session.close(); }
  });

  it.each(['footnotes', 'endnotes'] as const)('detects and removes sensitive text in %s', async (kind) => {
    const singular = kind === 'footnotes' ? 'footnote' : 'endnote';
    const source = withStory(kind, `<w:${kind} xmlns:w="${W}"><w:${singular} w:id="1"><w:p><w:r><w:${singular}Ref/><w:t>note 010-</w:t></w:r><w:r><w:t>1234-5678 safe</w:t></w:r></w:p></w:${singular}></w:${kind}>`);
    const errors: unknown[] = [];
    const review = vi.fn(async (request: AlertReviewRequest) => {
      const note = request.segments.find(({ text }) => text === 'note 010-1234-5678 safe');
      expect(note?.detections).toEqual([{ type: 'PHONE', confidence: 0.99, word: '010-1234-5678', span: { start: 5, end: 18 } }]);
      return approve(request);
    });
    const file = await createDocxProcessor({ detector, openDocx, review, onError: (error) => errors.push(error) })(
      new File([source], 'notes.docx'), new AbortController().signal);
    expect(errors).toEqual([]);
    expect(review).toHaveBeenCalledOnce();
    expect(file).not.toBeNull();
    const output = new Uint8Array(await file!.arrayBuffer());
    const text = textOf(xml(output, `word/${kind}.xml`));
    expect(text).toContain('note ');
    expect(text).toContain(' safe');
    expect(text).not.toContain('010-1234-5678');
    const reopened = await openDocx(output.buffer, DEFAULT_LIMITS, new AbortController().signal);
    try { expect(reopened.segments.some((segment) => segment.text === text)).toBe(true); }
    finally { reopened.close(); }
  });

  it('removes comments, author metadata, anchors, and their package references', async () => {
    const source = withStory('comments', `<w:comments xmlns:w="${W}"><w:comment w:id="1" w:author="PRIVATE_COMMENT_AUTHOR" w:initials="PC" w:date="2026-01-01T00:00:00Z"><w:p><w:r><w:t>PRIVATE_COMMENT_TEXT 010-1234-5678</w:t></w:r></w:p></w:comment></w:comments>`);
    const signal = new AbortController().signal;
    const session = await openDocx(source.buffer, DEFAULT_LIMITS, signal);
    try {
      const output = await session.rebuild(session.segments.map(({ id }) => ({ segmentId: id, spans: [] })), signal);
      const parts = unzipSync(output);
      expect(parts['word/comments.xml']).toBeUndefined();
      const allXml = Object.values(parts).map((part) => strFromU8(part)).join('\n');
      expect(allXml).not.toContain('PRIVATE_COMMENT');
      expect(allXml).not.toContain('comments.xml');
      expect(allXml).not.toContain(`${R}/comments`);
      const document = xml(output, 'word/document.xml');
      for (const local of ['commentRangeStart', 'commentRangeEnd', 'commentReference']) {
        expect(document.getElementsByTagNameNS(W, local).length).toBe(0);
      }
      expect(textOf(document)).toContain('comment anchor');
      const reopened = await openDocx(output.buffer, DEFAULT_LIMITS, signal);
      reopened.close();
    } finally { session.close(); }
  });

  it.each([
    '<!DOCTYPE w:document>',
    '<!DOCTYPE w:document [<!ENTITY sensitive "PRIVATE_ENTITY">]>',
    '<!DOCTYPE w:document [<!ENTITY sensitive SYSTEM "file:///etc/passwd">]>',
  ])('rejects DTD/entity declarations: %s', async (declaration) => {
    const signal = new AbortController().signal;
    const parts = unzipSync(withBody('<w:p><w:r><w:t>safe</w:t></w:r></w:p>'));
    const baseline = await openDocx(new Uint8Array(zipSync(parts)).buffer, DEFAULT_LIMITS, signal);
    baseline.close();
    const body = strFromU8(parts['word/document.xml']!);
    parts['word/document.xml'] = strToU8(declaration + (declaration.includes('ENTITY') ? body.replace('>safe<', '>&sensitive;<') : body));
    await expect(openDocx(new Uint8Array(zipSync(parts)).buffer, DEFAULT_LIMITS, signal)).rejects.toThrow(/XML|DTD|entity|DOCTYPE/i);
  });

  it.each([
    '<w:ins w:id="1" w:author="author"><w:r><w:t>hidden insertion</w:t></w:r></w:ins>',
    '<w:del w:id="1" w:author="author"><w:r><w:delText>hidden deletion</w:delText></w:r></w:del>',
  ])('rejects tracked changes rather than silently omitting unreviewed text', async (change) => {
    const signal = new AbortController().signal;
    const baseline = await openDocx(withBody('<w:p><w:r><w:t>safe</w:t></w:r></w:p>').buffer, DEFAULT_LIMITS, signal);
    baseline.close();
    await expect(openDocx(withBody(`<w:p><w:r><w:t>safe</w:t></w:r>${change}</w:p>`).buffer, DEFAULT_LIMITS, signal)).rejects.toThrow(/unsupported|tracked/i);
  });

  it('rejects an embedded image with valid content type and relationship', async () => {
    const signal = new AbortController().signal;
    const baseline = await openDocx(fixture().buffer, DEFAULT_LIMITS, signal);
    baseline.close();
    const parts = unzipSync(fixture());
    parts['word/media/image1.png'] = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=', 'base64'));
    parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']!).replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>'));
    parts['word/_rels/document.xml.rels'] = strToU8(strFromU8(parts['word/_rels/document.xml.rels']!).replace('</Relationships>', `<Relationship Id="rIdImage" Type="${R}/image" Target="media/image1.png"/></Relationships>`));
    const drawing = `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="Image"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']!).replace('<w:sectPr>', `<w:p>${drawing}</w:p><w:sectPr>`));
    await expect(openDocx(new Uint8Array(zipSync(parts)).buffer, DEFAULT_LIMITS, signal)).rejects.toThrow(/unsupported|image|media|drawing/i);
  });

  it('checks CRC even when corrupted stored XML remains parseable', async () => {
    const signal = new AbortController().signal;
    const source = new Uint8Array(zipSync(unzipSync(fixture()), { level: 0 }));
    const baseline = await openDocx(source.buffer, DEFAULT_LIMITS, signal);
    baseline.close();
    const needle = strToU8('retained');
    const offset = source.findIndex((_, i) => needle.every((byte, j) => source[i + j] === byte));
    expect(offset).toBeGreaterThan(0);
    source[offset] = 'R'.charCodeAt(0);
    expect(strFromU8(unzipSync(source)['word/document.xml']!)).toContain('Retained');
    await expect(openDocx(source.buffer, DEFAULT_LIMITS, signal)).rejects.toThrow(/CRC|corrupt/i);
  });

  it('rejects duplicate ZIP paths before the unzip dictionary can hide an entry', async () => {
    const signal = new AbortController().signal;
    const source = fixture();
    const baseline = await openDocx(source.buffer, DEFAULT_LIMITS, signal);
    baseline.close();
    const from = strToU8('word/header1.xml'), to = strToU8('word/footer1.xml');
    expect(from.length).toBe(to.length);
    let replaced = 0;
    // Rename both the local and central-directory names without changing sizes or CRCs.
    for (let i = 0; i <= source.length - from.length; i++) {
      if (from.every((byte, j) => source[i + j] === byte)) { source.set(to, i); replaced++; }
    }
    expect(replaced).toBe(2);
    await expect(openDocx(source.buffer, DEFAULT_LIMITS, signal)).rejects.toThrow(/duplicate/i);
  });

  it.each(['unknown-segment', 'duplicate-segment', 'missing-segment', 'negative', 'past-end', 'reversed', 'fractional', 'NaN', 'surrogate-start', 'surrogate-end'])('rejects direct rebuild masks with %s', async (kind) => {
    const signal = new AbortController().signal;
    const session = await openDocx(withBody('<w:p><w:r><w:t>😀 김민수 safe</w:t></w:r></w:p>').buffer, DEFAULT_LIMITS, signal);
    try {
      const segment = session.segments[0]!;
      const spans = [{ start: 3, end: 6 }];
      if (kind === 'negative') spans[0]!.start = -1;
      if (kind === 'past-end') spans[0]!.end = segment.text.length + 1;
      if (kind === 'reversed') spans[0] = { start: 6, end: 3 };
      if (kind === 'fractional') spans[0]!.start = 3.5;
      if (kind === 'NaN') spans[0]!.start = NaN;
      if (kind === 'surrogate-start') spans[0] = { start: 1, end: 2 };
      if (kind === 'surrogate-end') spans[0] = { start: 0, end: 1 };
      const masks = session.segments.map(({ id }) => ({
        segmentId: kind === 'unknown-segment' && id === segment.id ? 'does-not-exist' : id,
        spans: id === segment.id ? spans : [],
      }));
      if (kind === 'duplicate-segment') masks.push(structuredClone(masks[0]!));
      if (kind === 'missing-segment') masks.pop();
      await expect(session.rebuild(masks, signal).then(() => 'unexpected successful rebuild')).rejects.toThrow();
      // A rejected request must not mutate the source used by later valid rebuilds.
      const output = await session.rebuild(session.segments.map(({ id }) => ({ segmentId: id, spans: [] })), signal);
      const reopened = await openDocx(output.buffer, DEFAULT_LIMITS, signal);
      try { expect(reopened.segments[0]!.text).toBe(segment.text); }
      finally { reopened.close(); }
    } finally { session.close(); }
  });
});

describe('DOCX review validation and cancellation', () => {
  it('uses the documented Auto Mask and Confirm policy for every detector category', async () => {
    const autoTypes = new Set(['RRN', 'FRN', 'CARD_NUMBER', 'ACCOUNT_NUMBER', 'SECRET', 'PASSPORT',
      'DRIVER_LICENSE', 'CVC', 'IPIN', 'PHONE', 'EMAIL']);
    const segments = PII_TYPES.map((type) => ({ id: `category-${type}`, text: 'sample' }));
    const rebuild = vi.fn(async () => new Uint8Array([1]));
    const processor = createDocxProcessor({
      detector: { ...detector, scanSegments: async (input) => input.map(({ id }) => ({ segmentId: id,
        detections: [{ type: PII_TYPES.find((type) => id === `category-${type}`)!, confidence: 1, span: { start: 0, end: 6 } }],
      })) },
      openDocx: async () => ({ segments, rebuild, close() {} }),
      review: async (request) => {
        const autoMask: ReviewItem[] = [], nonMasking: ReviewItem[] = [];
        for (const segment of request.segments) for (const { type, span, word } of segment.detections) {
          (autoTypes.has(type) ? autoMask : nonMasking).push({ segmentId: segment.id, type, span, word });
        }
        return { status: 'approved', autoMask, confirm: { masking: [], nonMasking } };
      },
    });
    const signal = new AbortController().signal;
    expect(await processor(new File(['test'], 'policy.docx'), signal)).toBeInstanceOf(File);
    expect(rebuild).toHaveBeenCalledExactlyOnceWith(PII_TYPES.map((type) => ({
      segmentId: `category-${type}`, spans: autoTypes.has(type) ? [{ start: 0, end: 6 }] : [],
    })), signal);
  });

  it.each(['omitted', 'duplicate', 'wrong-policy', 'forged-word', 'forged-span', 'mutated-request'])('does not rebuild after %s approval', async (kind) => {
    const rebuild = vi.fn(), close = vi.fn();
    const processor = createDocxProcessor({ detector,
      openDocx: async () => ({ segments: [{ id: 'arbitrary-paragraph', text: '김민수 010-1234-5678' }], rebuild, close }),
      review: async (request) => {
        const decision = approve(request);
        if (kind === 'omitted') decision.autoMask = [];
        if (kind === 'duplicate') decision.autoMask.push(structuredClone(decision.autoMask[0]!));
        if (kind === 'wrong-policy') decision.confirm.nonMasking.push(decision.autoMask.pop()!);
        if (kind === 'forged-word') decision.autoMask[0]!.word = 'other';
        if (kind === 'forged-span') decision.autoMask[0]!.span.start++;
        if (kind === 'mutated-request') {
          request.segments[0]!.detections = [];
          return { status: 'approved', autoMask: [], confirm: { masking: [], nonMasking: [] } };
        }
        return decision;
      },
    });
    expect(await processor(new File(['test'], 'test.docx'), new AbortController().signal)).toBeNull();
    expect(rebuild).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes without rebuilding when review is cancelled', async () => {
    const rebuild = vi.fn(), close = vi.fn();
    const processor = createDocxProcessor({ detector, review: async () => ({ status: 'cancelled' }),
      openDocx: async () => ({ segments: [{ id: 'arbitrary', text: '김민수' }], rebuild, close }) });
    expect(await processor(new File(['test'], 'test.docx'), new AbortController().signal)).toBeNull();
    expect(rebuild).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('cancels a pending review and ignores its late approval', async () => {
    const controller = new AbortController();
    let resolve!: (decision: AlertReviewDecision) => void;
    let started!: () => void;
    const ready = new Promise<void>((r) => { started = r; });
    const rebuild = vi.fn(), close = vi.fn();
    const processor = createDocxProcessor({ detector,
      review: (_request, { signal }) => {
        expect(signal).toBe(controller.signal);
        started();
        return new Promise((r) => { resolve = r; });
      }, openDocx: async () => ({ segments: [], rebuild, close }) });
    const pending = processor(new File(['test'], 'test.docx'), controller.signal);
    await ready;
    controller.abort();
    expect(await pending).toBeNull();
    resolve({ status: 'approved', autoMask: [], confirm: { masking: [], nonMasking: [] } });
    await Promise.resolve();
    expect(rebuild).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
