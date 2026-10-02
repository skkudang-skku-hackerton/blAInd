import type { TextSegment } from '../../../core/api/types';
import type { OpenDocx } from './types';

type WorkerReply =
  | { kind: 'opened'; segments: TextSegment[] }
  | { kind: 'rebuilt'; bytes: Uint8Array<ArrayBuffer> }
  | { kind: 'error'; message: string };

/** One worker per document: cancellation cannot interrupt another document or the detector. */
export const openDocxInWorker: OpenDocx = async (bytes, limits, signal) => {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  let pending: { resolve(value: WorkerReply): void; reject(error: Error): void } | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', close);
    worker.terminate();
    pending?.reject(new DOMException('DOCX processing cancelled', 'AbortError'));
    pending = undefined;
  };
  signal.addEventListener('abort', close, { once: true });
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    if (event.data.kind === 'error') pending?.reject(new Error(event.data.message));
    else pending?.resolve(event.data);
    pending = undefined;
  };
  worker.onerror = (event) => {
    pending?.reject(new Error(event.message || 'DOCX worker failed'));
    pending = undefined;
    close();
  };
  worker.onmessageerror = () => {
    pending?.reject(new Error('Invalid DOCX worker response'));
    pending = undefined;
    close();
  };
  const call = (message: object, transfer: Transferable[] = []): Promise<WorkerReply> => new Promise((resolve, reject) => {
    if (closed || signal.aborted) { reject(new DOMException('DOCX processing cancelled', 'AbortError')); return; }
    if (pending) { reject(new Error('Concurrent DOCX worker operation')); return; }
    pending = { resolve, reject };
    try { worker.postMessage(message, transfer); }
    catch (error) { pending = undefined; reject(error); }
  });
  try {
    const opened = await call({ kind: 'open', bytes, limits }, [bytes]);
    if (opened.kind !== 'opened') throw new Error('Unexpected DOCX worker response');
    return {
      segments: opened.segments,
      close,
      async rebuild(masks, rebuildSignal) {
        rebuildSignal.throwIfAborted();
        rebuildSignal.addEventListener('abort', close, { once: true });
        try {
          const result = await call({ kind: 'rebuild', masks });
          if (result.kind !== 'rebuilt') throw new Error('Unexpected DOCX worker response');
          rebuildSignal.throwIfAborted();
          return result.bytes;
        } finally { rebuildSignal.removeEventListener('abort', close); }
      },
    };
  } catch (error) { close(); throw error; }
};
