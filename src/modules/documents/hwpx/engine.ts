import { DOMParser, XMLSerializer, type Document, type Element, type Node } from '@xmldom/xmldom';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { TextSegment } from '../../../core/api/types';
import type { SegmentMasks, Span } from '../shared/types';
import type { HwpxLimits, HwpxSession, OpenHwpx } from './types';

const HWP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const MIME = 'application/hwp+zip';
type XmlDocument = Document & { documentElement: Element };
type Paragraph = { id: string; text: string; pieces: Array<{ node: Node; start: number; end: number }> };
const fail = (message: string): never => { throw new Error(`HWPX: ${message}`); };

function parse(bytes: Uint8Array, path: string): XmlDocument {
  let invalid = false;
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(source)) fail(`unsupported XML declaration in ${path}`);
  const document = new DOMParser({ onError: () => { invalid = true; } }).parseFromString(source, 'application/xml');
  if (invalid || !document.documentElement) fail(`invalid XML in ${path}`);
  return document as XmlDocument;
}

function descendants(node: Node, localName: string, namespace = HWP): Element[] {
  const output: Element[] = [], stack: Node[] = [node];
  while (stack.length) {
    const current = stack.pop()!;
    for (let child = current.lastChild; child; child = child.previousSibling) {
      if (child.nodeType === 1) {
        if ((child as Element).localName === localName && (child as Element).namespaceURI === namespace) output.push(child as Element);
        stack.push(child);
      }
    }
  }
  return output;
}

function paragraphRecords(path: string, document: XmlDocument): Paragraph[] {
  const output: Paragraph[] = [];
  for (const paragraph of descendants(document, 'p')) {
    const pieces: Paragraph['pieces'] = [];
    let text = '';
    for (const textNode of descendants(paragraph, 't')) {
      const value = textNode.textContent ?? '';
      if (!value) continue;
      pieces.push({ node: textNode, start: text.length, end: text.length + value.length });
      text += value;
    }
    if (text) output.push({ id: `hwpx:${path}:p${output.length}`, text, pieces });
  }
  return output;
}

function replaceText(node: Node, value: string): void {
  while (node.firstChild) node.removeChild(node.firstChild);
  if (value) node.appendChild(node.ownerDocument!.createTextNode(value));
}

function maskText(text: string, spans: Span[]): string {
  const masked = Array.from({ length: text.length }, (_, index) => text[index]!);
  for (const { start, end } of spans) for (let index = start; index < end; index++) masked[index] = '█';
  return masked.join('');
}

export const openHwpx: OpenHwpx = async (bytes, limits, signal) => {
  signal.throwIfAborted();
  if (bytes.byteLength > limits.maxInputBytes || bytes.byteLength < 4) fail('input size limit exceeded');
  const archive = unzipSync(new Uint8Array(bytes), { filter: (file) => {
    if (file.name.startsWith('/') || file.name.split('/').some((part) => part === '..')) fail('unsafe ZIP path');
    return true;
  } });
  const names = Object.keys(archive);
  if (names.length > limits.maxEntries) fail('ZIP entry limit exceeded');
  const expanded = names.reduce((sum, name) => sum + archive[name]!.byteLength, 0);
  if (expanded > limits.maxUncompressedBytes) fail('expanded ZIP size limit exceeded');
  const mimetype = archive.mimetype && strFromU8(archive.mimetype).trim();
  if (mimetype !== MIME) fail('not an HWPX package');
  const sectionNames = names.filter((name) => /^Contents\/section\d+\.xml$/i.test(name)).sort((a, b) =>
    Number(a.match(/section(\d+)/i)![1]) - Number(b.match(/section(\d+)/i)![1]));
  if (!sectionNames.length) fail('no supported section XML');
  const parts = new Map<string, { document: XmlDocument; paragraphs: Paragraph[] }>();
  let paragraphs: Paragraph[] = [], characterCount = 0;
  for (const name of sectionNames) {
    signal.throwIfAborted();
    const document = parse(archive[name]!, name);
    const records = paragraphRecords(name, document);
    paragraphs.push(...records);
    parts.set(name, { document, paragraphs: records });
    characterCount += records.reduce((sum, item) => sum + item.text.length, 0);
    if (paragraphs.length > limits.maxParagraphs || characterCount > limits.maxCharacters) fail('document text limit exceeded');
  }
  if (!paragraphs.length) fail('no supported paragraph text');
  let closed = false;
  const segments: TextSegment[] = paragraphs.map(({ id, text }) => ({ id, text }));
  return {
    segments,
    close() { closed = true; },
    async rebuild(masks: SegmentMasks[], rebuildSignal) {
      rebuildSignal.throwIfAborted();
      if (closed) fail('session closed');
      if (masks.length !== segments.length || new Set(masks.map(({ segmentId }) => segmentId)).size !== segments.length) fail('invalid masks');
      const byId = new Map(masks.map((mask) => [mask.segmentId, mask.spans]));
      const expectedText = new Map<string, string>();
      for (const paragraph of paragraphs) {
        rebuildSignal.throwIfAborted();
        const spans = byId.get(paragraph.id);
        if (!spans) fail('missing paragraph masks');
        const validSpans = spans!;
        for (const span of validSpans) if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > paragraph.text.length) fail('invalid mask span');
        const redacted = maskText(paragraph.text, validSpans);
        expectedText.set(paragraph.id, redacted);
        for (const piece of paragraph.pieces) replaceText(piece.node, redacted.slice(piece.start, piece.end));
      }
      const outputParts: Record<string, Uint8Array> = {};
      for (const name of names) {
        rebuildSignal.throwIfAborted();
        const part = parts.get(name);
        outputParts[name] = part ? strToU8(new XMLSerializer().serializeToString(part.document)) : archive[name]!;
      }
      // HWPX packages expect the mimetype entry first and uncompressed.
      const orderedParts = Object.fromEntries([
        ['mimetype', outputParts.mimetype!],
        ...Object.entries(outputParts).filter(([name]) => name !== 'mimetype'),
      ]);
      const output = zipSync(orderedParts, { level: 0 });
      if (output.byteLength > limits.maxOutputBytes) fail('output size limit exceeded');
      // Re-open every supported section and ensure the new text matches the expected masked text.
      const rebuilt = unzipSync(output);
      for (const name of sectionNames) {
        const reopened = paragraphRecords(name, parse(rebuilt[name]!, name));
        const expected = parts.get(name)!.paragraphs;
        if (reopened.length !== expected.length || reopened.some((item, index) => item.text !== expectedText.get(expected[index]!.id))) fail('output verification failed');
      }
      rebuildSignal.throwIfAborted();
      return output;
    },
  };
};
