import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import {
  isBackgroundStatusRequest,
  type BackgroundStatusResponse,
} from '../shared/messaging/protocol';
import { PiiError } from '../core/api/errors';
import { DOCUMENT_CHANNEL } from '../shared/messaging/document-client';
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

export function installPiiBackground(runtime: MessagingRuntime, offscreen: OffscreenApi, tabs: StatusTabs): () => void {
  const ensureOffscreen = createOffscreenManager(offscreen);
  const removeServer = installPiiServer(runtime, 'background', async (request, signal) => {
    try {
      if (signal?.aborted) throw cancelledError();
      await ensureOffscreen();
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
    if (!ownsSender(runtime, sender) || sender.url !== runtime.getURL('offscreen.html') ||
      !isStatusMessage(message, 'background')) return;
    const event = { channel: PII_CHANNEL, type: 'pii:status', target: 'client', status: message.status };
    void runtime.sendMessage(event).catch(() => undefined);
    void tabs.query({}).then(items => Promise.all(items.filter(tab => tab.id !== undefined)
      .map(tab => tabs.sendMessage(tab.id!, event).catch(() => undefined)))).catch(() => undefined);
  };
  runtime.onMessage.addListener(statusListener);
  return () => { removeServer(); runtime.onMessage.removeListener(statusListener); };
}

export default defineBackground(() => {
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
  installPiiBackground(browser.runtime as unknown as MessagingRuntime,
    browser.offscreen as unknown as OffscreenApi, browser.tabs as unknown as StatusTabs);
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
