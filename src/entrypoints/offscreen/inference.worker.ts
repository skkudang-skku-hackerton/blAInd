import { KoPiiDetector } from '../../core/detector/ko-pii/detector';
import { createPiiRequestHandler } from '../../shared/messaging/pii-server';
import { isCancelMessage, isPiiRequest, PII_CHANNEL } from '../../shared/messaging/types';

const detector = new KoPiiDetector();
const handle = createPiiRequestHandler(detector);
detector.onStatus?.(status => {
  self.postMessage({ channel: PII_CHANNEL, target: 'background', type: 'pii:status', status });
});
self.addEventListener('message', event => {
  // Cancellation bypasses the inference queue and aborts only this request's controller.
  if (isCancelMessage(event.data, 'worker')) { handle.cancel(event.data); return; }
  if (!isPiiRequest(event.data, 'worker')) return;
  const request = event.data;
  void handle(request).then(response => self.postMessage(response));
});
