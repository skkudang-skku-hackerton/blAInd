import type { OpenPdf, PageMasks, PdfLimits, PdfSession } from '../../modules/documents/pdf/types';
import { DEFAULT_LIMITS } from '../../modules/documents/pdf/types';
import { abortable } from '../../modules/documents/pdf/processor';

export const PDF_CHANNEL = 'blaind:pdf-session';
const CHUNK = 256 * 1024;
export type PdfOperation =
  | { op: 'open'; data: string; limits: PdfLimits }
  | { op: 'rebuild'; masks: PageMasks[] }
  | { op: 'read'; offset: number }
  | { op: 'close' };
export type PdfRequest = PdfOperation & { channel: typeof PDF_CHANNEL; target: 'background' | 'offscreen'; sessionId: string; owner?: string };
export type PdfReply = { ok: true; segments?: PdfSession['segments']; size?: number; data?: string } | { ok: false; error: string };

export function encodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function decodeBytes(data: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(data), char => char.charCodeAt(0));
}

/** Chrome runtime messages use JSON; output is read in chunks below its message limit. */
export function createRemotePdfOpener(send: (request: PdfRequest) => Promise<PdfReply>): OpenPdf {
  return async (bytes, limits, signal) => {
    const sessionId = crypto.randomUUID();
    let closed = false;
    const call = async (operation: PdfOperation) => {
      const reply = await send({ ...operation, channel: PDF_CHANNEL, target: 'background', sessionId });
      if (!reply?.ok) throw new Error(reply?.error ?? 'PDF 연결에 실패했습니다. 확장 프로그램을 새로고침해 주세요.');
      return reply;
    };
    const release = () => { void call({ op: 'close' }).catch(() => {}); };
    const close = () => {
      if (closed) return;
      closed = true;
      signal.removeEventListener('abort', close);
      release();
    };
    signal.throwIfAborted();
    signal.addEventListener('abort', close, { once: true });
    try {
      const opening = call({ op: 'open', data: encodeBytes(new Uint8Array(bytes)), limits });
      // Also release when cancellation overtakes offscreen creation/opening.
      void opening.then(() => { if (closed) release(); }, () => {});
      const opened = await abortable(opening, signal);
      if (!opened.segments) throw new Error('Invalid PDF extraction response');
      return {
        segments: opened.segments,
        close,
        async rebuild(masks, rebuildSignal) {
          if (closed) throw new Error('PDF session is closed');
          const result = await abortable(call({ op: 'rebuild', masks }), rebuildSignal);
          if (!Number.isInteger(result.size) || result.size! <= 0 || result.size! > limits.maxOutputBytes) throw new Error('Invalid PDF output size');
          const output = new Uint8Array(result.size!);
          for (let offset = 0; offset < output.length; offset += CHUNK) {
            rebuildSignal.throwIfAborted();
            const reply = await abortable(call({ op: 'read', offset }), rebuildSignal);
            const chunk = decodeBytes(reply.data ?? '');
            if (chunk.length !== Math.min(CHUNK, output.length - offset)) throw new Error('Incomplete PDF output');
            output.set(chunk, offset);
          }
          return output;
        },
      };
    } catch (error) { close(); throw error; }
  };
}

/** Only the offscreen page instantiates the WASM PDF worker. */
export function createPdfSessionHost(openPdf: OpenPdf) {
  type Entry = { controller: AbortController; session?: PdfSession; output?: Uint8Array<ArrayBuffer>; timer: ReturnType<typeof setTimeout>; busy: boolean };
  const sessions = new Map<string, Entry>();
  function close(key: string) {
    const entry = sessions.get(key);
    if (!entry) return;
    sessions.delete(key);
    clearTimeout(entry.timer);
    entry.controller.abort();
    entry.session?.close();
  }
  const touch = (key: string, entry: Entry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => close(key), 15 * 60_000);
  };
  return {
    async handle(request: PdfRequest): Promise<PdfReply> {
      if (!request.owner || typeof request.sessionId !== 'string' || request.sessionId.length > 100) return { ok: false, error: 'Invalid PDF owner' };
      const key = JSON.stringify([request.owner, request.sessionId]);
      try {
        if (request.op === 'close') { close(key); return { ok: true }; }
        if (request.op === 'open') {
          if (sessions.has(key) || sessions.size >= 4) throw new Error('동시에 처리할 PDF가 너무 많습니다. 파일을 하나씩 첨부해 주세요.');
          if (typeof request.data !== 'string' || request.data.length > Math.ceil(DEFAULT_LIMITS.maxInputBytes / 3) * 4) throw new Error('PDF 입력 크기 제한을 초과했습니다.');
          const limits = { ...DEFAULT_LIMITS };
          for (const name of Object.keys(limits) as (keyof PdfLimits)[]) {
            const value = request.limits?.[name];
            if (!Number.isFinite(value) || value <= 0 || value > limits[name]) throw new Error('Invalid PDF limits');
            limits[name] = value;
          }
          const bytes = decodeBytes(request.data);
          if (!bytes.length || bytes.length > limits.maxInputBytes) throw new Error('Invalid PDF size');
          const entry: Entry = { controller: new AbortController(), busy: true, timer: setTimeout(() => close(key), 15 * 60_000) };
          sessions.set(key, entry);
          const session = await openPdf(bytes.buffer, limits, entry.controller.signal);
          if (entry.controller.signal.aborted) { session.close(); throw new Error('PDF 처리가 취소되었습니다.'); }
          entry.session = session;
          entry.busy = false;
          touch(key, entry);
          return { ok: true, segments: session.segments };
        }
        const entry = sessions.get(key);
        if (!entry?.session || entry.busy) throw new Error('PDF 세션이 만료되었거나 처리 중입니다. 다시 첨부해 주세요.');
        touch(key, entry);
        if (request.op === 'rebuild') {
          entry.busy = true;
          entry.output = await entry.session.rebuild(request.masks, entry.controller.signal);
          entry.busy = false;
          if (entry.controller.signal.aborted || entry.output.length > DEFAULT_LIMITS.maxOutputBytes) throw new Error('PDF output unavailable');
          return { ok: true, size: entry.output.length };
        }
        if (request.op === 'read' && entry.output && Number.isInteger(request.offset) && request.offset >= 0 && request.offset < entry.output.length) {
          return { ok: true, data: encodeBytes(entry.output.subarray(request.offset, request.offset + CHUNK)) };
        }
        throw new Error('Invalid PDF request');
      } catch {
        close(key);
        return { ok: false, error: 'PDF 처리에 실패했습니다. 텍스트만 포함된 PDF인지, 크기가 25MB 이하인지 확인해 주세요.' };
      }
    },
    dispose() { for (const key of sessions.keys()) close(key); },
  };
}
