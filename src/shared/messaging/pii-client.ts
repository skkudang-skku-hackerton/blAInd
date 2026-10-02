import { browser } from 'wxt/browser';
import { PiiError } from '../../core/api/errors';
import type { PiiDetectorApi } from '../../core/api/pii-detector';
import type { Detection, PiiDetectorStatus, ScanOptions, SegmentDetectionResult } from '../../core/api/types';
import { cancelMessage, isSegments, isStatusMessage, ownsSender, PII_CHANNEL, requestTimeout, unwrapResponse,
  type MessageListener, type MessagingRuntime, type PiiRequest } from './types';

export interface PiiDetectorClient extends PiiDetectorApi {
  onStatus(listener: (status: PiiDetectorStatus) => void): () => void;
  /** Releases this client's listeners and pending calls, not the shared model. */
  dispose(): void;
}
export interface PiiDetectorClientOptions { requestTimeoutMs?: number; runtime?: MessagingRuntime }

export function createPiiDetectorClient(options: PiiDetectorClientOptions = {}): PiiDetectorClient {
  const runtime = options.runtime ?? browser.runtime as unknown as MessagingRuntime;
  const timeout = requestTimeout(options.requestTimeoutMs);
  // getRandomValues also works in content scripts on non-secure HTTP pages.
  const prefix = Array.from(crypto.getRandomValues(new Uint32Array(4)),
    word => word.toString(16).padStart(8, '0')).join('');
  let sequence = 0;
  let disposed = false;
  let initialization: Promise<void> | undefined;
  const pending = new Set<(error: PiiError) => void>();
  const listeners = new Set<(status: PiiDetectorStatus) => void>();
  const onMessage: MessageListener = (message, sender) => {
    if (!disposed && ownsSender(runtime, sender) && isStatusMessage(message, 'client')) {
      for (const listener of listeners) {
        try { listener(message.status); } catch { /* UI listeners cannot break transport. */ }
      }
    }
  };
  runtime.onMessage.addListener(onMessage);
  const nextRequestId = () => `${prefix}:${++sequence}`;
  function call(payload: { type: 'pii:init' } | { type: 'pii:scan-text'; text: string } |
    { type: 'pii:scan-segments'; segments: import('../../core/api/types').TextSegment[] }, scanOptions?: ScanOptions,
    requestId = nextRequestId()) {
    if (disposed) return Promise.reject(new PiiError('MODEL_NOT_READY', 'PII client is disposed.'));
    const request: PiiRequest = { ...payload, channel: PII_CHANNEL, target: 'background',
      clientId: prefix, requestId, requestTimeoutMs: timeout };
    return new Promise<Detection[] | SegmentDetectionResult[] | undefined>((resolve, reject) => {
      let settled = false;
      let dispatched = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const signal = scanOptions?.signal;
      const notifyCancellation = () => {
        if (!dispatched || request.type === 'pii:init') return;
        // A reentrant abort during sendMessage must not overtake that send call.
        void Promise.resolve().then(() => runtime.sendMessage(cancelMessage(request))).catch(() => undefined);
      };
      const finish = (error?: unknown, result?: Detection[] | SegmentDetectionResult[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        pending.delete(cancel);
        if (error) reject(error); else resolve(result);
      };
      const cancel = (error: PiiError) => {
        if (settled) return;
        finish(error);
        notifyCancellation();
      };
      const onAbort = () => cancel(new PiiError('CANCELLED', 'PII scan cancelled.'));
      pending.add(cancel);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      if (settled) return;
      timer = setTimeout(() => cancel(new PiiError('INFERENCE_FAILED', 'PII request timed out.')), timeout);
      Promise.resolve().then(() => {
        if (settled) return;
        if (disposed) throw new PiiError('MODEL_NOT_READY', 'PII client is disposed.');
        return request.type === 'pii:init' ? undefined : initialize();
      }).then(() => {
        if (settled) return;
        if (signal?.aborted) { onAbort(); return; }
        dispatched = true;
        return runtime.sendMessage(request);
      }).then(response => {
        if (settled) return;
        try { finish(undefined, unwrapResponse(response, request)); } catch (error) { finish(error); }
      }, error => finish(error instanceof PiiError ? error : new PiiError('INFERENCE_FAILED', 'PII messaging unavailable.')));
    });
  }
  const initialize = (): Promise<void> => {
    if (disposed) return Promise.reject(new PiiError('MODEL_NOT_READY', 'PII client is disposed.'));
    if (!initialization) {
      const attempt = call({ type: 'pii:init' }).then(() => undefined);
      initialization = attempt;
      // Share in-flight initialization, but recheck the host on later calls (SW/worker restart).
      void attempt.then(() => { if (initialization === attempt) initialization = undefined; },
        () => { if (initialization === attempt) initialization = undefined; });
    }
    return initialization;
  };
  return {
    initialize,
    async scanText(text, options) {
      const requestId = nextRequestId();
      if (options?.signal?.aborted) throw new PiiError('CANCELLED', 'PII scan cancelled.');
      if (typeof text !== 'string') throw new PiiError('INVALID_INPUT', 'text must be a string.');
      return await call({ type: 'pii:scan-text', text }, options, requestId) as Detection[];
    },
    async scanSegments(segments, options) {
      const requestId = nextRequestId();
      if (options?.signal?.aborted) throw new PiiError('CANCELLED', 'PII scan cancelled.');
      if (!isSegments(segments)) throw new PiiError('INVALID_INPUT', 'segments must contain string id and text fields.');
      // Snapshot caller-owned input before awaiting initialization.
      const snapshot = segments.map(({ id, text }) => ({ id, text }));
      return await call({ type: 'pii:scan-segments', segments: snapshot }, options, requestId) as SegmentDetectionResult[];
    },
    onStatus(listener) {
      if (disposed) throw new PiiError('MODEL_NOT_READY', 'PII client is disposed.');
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      runtime.onMessage.removeListener(onMessage);
      listeners.clear();
      for (const cancel of pending) cancel(new PiiError('MODEL_NOT_READY', 'PII client is disposed.'));
    },
  };
}
