import { browser } from 'wxt/browser';
import { mountDocumentReview } from '../../features/review/document-review-view';
import { REVIEW_PORT_PREFIX } from '../../shared/messaging/review-channel';

document.body.style.margin = '0';
const id = location.hash.slice(1);
if (/^[a-f0-9-]{36}$/.test(id)) {
  const port = browser.runtime.connect({ name: `${REVIEW_PORT_PREFIX}${id}:frame` });
  // Keep the MV3 relay alive while the user is considering their selections.
  const heartbeat = setInterval(() => port.postMessage({ type: 'ping' }), 20_000);
  let cleanup: (() => void) | undefined;
  port.onMessage.addListener(message => {
    if (message?.type !== 'open' || cleanup) return;
    try {
      cleanup = mountDocumentReview(document.body, message.request, result => {
        port.postMessage({ type: 'decision', result });
      });
    } catch {
      port.postMessage({ type: 'error' });
    }
  });
  port.onDisconnect.addListener(() => { clearInterval(heartbeat); cleanup?.(); });
  port.postMessage({ type: 'ready' });
}
