import { createDocumentReview } from '../../src/features/review/document-review';
import { captureUploadContext } from '../../src/modules/sites/upload-context';
import { createHoldNotice } from '../../src/features/review/hold-notice';
import { createProcessingIndicator } from '../../src/modules/sites/gemini/file-upload/processing-indicator';

const notice = createHoldNotice();
notice.show('문서의 개인정보를 검사하고 있습니다. 업로드를 보류합니다.');
createProcessingIndicator().show({ fileCount: 1, fileNames: ['sample.pdf'] });
document.querySelector('#start')!.addEventListener('click', () => {
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
