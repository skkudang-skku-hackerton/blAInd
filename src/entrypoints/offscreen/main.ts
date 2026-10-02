import { browser } from 'wxt/browser';
import { installPiiServer } from '../../shared/messaging/pii-server';
import { PII_CHANNEL, type MessagingRuntime } from '../../shared/messaging/types';
import { createInferenceWorker } from '../../shared/create-inference-worker';
import { createWorkerRpc } from './rpc';

const runtime = browser.runtime as unknown as MessagingRuntime;
const rpc = createWorkerRpc({
  createWorker: createInferenceWorker,
  onStatus: status => {
    void runtime.sendMessage({ channel: PII_CHANNEL, target: 'background', type: 'pii:status', status })
      .catch(() => undefined);
  },
});
const removeServer = installPiiServer(runtime, 'offscreen', (request, signal) => rpc.request(request, signal));
window.addEventListener('pagehide', () => { removeServer(); rpc.dispose(); }, { once: true });
