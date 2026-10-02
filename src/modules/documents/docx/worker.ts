import type { DocxLimits, DocxSession, SegmentMasks } from './types';

let session: DocxSession | undefined;
const signal = new AbortController().signal;
self.onmessage = async (event: MessageEvent<
  | { kind: 'open'; bytes: ArrayBuffer; limits: DocxLimits }
  | { kind: 'rebuild'; masks: SegmentMasks[] }
>) => {
  try {
    if (event.data.kind === 'open') {
      // Install the listener before loading the engine so the first message is not lost
      // while asynchronous module initialization is pending.
      const { openDocx } = await import('./engine');
      session = await openDocx(event.data.bytes, event.data.limits, signal);
      self.postMessage({ kind: 'opened', segments: session.segments });
    } else {
      if (!session) throw new Error('DOCX session not ready');
      const bytes = await session.rebuild(event.data.masks, signal);
      self.postMessage({ kind: 'rebuilt', bytes }, { transfer: [bytes.buffer] });
      session.close();
      session = undefined;
    }
  } catch (error) {
    session?.close();
    session = undefined;
    self.postMessage({ kind: 'error', message: error instanceof Error ? error.message : 'DOCX processing failed' });
  }
};
