import { browser } from 'wxt/browser';

// WXT defines this value from the actual development server (including its port).
declare const __DEV_SERVER_ORIGIN__: string;

export function installMockReviewLogger(): void {
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id || !message || typeof message !== 'object'
      || !('type' in message) || message.type !== 'BLAIND_MOCK_REVIEW_RESULT'
      || !('result' in message)) return;

    const origin = __DEV_SERVER_ORIGIN__.replace(/^ws/, 'http');
    void fetch(`${origin}/__blaind/mock-alert-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.result),
      signal: AbortSignal.timeout(3000),
    }).then(response => {
      if (!response.ok) throw new Error(`Terminal logger returned HTTP ${response.status}`);
      sendResponse({ ok: true });
    }).catch(error => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  });
}
