import { browser } from 'wxt/browser';
import type { AlertReviewDecision, ReviewDocument } from '../../modules/documents/shared/types';
import { REVIEW_PAGE, REVIEW_PORT_PREFIX } from '../../shared/messaging/review-channel';

/** Queue concurrent files and keep the UI in an extension-owned document. */
export function createDocumentReview(): ReviewDocument {
  let queue: Promise<unknown> = Promise.resolve();
  return (request, { signal }) => {
    const run = () => new Promise<AlertReviewDecision>((resolve, reject) => {
      if (signal.aborted) { resolve({ status: 'cancelled' }); return; }
      const id = crypto.randomUUID();
      const port = browser.runtime.connect({ name: `${REVIEW_PORT_PREFIX}${id}:host` });
      const host = document.createElement('div');
      host.id = 'blaind-document-review';
      host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647';
      const frame = document.createElement('iframe');
      frame.title = 'blAInd 문서 개인정보 확인';
      frame.style.cssText = 'display:block;width:100%;height:100%;border:0;background:transparent';
      frame.src = `${browser.runtime.getURL(`/${REVIEW_PAGE}`)}#${id}`;
      host.attachShadow({ mode: 'open' }).append(frame);
      const previousFocus = document.activeElement as HTMLElement | null;
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        port.onDisconnect.removeListener(disconnected);
        port.disconnect();
        host.remove();
        if (previousFocus?.isConnected) previousFocus.focus();
      };
      const finish = (result: AlertReviewDecision) => {
        if (settled) return;
        cleanup(); resolve(result);
      };
      const fail = (message: string) => {
        if (settled) return;
        cleanup(); reject(new Error(message));
      };
      const cancel = () => finish({ status: 'cancelled' });
      const disconnected = () => fail('Document review connection closed');
      const timer = setTimeout(() => fail('Document review page did not connect'), 15_000);
      port.onDisconnect.addListener(disconnected);
      port.onMessage.addListener(message => {
        if (settled) return;
        if (message?.type === 'ready') {
          clearTimeout(timer);
          port.postMessage({ type: 'open', request });
        } else if (message?.type === 'decision') finish(message.result);
        else if (message?.type === 'error') fail('Document review rendering failed');
      });
      signal.addEventListener('abort', cancel, { once: true });
      (document.body ?? document.documentElement).append(host);
    });
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  };
}
