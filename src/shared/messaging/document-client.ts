import { browser } from 'wxt/browser';
import type { OpenPdf, PdfSession } from '../../modules/documents/pdf/types';
import type { OpenDocx } from '../../modules/documents/docx/types';
import { abortable } from '../../modules/documents/shared/abortable';
import { DocumentProcessingError, isDocumentErrorCode } from '../../modules/documents/shared/errors';

export const DOCUMENT_CHANNEL = 'blaind:documents';
export const CHUNK_BYTES = 512 * 1024;
export function encodeBytes(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export function decodeBytes(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), char => char.charCodeAt(0));
}

/** Chrome runtime uses JSON serialization. Transfer bounded binary chunks to the
 * extension offscreen host, where document Workers are independent of site CSP. */
function createDocumentOpener(kind: 'pdf' | 'docx'): (bytes: ArrayBuffer, limits: unknown, signal: AbortSignal) => Promise<PdfSession> {
  return async (bytes, _limits, signal) => {
    const sessionId = crypto.randomUUID();
    const send = async (op: string, payload: object = {}) => {
      const reply = await browser.runtime.sendMessage({ channel: DOCUMENT_CHANNEL,
        target: 'background', sessionId, kind, op, ...payload });
      if (!reply?.ok) throw new DocumentProcessingError(isDocumentErrorCode(reply?.code) ? reply.code : 'DOCUMENT_WORKER');
      return reply;
    };
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      signal.removeEventListener('abort', close);
      void send('close').catch(() => undefined);
    };
    const call = async (op: string, payload: object = {}) => {
      signal.throwIfAborted();
      return abortable(send(op, payload), signal);
    };
    signal.throwIfAborted();
    signal.addEventListener('abort', close, { once: true });
    try {
      await call('begin');
      const input = new Uint8Array(bytes);
      for (let offset = 0; offset < input.length; offset += CHUNK_BYTES) {
        await call('append', { data: encodeBytes(input.subarray(offset, offset + CHUNK_BYTES)) });
      }
      const opened = await call('open');
      return {
        segments: opened.segments,
        close,
        async rebuild(masks, rebuildSignal) {
          rebuildSignal.throwIfAborted();
          rebuildSignal.addEventListener('abort', close, { once: true });
          try {
            const result = await abortable(call('rebuild', { masks }), rebuildSignal);
            const output = new Uint8Array(result.size);
            for (let offset = 0; offset < output.length; offset += CHUNK_BYTES) {
              const chunk = await abortable(call('read', { offset }), rebuildSignal);
              output.set(decodeBytes(chunk.data), offset);
            }
            rebuildSignal.throwIfAborted();
            return output;
          } finally { rebuildSignal.removeEventListener('abort', close); }
        },
      };
    } catch (error) { close(); throw error; }
  };
}
export const openPdfOffscreen = createDocumentOpener('pdf') as OpenPdf;
export const openDocxOffscreen = createDocumentOpener('docx') as OpenDocx;
