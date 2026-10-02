import { browser } from 'wxt/browser';
import { createPdfSessionHost, PDF_CHANNEL } from '../../shared/messaging/pdf-session';
import { openPdfInWorker } from '../../modules/documents/pdf/worker-client';
import { installPiiServer } from '../../shared/messaging/pii-server';
import { PII_CHANNEL, type MessagingRuntime } from '../../shared/messaging/types';
import { createWorkerRpc } from './rpc';

const runtime = browser.runtime as unknown as MessagingRuntime;
const pdfHost = createPdfSessionHost(openPdfInWorker);
browser.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== browser.runtime.id || sender.tab || sender.url !== runtime.getURL('background.js') ||
      message?.channel !== PDF_CHANNEL || message.target !== 'offscreen') return;
  void pdfHost.handle(message).then(respond);
  return true;
});
window.addEventListener('pagehide', () => pdfHost.dispose(), { once: true });
const rpc = createWorkerRpc({
  createWorker: () => new Worker(new URL('./inference.worker.ts', import.meta.url), { type: 'module' }),
  onStatus: status => {
    void runtime.sendMessage({ channel: PII_CHANNEL, target: 'background', type: 'pii:status', status })
      .catch(() => undefined);
  },
});
const removeServer = installPiiServer(runtime, 'offscreen', (request, signal) => rpc.request(request, signal));
window.addEventListener('pagehide', () => { removeServer(); rpc.dispose(); }, { once: true });
