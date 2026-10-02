import { createInferenceWorker } from '../shared/create-inference-worker';
import { createWorkerRpc } from '../entrypoints/offscreen/rpc';
import type { PiiDetectorStatus } from '../core/api/types';

/** Firefox MV2 has no Offscreen API; its persistent background page hosts the worker. */
export function createFirefoxInferenceRpc(onStatus: (status: PiiDetectorStatus) => void) {
  return createWorkerRpc({ createWorker: createInferenceWorker, onStatus });
}
