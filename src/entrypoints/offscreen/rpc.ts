import { PiiError } from '../../core/api/errors';
import type { PiiDetectorStatus } from '../../core/api/types';
import { cancelMessage, errorResponse, isRecord, isStatusMessage, requestKey, requestTimeout, scopedResponse, validateResponse,
  type PiiRequest, type PiiResponse } from '../../shared/messaging/types';

export interface InferenceWorker {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: any) => void): void;
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: any) => void): void;
}
export interface WorkerRpcOptions {
  createWorker: () => InferenceWorker;
  requestTimeoutMs?: number;
  onStatus?: (status: PiiDetectorStatus) => void;
}

export function createWorkerRpc(options: WorkerRpcOptions) {
  const timeout = requestTimeout(options.requestTimeoutMs);
  let worker: InferenceWorker | undefined;
  let disposed = false;
  const pending = new Map<string, { request: PiiRequest; resolve: (response: PiiResponse) => void;
    timer: ReturnType<typeof setTimeout>; cleanup: () => void }>();
  function report(status: PiiDetectorStatus) {
    try { options.onStatus?.(status); } catch { /* Status consumers do not own RPC. */ }
  }
  function stop(error: PiiError) {
    if (worker) {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onCrash);
      worker.removeEventListener('messageerror', onCrash);
      worker.terminate();
      worker = undefined;
    }
    for (const { request, resolve, timer, cleanup } of pending.values()) {
      clearTimeout(timer);
      cleanup();
      resolve(scopedResponse(request, errorResponse(request.requestId, error)));
    }
    pending.clear();
  }
  function onCrash(event: { preventDefault?: () => void }) {
    event.preventDefault?.();
    stop(new PiiError('INFERENCE_FAILED', 'PII inference worker crashed.'));
    report({ state: 'error', message: 'PII inference worker crashed.' });
  }
  function onMessage(event: { data: unknown }) {
    if (isStatusMessage(event.data, 'background')) { report(event.data.status); return; }
    if (!isRecord(event.data) || typeof event.data.requestId !== 'string' || typeof event.data.clientId !== 'string') return;
    const key = requestKey(event.data as unknown as PiiRequest);
    const entry = pending.get(key);
    if (!entry) return; // Late response from a timed-out request.
    clearTimeout(entry.timer);
    entry.cleanup();
    pending.delete(key);
    try { entry.resolve(validateResponse(event.data, entry.request)); }
    catch (error) { entry.resolve(scopedResponse(entry.request, errorResponse(entry.request.requestId, error))); }
  }
  function getWorker() {
    if (!worker) {
      worker = options.createWorker();
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onCrash);
      worker.addEventListener('messageerror', onCrash);
    }
    return worker;
  }
  return {
    request(request: PiiRequest, signal?: AbortSignal): Promise<PiiResponse> {
      const key = requestKey(request);
      const fail = (error: unknown) => scopedResponse(request, errorResponse(request.requestId, error));
      if (disposed) return Promise.resolve(fail(
        new PiiError('MODEL_NOT_READY', 'PII worker host is disposed.')));
      if (request.type === 'pii:init') signal = undefined;
      if (signal?.aborted) return Promise.resolve(fail(new PiiError('CANCELLED', 'PII scan cancelled.')));
      if (pending.has(key)) return Promise.resolve(fail(
        new PiiError('INVALID_INPUT', 'Duplicate PII request ID.')));
      let deadline: number;
      try { deadline = requestTimeout(request.requestTimeoutMs ?? timeout); }
      catch (error) { return Promise.resolve(fail(error)); }
      return new Promise(resolve => {
        let dispatchedWorker: InferenceWorker | undefined;
        const onAbort = () => {
          const entry = pending.get(key);
          if (!entry) return;
          clearTimeout(entry.timer);
          entry.cleanup();
          pending.delete(key);
          resolve(fail(new PiiError('CANCELLED', 'PII scan cancelled.')));
          const destination = dispatchedWorker;
          if (destination) void Promise.resolve().then(() => {
            if (worker === destination) destination.postMessage({ ...cancelMessage(request), target: 'worker' });
          }).catch(() => undefined);
        };
        const timer = setTimeout(() => {
          // An unresponsive worker cannot safely accept subsequent work. Replace it on retry.
          stop(new PiiError('INFERENCE_FAILED', 'PII inference worker timed out.'));
          report({ state: 'error', message: 'PII inference worker timed out.' });
        }, deadline);
        pending.set(key, { request, resolve, timer, cleanup: () => signal?.removeEventListener('abort', onAbort) });
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) { onAbort(); return; }
        if (!pending.has(key)) return;
        try {
          const destination = getWorker();
          if (signal?.aborted || !pending.has(key)) { onAbort(); return; }
          dispatchedWorker = destination;
          destination.postMessage({ ...request, target: 'worker' });
        }
        catch {
          stop(new PiiError('MODEL_LOAD_FAILED', 'Could not start the PII inference worker.'));
        }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop(new PiiError('MODEL_NOT_READY', 'PII worker host is disposed.'));
    },
  };
}
