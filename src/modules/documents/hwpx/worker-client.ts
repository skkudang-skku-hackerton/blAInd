import type { TextSegment } from '../../../core/api/types';
import type { OpenHwpx } from './types';
import type { SegmentMasks } from '../shared/types';

type Reply = { kind: 'opened'; segments: TextSegment[] } | { kind: 'rebuilt'; bytes: Uint8Array<ArrayBuffer> } | { kind: 'error'; message: string };
export const openHwpxInWorker: OpenHwpx = async (bytes, limits, signal) => {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  let pending: { resolve(reply: Reply): void; reject(error: Error): void } | undefined;
  let closed = false;
  const close = () => { if (!closed) { closed = true; signal.removeEventListener('abort', close); worker.terminate(); pending?.reject(new DOMException('HWPX processing cancelled', 'AbortError')); pending = undefined; } };
  signal.addEventListener('abort', close, { once: true });
  worker.onmessage = (event: MessageEvent<Reply>) => { const current = pending; pending = undefined; if (!current) return; event.data.kind === 'error' ? current.reject(new Error(event.data.message)) : current.resolve(event.data); };
  worker.onerror = (event) => { pending?.reject(new Error(event.message || 'HWPX worker failed')); pending = undefined; close(); };
  const call = (message: object, transfer: Transferable[] = []) => new Promise<Reply>((resolve, reject) => {
    if (closed || signal.aborted) return reject(new DOMException('HWPX processing cancelled', 'AbortError'));
    pending = { resolve, reject };
    try { worker.postMessage(message, transfer); } catch (error) { pending = undefined; reject(error); }
  });
  try {
    const opened = await call({ kind: 'open', bytes, limits }, [bytes]);
    if (opened.kind !== 'opened') throw new Error('Unexpected HWPX worker response');
    return {
      segments: opened.segments, close,
      async rebuild(masks: SegmentMasks[], rebuildSignal) {
        rebuildSignal.throwIfAborted();
        const abort = () => close(); rebuildSignal.addEventListener('abort', abort, { once: true });
        try { const result = await call({ kind: 'rebuild', masks }); if (result.kind !== 'rebuilt') throw new Error('Unexpected HWPX worker response'); rebuildSignal.throwIfAborted(); return result.bytes; }
        finally { rebuildSignal.removeEventListener('abort', abort); }
      },
    };
  } catch (error) { close(); throw error; }
};
