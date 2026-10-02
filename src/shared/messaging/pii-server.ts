import type { PiiDetectorApi } from '../../core/api/pii-detector';
import { PiiError } from '../../core/api/errors';
import { DEFAULT_REQUEST_TIMEOUT_MS, errorResponse, isCancelMessage, isPiiRequest, ownsSender,
  PII_CHANNEL, requestKey, scopedResponse, senderOwnershipKey,
  type MessageListener, type MessagingRuntime, type PiiCancelMessage, type PiiRequest,
  type PiiResponse, type PiiTarget } from './types';

export function cancelledError(): PiiError { return new PiiError('CANCELLED', 'PII scan cancelled.'); }
function waitForInitialization(initialization: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(cancelledError()); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    void initialization.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
  });
}
export interface CancellableRequestHandler {
  (request: PiiRequest): Promise<PiiResponse>;
  cancel(message: PiiCancelMessage): void;
  dispose(): void;
}

/** Register before executing: cancellation can arrive during setup or any awaited hop.
 * Only bounded identity metadata is retained for out-of-order messages, never scan text.
 */
export function createCancellableRequestHandler(
  execute: (request: PiiRequest, signal?: AbortSignal) => Promise<PiiResponse>,
): CancellableRequestHandler {
  const pending = new Map<string, { cancel: () => void; dispose: () => void }>();
  const history = new Map<string, { cancelled: boolean; expires: number }>();
  let disposed = false;
  function remember(key: string, cancelled: boolean) {
    const now = Date.now();
    for (const [id, state] of history) if (state.expires <= now) history.delete(id);
    history.delete(key);
    history.set(key, { cancelled, expires: now + DEFAULT_REQUEST_TIMEOUT_MS });
    while (history.size > 512) history.delete(history.keys().next().value!);
  }
  const handler = ((request: PiiRequest): Promise<PiiResponse> => {
    const key = requestKey(request);
    const fail = (error: unknown) => scopedResponse(request, errorResponse(request.requestId, error));
    if (disposed) return Promise.resolve(fail(new PiiError('MODEL_NOT_READY', 'PII service is disposed.')));
    if (pending.has(key)) return Promise.resolve(fail(new PiiError('INVALID_INPUT', 'Duplicate PII request ID.')));
    const prior = history.get(key);
    if (prior && prior.expires <= Date.now()) history.delete(key);
    else if (prior?.cancelled && request.type !== 'pii:init') {
      remember(key, false);
      return Promise.resolve(fail(cancelledError()));
    }
    return new Promise(resolve => {
      const controller = new AbortController();
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (response: PiiResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(key);
        remember(key, false);
        resolve(scopedResponse(request, response));
      };
      const cancel = () => {
        if (settled || request.type === 'pii:init') return;
        // Settle before notifying downstream so a synchronous late result cannot win.
        finish(fail(cancelledError()));
        controller.abort();
      };
      pending.set(key, { cancel, dispose: () => {
        finish(fail(new PiiError('MODEL_NOT_READY', 'PII service is disposed.')));
        controller.abort();
      } });
      timer = setTimeout(() => {
        finish(fail(new PiiError('INFERENCE_FAILED', 'PII request timed out.')));
        if (request.type !== 'pii:init') controller.abort();
      }, request.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      try {
        // Do not defer registration/execution to a microtask: scan and cancel may be adjacent messages.
        void execute(request, request.type === 'pii:init' ? undefined : controller.signal)
          .then(finish, error => finish(fail(error)));
      } catch (error) { finish(fail(error)); }
    });
  }) as CancellableRequestHandler;
  handler.cancel = message => {
    if (disposed) return;
    const key = requestKey(message);
    const entry = pending.get(key);
    if (entry) entry.cancel();
    else {
      const prior = history.get(key);
      if (!prior || prior.expires <= Date.now()) remember(key, true);
    }
  };
  handler.dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const entry of pending.values()) entry.dispose();
    history.clear();
  };
  return handler;
}

/** Worker-side scheduler: cancelled queued jobs are physically removed before inference. */
export function createPiiRequestHandler(detector: PiiDetectorApi): CancellableRequestHandler {
  let initialization: Promise<void> | undefined;
  function initialize() {
    if (!initialization) initialization = Promise.resolve().then(() => detector.initialize()).catch(error => {
      initialization = undefined;
      throw error;
    });
    return initialization;
  }
  type Job = { request: PiiRequest; signal: AbortSignal; run: () => Promise<void>; cancel: () => void };
  const queue: Job[] = [];
  let active: Job | undefined;
  function drain() {
    if (active || !queue.length) return;
    active = queue.shift()!;
    const job = active;
    void job.run().finally(() => { active = undefined; drain(); });
  }
  return createCancellableRequestHandler((request, signal) => {
    if (request.type === 'pii:init') return initialize().then(() => ({
      channel: PII_CHANNEL, requestId: request.requestId, type: 'pii:ready',
    }), error => errorResponse(request.requestId, error, 'MODEL_LOAD_FAILED'));
    return new Promise(resolve => {
      const job: Job = { request, signal: signal!, cancel: () => {
        const index = queue.indexOf(job);
        if (index < 0) return;
        queue.splice(index, 1);
        signal!.removeEventListener('abort', job.cancel);
        resolve(errorResponse(request.requestId, cancelledError()));
      }, run: async () => {
        try {
          if (signal!.aborted) throw cancelledError();
          await waitForInitialization(initialize(), signal!);
          if (signal!.aborted) throw cancelledError();
          const options = { signal };
          const result = request.type === 'pii:scan-text'
            ? await detector.scanText(request.text, options) : await detector.scanSegments(request.segments, options);
          if (signal!.aborted) throw cancelledError();
          resolve({ channel: PII_CHANNEL, requestId: request.requestId, type: 'pii:result', result });
        } catch (error) { resolve(errorResponse(request.requestId, error)); }
        finally { signal!.removeEventListener('abort', job.cancel); }
      } };
      signal!.addEventListener('abort', job.cancel, { once: true });
      queue.push(job);
      if (signal!.aborted) job.cancel();
      drain();
    });
  });
}

/** Callback + true keeps Chrome's channel open without claiming other targets. */
export function installPiiServer(runtime: MessagingRuntime, target: PiiTarget,
  handle: (request: PiiRequest, signal?: AbortSignal) => Promise<PiiResponse>): () => void {
  const dispatch = createCancellableRequestHandler(handle);
  const listener: MessageListener = (message, sender, respond) => {
    if (!isPiiRequest(message, target) && !isCancelMessage(message, target)) return;
    if (!ownsSender(runtime, sender)) return;
    if (target === 'offscreen' && (message.ownerKey === undefined || sender.tab ||
      (sender.url && sender.url !== runtime.getURL('background.js')))) return;
    const owned = target === 'background' ? { ...message, ownerKey: senderOwnershipKey(sender) } : message;
    if (owned.type === 'pii:cancel') {
      dispatch.cancel(owned);
      respond({ channel: PII_CHANNEL, type: 'pii:cancelled', requestId: owned.requestId, clientId: owned.clientId });
      return;
    }
    void dispatch(owned).then(respond);
    return true;
  };
  runtime.onMessage.addListener(listener);
  return () => { runtime.onMessage.removeListener(listener); dispatch.dispose(); };
}
