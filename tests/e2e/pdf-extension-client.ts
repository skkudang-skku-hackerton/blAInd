import { browser } from 'wxt/browser';
import { createFileUploadInterceptor } from '../../src/modules/sites/chatgpt/file-upload';
import { createPdfProcessor } from '../../src/modules/documents/pdf';
import { createRemotePdfOpener } from '../../src/shared/messaging/pdf-session';
import { createPdfReviewQueue } from '../../src/features/review/pdf-review';

const review = createPdfReviewQueue();
const processor = createPdfProcessor({
  openPdf: createRemotePdfOpener(request => browser.runtime.sendMessage(request)),
  detector: {
    initialize: async () => {}, scanText: async () => [],
    scanSegments: async segments => segments.map(({ id, text }) => ({ segmentId: id, detections: [
      ...Array.from(text.matchAll(/김민수/g), match => ({ type: 'PERSON' as const, confidence: 1, span: { start: match.index, end: match.index + 3 } })),
      ...Array.from(text.matchAll(/010-1234-5678/g), match => ({ type: 'PHONE' as const, confidence: 1, span: { start: match.index, end: match.index + 13 } })),
    ] })),
  },
  review: review.review,
  onError: error => { document.body.dataset.error = String(error); },
});
createFileUploadInterceptor({ processors: { pdf: processor }, unhandled: 'hold', indicator: false }).start();
document.querySelector('input')!.addEventListener('change', async event => {
  const file = (event.target as HTMLInputElement).files![0]!;
  Object.assign(window, { uploaded: { name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) } });
});
