import { createPdfProcessor } from '../../src/modules/documents/pdf';
import { createDocxProcessor } from '../../src/modules/documents/docx';
import { openPdfOffscreen, openDocxOffscreen } from '../../src/shared/messaging/document-client';
import { createDocumentReview } from '../../src/features/review/document-review';
import { createFileUploadInterceptor } from '../../src/modules/sites/chatgpt/file-upload';
import type { PiiDetectorApi } from '../../src/core/api/pii-detector';

const detector: PiiDetectorApi = {
  initialize: async () => {}, scanText: async () => [],
  scanSegments: async segments => segments.map(({ id, text }) => ({ segmentId: id,
    detections: [{ type: 'PERSON' as const, word: '김민수' }, { type: 'PHONE' as const, word: '010-1234-5678' }]
      .filter(({ word }) => text.includes(word))
      .map(({ type, word }) => ({ type, confidence: 1, span: { start: text.indexOf(word), end: text.indexOf(word) + word.length } })),
  })),
};
const errors: string[] = [];
const review = createDocumentReview();
const options = { detector, review, onError: (error: unknown) => errors.push(String(error)) };
createFileUploadInterceptor({
  processors: {
    pdf: createPdfProcessor({ ...options, openPdf: openPdfOffscreen }),
    docx: createDocxProcessor({ ...options, openDocx: openDocxOffscreen }),
  }, indicator: false, onError: options.onError,
}).start();
const uploads: Array<{ name: string; bytes: number[] }> = [];
document.querySelector('input')!.addEventListener('change', async event => {
  const file = (event.target as HTMLInputElement).files![0]!;
  uploads.push({ name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) });
});
Object.assign(window, { documentFlow: { uploads, errors } });
