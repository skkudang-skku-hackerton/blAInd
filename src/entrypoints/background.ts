import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import {
  isBackgroundStatusRequest,
  type BackgroundStatusResponse,
} from '../shared/messaging/protocol';
import { PiiError } from '../core/api/errors';
import { installDocumentServer } from '../shared/messaging/document-server';
import { DOCUMENT_CHANNEL } from '../shared/messaging/document-client';
import { installReviewRelay } from '../shared/messaging/review-channel';
import { installPiiServer, cancelledError } from '../shared/messaging/pii-server';
import { cancelMessage, errorResponse, isStatusMessage, ownsSender, PII_CHANNEL, requestTimeout, validateResponse,
  type MessageListener, type MessagingRuntime } from '../shared/messaging/types';

export interface OffscreenApi {
  hasDocument(): Promise<boolean>;
  createDocument(options: { url: string; reasons: ['WORKERS']; justification: string }): Promise<void>;
}
export interface StatusTabs {
  query(query: Record<string, never>): Promise<{ id?: number }[]>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

export function createOffscreenManager(offscreen: OffscreenApi, requestTimeoutMs?: number): () => Promise<void> {
  const timeout = requestTimeout(requestTimeoutMs);
  let creation: Promise<void> | undefined;
  return () => {
    if (!creation) {
      const operation = (async () => {
        if (await offscreen.hasDocument()) return;
        try {
          await offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'],
            justification: 'Host the local PII inference worker.' });
        } catch {
          if (!await offscreen.hasDocument()) throw new PiiError('MODEL_LOAD_FAILED', 'Could not create the PII offscreen document.');
        }
      })();
      const attempt = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new PiiError('MODEL_LOAD_FAILED',
          'PII offscreen creation timed out.')), timeout);
        void operation.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
      });
      creation = attempt;
      void attempt.then(() => { if (creation === attempt) creation = undefined; },
        () => { if (creation === attempt) creation = undefined; });
    }
    return creation;
  };
}

export interface DirectInferenceRpc {
  request(request: import('../shared/messaging/types').PiiRequest, signal?: AbortSignal): Promise<import('../shared/messaging/types').PiiResponse>;
  dispose(): void;
}
export interface PiiBackgroundOptions {
  browser?: 'chrome' | 'firefox' | 'safari';
  createDirectRpc?: () => DirectInferenceRpc;
}

export function installPiiBackground(
  runtime: MessagingRuntime,
  offscreen: OffscreenApi | undefined,
  tabs: StatusTabs,
  options: PiiBackgroundOptions = {},
): () => void {
  const targetBrowser = options.browser ?? (import.meta.env.BROWSER === 'firefox' || import.meta.env.BROWSER === 'safari'
    ? import.meta.env.BROWSER : 'chrome');
  const canUseOffscreen = targetBrowser === 'chrome' && !!offscreen && typeof offscreen.hasDocument === 'function' &&
    typeof offscreen.createDocument === 'function';
  const ensureOffscreen = canUseOffscreen ? createOffscreenManager(offscreen!) : undefined;
  const broadcastStatus = (status: import('../core/api/types').PiiDetectorStatus) => {
    const event = { channel: PII_CHANNEL, type: 'pii:status', target: 'client', status };
    void runtime.sendMessage(event).catch(() => undefined);
    void tabs.query({}).then(items => Promise.all(items.filter(tab => tab.id !== undefined)
      .map(tab => tabs.sendMessage(tab.id!, event).catch(() => undefined)))).catch(() => undefined);
  };
  // Browsers without chrome.offscreen keep inference in their background context.
  let directRpcPromise: Promise<DirectInferenceRpc> | undefined;
  const directRpc = targetBrowser !== 'chrome'
    ? () => directRpcPromise ??= (options.createDirectRpc
      ? Promise.resolve(options.createDirectRpc())
      : import.meta.env.FIREFOX || import.meta.env.SAFARI
        ? import('../platform/background-inference-host').then(({ createBackgroundInferenceRpc }) => createBackgroundInferenceRpc(broadcastStatus))
        : Promise.reject(new PiiError('MODEL_LOAD_FAILED', 'Background inference host is unavailable in this build.')))
    : undefined;
  const removeServer = installPiiServer(runtime, 'background', async (request, signal) => {
    if (directRpc) return (await directRpc()).request(request, signal);
    if (!canUseOffscreen) return errorResponse(request.requestId,
      new PiiError('MODEL_LOAD_FAILED', 'No inference host is available in this browser build.'));
    try {
      if (signal?.aborted) throw cancelledError();
      await ensureOffscreen!();
      if (signal?.aborted) throw cancelledError();
      let dispatched = false;
      const onAbort = () => {
        if (dispatched) void Promise.resolve().then(() => runtime.sendMessage({
          ...cancelMessage(request), target: 'offscreen',
        })).catch(() => undefined);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        if (signal?.aborted) throw cancelledError();
        dispatched = true;
        return validateResponse(await runtime.sendMessage({ ...request, target: 'offscreen' }), request);
      } finally { signal?.removeEventListener('abort', onAbort); }
    } catch (error) { return errorResponse(request.requestId, error); }
  });
  const statusListener: MessageListener = (message, sender) => {
    if (!canUseOffscreen || !ownsSender(runtime, sender) || sender.url !== runtime.getURL('offscreen.html') ||
      !isStatusMessage(message, 'background')) return;
    broadcastStatus(message.status);
  };
  runtime.onMessage.addListener(statusListener);
  return () => {
    removeServer();
    runtime.onMessage.removeListener(statusListener);
    void directRpcPromise?.then(rpc => rpc.dispose());
  };
}

export default defineBackground(() => {
  installReviewRelay(browser.runtime);
  if (import.meta.env.FIREFOX || import.meta.env.SAFARI) {
    installDocumentServer(browser.runtime as unknown as MessagingRuntime, 'background');
  } else {
    const ensureDocumentHost = createOffscreenManager(browser.offscreen as unknown as OffscreenApi);
    browser.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.channel !== DOCUMENT_CHANNEL || message.target !== 'background' ||
          sender.id !== browser.runtime.id || typeof message.sessionId !== 'string') return;
      const owner = JSON.stringify([sender.tab?.id ?? 'extension', sender.documentId ?? sender.url, sender.frameId]);
      void ensureDocumentHost().then(() => browser.runtime.sendMessage({
        ...message, owner, target: 'offscreen',
      })).then(respond, () => respond({ ok: false, error: 'Document host unavailable' }));
      return true;
    });
  }
  installPiiBackground(browser.runtime as unknown as MessagingRuntime,
    (browser as unknown as { offscreen?: OffscreenApi }).offscreen,
    browser.tabs as unknown as StatusTabs);
  // 동기적으로 등록하고, 이 진입점의 요청에만 응답합니다.
  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isBackgroundStatusRequest(message)) return;

    const response: BackgroundStatusResponse = {
      type: 'BACKGROUND_STATUS',
      status: 'ready',
      extensionVersion: browser.runtime.getManifest().version,
    };

    sendResponse(response);
  });

  console.info('[blAInd] Background ready');
});
