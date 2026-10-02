import type { HwpxLimits, HwpxSession } from './types';
import type { SegmentMasks } from '../shared/types';

let session: HwpxSession | undefined;
const signal = new AbortController().signal;
self.onmessage = async (event: MessageEvent<{ kind: 'open'; bytes: ArrayBuffer; limits: HwpxLimits } | { kind: 'rebuild'; masks: SegmentMasks[] }>) => {
  try {
    if (event.data.kind === 'open') {
      const { openHwpx } = await import('./engine');
      session = await openHwpx(event.data.bytes, event.data.limits, signal);
      self.postMessage({ kind: 'opened', segments: session.segments });
    } else {
      if (!session) throw new Error('HWPX worker session is not ready');
      const bytes = await session.rebuild(event.data.masks, signal);
      self.postMessage({ kind: 'rebuilt', bytes }, { transfer: [bytes.buffer] });
      session.close(); session = undefined;
    }
  } catch (error) {
    session?.close(); session = undefined;
    self.postMessage({ kind: 'error', message: error instanceof Error ? error.message : 'HWPX processing failed' });
  }
};
