/** Shared URL ensures WXT emits a single packaged inference worker for every host. */
export function createInferenceWorker(): Worker {
  return new Worker(new URL('../entrypoints/offscreen/inference.worker.ts', import.meta.url), { type: 'module' });
}
