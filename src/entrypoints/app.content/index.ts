import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { createFileUploadInterceptor } from '../../modules/sites/chatgpt/file-upload';
import { createPdfProcessor } from '../../modules/documents/pdf';
import { createPiiDetectorClient } from '../../shared/messaging/pii-client';
import { createRemotePdfOpener } from '../../shared/messaging/pdf-session';
import { createPdfReviewQueue } from '../../features/review/pdf-review';
import { mountMockAlertPreview } from '../../alert/mock_data/preview';
import { createHoldNotice } from '../../features/review/hold-notice';
import { getTextSiteAdapter } from '../../modules/sites/text-adapters';
import { createTextSubmitInterceptor } from '../../modules/text';
import { requestBackgroundStatus } from '../../shared/messaging/client';
import { getRegisteredSite, REGISTERED_SITE_MATCHES } from '../../sites/registry';

export default defineContentScript({
  matches: REGISTERED_SITE_MATCHES,
  runAt: 'document_start',
  allFrames: false,
  world: 'ISOLATED',
  // WXT의 호환성용 window.postMessage가 페이지 메시지 핸들러를 깨우지 않게 합니다.
  // 기존 Content Script 정리는 WXT의 CustomEvent 경로로 계속 처리됩니다.
  noScriptStartedPostMessage: true,

  async main(ctx) {
    const site = getRegisteredSite(new URL(window.location.href));
    if (!site) return;

    console.info(`[blAInd] Content Script ready: ${site.name}`);

    if (import.meta.env.DEV) {
      ctx.onInvalidated(mountMockAlertPreview());
    }

    const notice = createHoldNotice();
    if (site.id === 'chatgpt') {
      const detector = createPiiDetectorClient();
      const reviews = createPdfReviewQueue();
      detector.onStatus(status => {
        if (status.state === 'downloading') notice.show(`개인정보 탐지 모델 다운로드 중: ${Math.round(status.progress * 100)}%. 최초 검사 시 시간이 걸릴 수 있습니다.`);
        if (status.state === 'loading') notice.show('개인정보 탐지 모델을 준비하고 있습니다. 원본 PDF 첨부는 보류 중입니다.');
      });
      const processor = createPdfProcessor({
        detector,
        openPdf: createRemotePdfOpener(request => browser.runtime.sendMessage(request)),
        review: reviews.review,
        onStage(stage) {
          console.info(`[blAInd:pdf] ${stage}`);
          if (stage === 'reviewing') notice.dispose();
        },
        onError(error) {
          console.error('[blAInd:pdf] Processing failed', error);
          notice.show('PDF 처리에 실패해 첨부를 보류했습니다. 텍스트 PDF(25MB 이하)로 다시 시도해 주세요.');
        },
      });
      const files = createFileUploadInterceptor({
        processors: { pdf: processor },
        unhandled: 'hold',
        onProcessed() { console.info('[blAInd:pdf] Masked PDF attached'); },
        onSkipped({ reason }) {
          notice.show(reason === 'unhandled' ? '현재 파일 검사는 PDF만 지원합니다. Word 등 다른 파일은 첨부하지 않았습니다.' : 'PDF 첨부를 보류했습니다. 취소했거나 처리할 수 없는 파일입니다.');
        },
        onError() { notice.show('처리한 PDF를 첨부하지 못했습니다. 다시 시도해 주세요.'); },
      });
      files.start();
      const stop = () => { files.stop(); reviews.dispose(); detector.dispose(); };
      window.addEventListener('pagehide', stop, { once: true });
      ctx.onInvalidated(() => { stop(); window.removeEventListener('pagehide', stop); });
    }
    const interceptor = createTextSubmitInterceptor({
      adapter: getTextSiteAdapter(site.id),
      onIntercept({ text, source }) {
        const action = source === 'enter' ? 'Enter' : 'Send button';
        console.info(`[blAInd] ${action} intercepted: ${site.name}`, { length: text.length });
        notice.show('전송을 보류했습니다. 입력 내용은 유지되며, 개인정보 검사는 아직 실행되지 않았습니다.');
      },
      onError() {
        console.error(`[blAInd] Text send interception failed: ${site.name}`);
        notice.show('입력 내용을 확인하지 못해 전송을 보류했습니다.');
      },
    });
    // Background 응답을 기다리는 동안에도 Enter와 버튼 전송을 잡습니다.
    interceptor.start();
    ctx.onInvalidated(() => {
      interceptor.stop();
      notice.dispose();
    });

    try {
      const response = await requestBackgroundStatus();
      if (ctx.isInvalid) return;

      console.info(`[blAInd] Background connected: ${response.extensionVersion}`);
    } catch (error) {
      if (ctx.isInvalid) return;

      console.error('[blAInd] Background connection failed', error);
    }

    // 다음 단계: onIntercept의 원문 → 모델 검사 → 항목 선택 → 교체·전송.
  },
});
