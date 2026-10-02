import type { PageMasks, PdfLimits, PdfSession } from './types';

let session: PdfSession | undefined;
const signal = new AbortController().signal;
self.onmessage = async (event: MessageEvent<
  | { kind: 'open'; bytes: ArrayBuffer; limits: PdfLimits }
  | { kind: 'rebuild'; masks: PageMasks[] }
>) => {
  try {
    if (event.data.kind === 'open') {
      // Install the message listener before awaiting WASM initialization, otherwise the
      // first message can arrive while the module's top-level await is still pending.
      const { openPdf } = await import('./engine');
      session = await openPdf(event.data.bytes, event.data.limits, signal);
      self.postMessage({ kind: 'opened', segments: session.segments });
    } else {
      if (!session) throw new Error('PDF session not ready');
      const bytes = await session.rebuild(event.data.masks, signal);
      self.postMessage({ kind: 'rebuilt', bytes }, { transfer: [bytes.buffer] });
      session.close();
      session = undefined;
    }
  } catch (error) {
    session?.close();
    session = undefined;
    self.postMessage({ kind: 'error', message: error instanceof Error ? error.message : 'PDF processing failed' });
  }
};
