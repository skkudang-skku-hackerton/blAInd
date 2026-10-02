import * as mupdf from 'mupdf';
import type { OpenPdf, PageMasks, PdfLimits, Span } from './types';

interface Glyph {
  char: string;
  start: number;
  end: number;
  origin: mupdf.Point;
  box: mupdf.Rect;
  size: number;
}
interface ExtractedPage {
  id: string;
  text: string;
  bounds: mupdf.Rect;
  glyphs: Glyph[];
}
const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;
const compact = (text: string) => text.replace(/\s/gu, '');

function extract(document: mupdf.Document, limits: PdfLimits): ExtractedPage[] {
  const count = document.countPages();
  if (!count || count > limits.maxPages) throw new Error('Unsupported PDF page count');
  const pages: ExtractedPage[] = [];
  let characters = 0;
  for (let index = 0; index < count; index++) {
    const page = document.loadPage(index);
    try {
      const bounds = page.getBounds();
      const [x0, y0, x1, y1] = bounds;
      if (!bounds.every(Number.isFinite) || x1 <= x0 || y1 <= y0 ||
          Math.ceil((x1 - x0) * limits.scale) * Math.ceil((y1 - y0) * limits.scale) > limits.maxPixelsPerPage) {
        throw new Error('Unsupported PDF page dimensions');
      }
      const structured = page.toStructuredText('preserve-images');
      let text = '';
      let hasImage = false;
      let unsupportedDirection = false;
      const glyphs: Glyph[] = [];
      try {
        structured.walk({
          onImageBlock(_box, _transform, image) { hasImage = true; image.destroy(); },
          beginLine(_box, wmode, direction) {
            // Initial implementation supports horizontal, left-to-right layout only.
            if (wmode !== 0 || Math.abs(direction[0] - 1) > 0.001 || Math.abs(direction[1]) > 0.001) {
              unsupportedDirection = true;
            }
          },
          onChar(char, origin, font, size, quad) {
            try {
              if (char.includes('\uFFFD') || char.includes('\0')) throw new Error('Unreliable PDF text encoding');
              const xs = [quad[0], quad[2], quad[4], quad[6]];
              const ys = [quad[1], quad[3], quad[5], quad[7]];
              const box: mupdf.Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
              if (![...box, ...origin, size].every(Number.isFinite) || size <= 0) throw new Error('Invalid glyph geometry');
              glyphs.push({ char, start: text.length, end: text.length + char.length,
                origin: [...origin], box, size });
              text += char;
            } finally { font.destroy(); }
          },
          endLine() { text += '\n'; },
        });
      } finally { structured.destroy(); }
      // Without OCR, neither scanned pages nor embedded images can be certified inspected.
      if (hasImage || !text.trim() || unsupportedDirection) {
        throw new Error('PDF requires OCR or unsupported text layout');
      }
      characters += text.length;
      if (characters > limits.maxCharacters) throw new Error('PDF text size limit exceeded');
      pages.push({ id: `page-${index + 1}`, text, bounds, glyphs });
    } finally { page.destroy(); }
  }
  return pages;
}

function applyPixelMasks(pixmap: mupdf.Pixmap, glyphs: Glyph[], scale: number): void {
  const pixels = pixmap.getPixels();
  const width = pixmap.getWidth(), height = pixmap.getHeight();
  const stride = pixmap.getStride(), components = pixmap.getNumberOfComponents();
  for (const { box } of glyphs) {
    const left = Math.max(0, Math.floor(box[0] * scale) - pixmap.getX() - 1);
    const top = Math.max(0, Math.floor(box[1] * scale) - pixmap.getY() - 1);
    const right = Math.min(width, Math.ceil(box[2] * scale) - pixmap.getX() + 1);
    const bottom = Math.min(height, Math.ceil(box[3] * scale) - pixmap.getY() + 1);
    if (left >= right || top >= bottom) throw new Error('Mask is outside rendered page');
    for (let y = top; y < bottom; y++) pixels.fill(0, y * stride + left * components, y * stride + right * components);
  }
}

function maskGlyphs(page: ExtractedPage, spans: Span[], scale: number): Set<Glyph> {
  const removed = new Set(page.glyphs.filter((glyph) => spans.some((span) => overlaps(glyph, span))));
  for (const span of spans) {
    if (!page.glyphs.some((glyph) => overlaps(glyph, span))) throw new Error('Unmapped masking span');
  }
  // Reject ambiguous/overprinted glyphs instead of destroying unselected content.
  for (const mask of removed) {
    const box = mask.box;
    for (const kept of page.glyphs) {
      if (removed.has(kept) || !kept.char.trim()) continue;
      const b = kept.box;
      // Ignore the one-pixel antialias padding here; it may touch adjacent whitespace.
      if (Math.min(box[2], b[2]) - Math.max(box[0], b[0]) > 1 / scale &&
          Math.min(box[3], b[3]) - Math.max(box[1], b[1]) > 1 / scale) {
        throw new Error('Ambiguous overlapping glyphs');
      }
    }
  }
  return removed;
}

function validate(bytes: Uint8Array, expected: string[], limits: PdfLimits): void {
  if (bytes.byteLength > limits.maxOutputBytes) throw new Error('PDF output size limit exceeded');
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  try {
    if (doc.countPages() !== expected.length) throw new Error('Output page count mismatch');
    for (let index = 0; index < expected.length; index++) {
      const page = doc.loadPage(index);
      try {
        const text = page.toStructuredText('');
        try {
          if (compact(text.asText()) !== compact(expected[index]!)) throw new Error('Output text verification failed');
        } finally { text.destroy(); }
      } finally { page.destroy(); }
    }
  } finally { doc.destroy(); }
}

/** Runs inside a dedicated Worker in production; exported for real-PDF tests. */
export const openPdf: OpenPdf = async (bytes, limits, signal) => {
  signal.throwIfAborted();
  if (bytes.byteLength > limits.maxInputBytes ||
      !new TextDecoder().decode(new Uint8Array(bytes, 0, Math.min(1024, bytes.byteLength))).includes('%PDF-')) {
    throw new Error('Invalid PDF input');
  }
  const document = mupdf.Document.openDocument(bytes, 'application/pdf');
  let pages: ExtractedPage[];
  try {
    if (!document.isPDF() || document.needsPassword()) throw new Error('Encrypted or unsupported document');
    pages = extract(document, limits);
  } catch (error) { document.destroy(); throw error; }
  let closed = false;
  return {
    segments: pages.map(({ id, text }) => ({ id, text })),
    close() { if (!closed) { closed = true; document.destroy(); } },
    async rebuild(masks: PageMasks[], rebuildSignal) {
      rebuildSignal.throwIfAborted();
      if (closed) throw new Error('PDF session closed');
      if (masks.length !== pages.length || new Set(masks.map((m) => m.segmentId)).size !== pages.length) {
        throw new Error('Invalid page masks');
      }
      const buffer = new mupdf.Buffer();
      const writer = new mupdf.DocumentWriter(buffer, 'pdf', 'compress');
      // MuPDF bundles a CJK font, avoiding source font objects and external downloads.
      const font = new mupdf.Font('ko');
      const expected: string[] = [];
      try {
        for (let index = 0; index < pages.length; index++) {
          rebuildSignal.throwIfAborted();
          const data = pages[index]!;
          const spans = masks.find((mask) => mask.segmentId === data.id)?.spans;
          if (!spans) throw new Error('Missing page masks');
          for (const span of spans) {
            if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 ||
                span.end <= span.start || span.end > data.text.length) throw new Error('Invalid mask span');
          }
          const removed = maskGlyphs(data, spans, limits.scale);
          const source = document.loadPage(index);
          let pixmap: mupdf.Pixmap | undefined;
          let image: mupdf.Image | undefined;
          let device: mupdf.Device | undefined;
          const hidden = new mupdf.Text();
          try {
            // Do not render uninspected annotations/widgets into the raster output.
            pixmap = source.toPixmap(mupdf.Matrix.scale(limits.scale, limits.scale), mupdf.ColorSpace.DeviceRGB, false, false);
            applyPixelMasks(pixmap, [...removed], limits.scale);
            image = new mupdf.Image(pixmap);
            const [x0, y0, x1, y1] = data.bounds;
            device = writer.beginPage([0, 0, x1 - x0, y1 - y0]);
            device.fillImage(image, [x1 - x0, 0, 0, y1 - y0, 0, 0], 1);
            let safeText = '';
            for (const glyph of data.glyphs) {
              if (removed.has(glyph)) continue;
              const codepoint = glyph.char.codePointAt(0)!;
              const gid = font.encodeCharacter(codepoint);
              if (!gid && glyph.char.trim()) throw new Error('Unsupported output font character');
              hidden.showGlyph(font, [glyph.size, 0, 0, -glyph.size,
                glyph.origin[0] - x0, glyph.origin[1] - y0], gid, codepoint);
              safeText += glyph.char;
            }
            device.ignoreText(hidden, mupdf.Matrix.identity);
            device.close();
            writer.endPage();
            expected.push(safeText);
          } finally {
            device?.destroy(); hidden.destroy(); image?.destroy(); pixmap?.destroy(); source.destroy();
          }
          if (buffer.length > limits.maxOutputBytes) throw new Error('PDF output size limit exceeded');
        }
        writer.close();
        const result = new Uint8Array(buffer.asUint8Array());
        validate(result, expected, limits);
        rebuildSignal.throwIfAborted();
        return result;
      } finally { font.destroy(); writer.destroy(); buffer.destroy(); }
    },
  };
};
