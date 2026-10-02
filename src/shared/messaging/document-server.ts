import { DOCUMENT_CHANNEL, CHUNK_BYTES, decodeBytes, encodeBytes } from './document-client';
import { ownsSender, type MessagingRuntime, type MessageListener } from './types';
import { openPdfInWorker } from '../../modules/documents/pdf/worker-client';
import { openDocxInWorker } from '../../modules/documents/docx/worker-client';
import { DEFAULT_LIMITS as PDF_LIMITS, type PdfSession } from '../../modules/documents/pdf/types';
import { DEFAULT_LIMITS as DOCX_LIMITS } from '../../modules/documents/docx/types';
import { documentErrorCode } from '../../modules/documents/shared/errors';

export function installDocumentServer(runtime: MessagingRuntime): () => void {
  const sessions = new Map<string, { controller: AbortController; chunks: Uint8Array[];
    size: number; session?: PdfSession; output?: Uint8Array; timer: ReturnType<typeof setTimeout>; busy: boolean }>();
  const close = (key: string) => {
    const state = sessions.get(key);
    if (!state) return;
    sessions.delete(key);
    clearTimeout(state.timer);
    state.controller.abort();
    state.session?.close();
  };
  const listener: MessageListener = (message, sender, respond) => {
    const m = message as any;
    if (!ownsSender(runtime, sender) || sender.url !== runtime.getURL('background.js') ||
        m?.channel !== DOCUMENT_CHANNEL || m.target !== 'offscreen') return;
    const execute = async () => {
      if (typeof m.owner !== 'string' || typeof m.sessionId !== 'string' ||
          !['pdf', 'docx'].includes(m.kind)) throw new Error('Invalid document request');
      const key = JSON.stringify([m.owner, m.sessionId]);
      if (m.op === 'close') { close(key); return {}; }
      if (m.op === 'begin') {
        if (sessions.has(key) || sessions.size >= 8) throw new Error('Document session limit exceeded');
        sessions.set(key, { controller: new AbortController(), chunks: [], size: 0,
          timer: setTimeout(() => close(key), 10 * 60_000), busy: false });
        return {};
      }
      const state = sessions.get(key);
      if (!state || state.busy) throw new Error('Document session unavailable');
      state.busy = true;
      try {
        if (m.op === 'append') {
          if (state.session || typeof m.data !== 'string' || m.data.length > CHUNK_BYTES * 1.4) throw new Error('Invalid chunk');
          const chunk = decodeBytes(m.data);
          state.size += chunk.length;
          if (state.size > PDF_LIMITS.maxInputBytes) throw new Error('Document input size limit exceeded');
          state.chunks.push(chunk);
          return {};
        }
        if (m.op === 'open') {
          if (state.session || !state.size) throw new Error('Invalid document open');
          const bytes = new Uint8Array(state.size);
          let offset = 0;
          for (const chunk of state.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          state.chunks = [];
          state.session = m.kind === 'pdf'
            ? await openPdfInWorker(bytes.buffer, PDF_LIMITS, state.controller.signal)
            : await openDocxInWorker(bytes.buffer, DOCX_LIMITS, state.controller.signal);
          return { segments: state.session.segments };
        }
        if (m.op === 'rebuild' && state.session && !state.output) {
          state.output = await state.session.rebuild(m.masks, state.controller.signal);
          const limit = m.kind === 'pdf' ? PDF_LIMITS.maxOutputBytes : DOCX_LIMITS.maxOutputBytes;
          if (state.output.byteLength > limit) throw new Error('Document output size limit exceeded');
          return { size: state.output.byteLength };
        }
        if (m.op === 'read' && state.output && Number.isInteger(m.offset) && m.offset >= 0 && m.offset < state.output.length) {
          return { data: encodeBytes(state.output.subarray(m.offset, m.offset + CHUNK_BYTES)) };
        }
        throw new Error('Invalid document operation');
      } catch (error) { close(key); throw error; }
      finally { state.busy = false; }
    };
    void execute().then(result => respond({ ok: true, ...result }),
      error => {
        const code = documentErrorCode(error);
        console.error('[blAInd] Document host failed', { operation: m.op, kind: m.kind, code });
        respond({ ok: false, code });
      });
    return true;
  };
  runtime.onMessage.addListener(listener);
  return () => { runtime.onMessage.removeListener(listener); for (const key of sessions.keys()) close(key); };
}
