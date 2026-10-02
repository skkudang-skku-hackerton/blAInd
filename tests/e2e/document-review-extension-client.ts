import { createDocumentReview } from '../../src/features/review/document-review';
import { captureUploadContext } from '../../src/modules/sites/upload-context';
import { createHoldNotice } from '../../src/features/review/hold-notice';
import { createProcessingIndicator } from '../../src/modules/sites/gemini/file-upload/processing-indicator';

const notice = createHoldNotice();
const startButton = document.querySelector<HTMLButtonElement>('#start')!;
startButton.focus();
notice.show('문서를 처리하지 못했습니다. 다시 시도해 주세요.');
createProcessingIndicator().show({ fileCount: 1, fileNames: ['sample.pdf'] });
startButton.addEventListener('click', () => {
  const controller = new AbortController();
  const context = captureUploadContext(document.querySelector('input'), document);
  const unwatch = context.watch(() => controller.abort());
  document.documentElement.dataset.reviewState = 'pending';
  void createDocumentReview()({ segments: [{ id: 'p1', text: '김민수', detections: [
    { type: 'PERSON', confidence: 1, span: { start: 0, end: 3 }, word: '김민수' },
  ] }] }, { signal: controller.signal }).then(result => {
    unwatch(); document.documentElement.dataset.reviewState = result.status;
  }, error => {
    unwatch(); document.documentElement.dataset.reviewState = `error: ${String(error)}`;
  });
});
