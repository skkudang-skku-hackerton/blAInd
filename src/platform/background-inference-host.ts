import { createInferenceWorker } from '../shared/create-inference-worker';
import { createWorkerRpc } from '../entrypoints/offscreen/rpc';
import type { PiiDetectorStatus } from '../core/api/types';

/** Browsers without an Offscreen API host the worker in their background page. */
export function createBackgroundInferenceRpc(onStatus: (status: PiiDetectorStatus) => void) {
  return createWorkerRpc({ createWorker: createInferenceWorker, onStatus });
}
