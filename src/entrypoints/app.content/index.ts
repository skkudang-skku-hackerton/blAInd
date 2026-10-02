import { defineContentScript } from 'wxt/utils/define-content-script';
import { createPiiDetectorClient, PiiError } from '../../core/api';
import { createHoldNotice } from '../../features/review/hold-notice';
import { createDocumentReview } from '../../features/review/document-review';
import { createPdfProcessor } from '../../modules/documents/pdf';
import { createDocxProcessor } from '../../modules/documents/docx';
import { documentErrorNotice, documentErrorCode } from '../../modules/documents/shared/errors';
import { createFileUploadInterceptor as createChatgptFileUploadInterceptor } from '../../modules/sites/chatgpt/file-upload';
import { createFileUploadInterceptor as createClaudeFileUploadInterceptor } from '../../modules/sites/claude/file-upload';
import { createFileUploadInterceptor as createGeminiFileUploadInterceptor } from '../../modules/sites/gemini/file-upload';
import { openPdfOffscreen, openDocxOffscreen } from '../../shared/messaging/document-client';
import { createTextReviewController } from '../../features/review/text-review';
import { createTextSender } from '../../features/review/text-send';
import { createTextScanController } from '../../features/review/text-scan';
import { getTextSiteAdapter } from '../../modules/sites/text-adapters';
import { createTextSubmitInterceptor } from '../../modules/text';
import { requestBackgroundStatus } from '../../shared/messaging/client';
import { getRegisteredSite, REGISTERED_SITE_MATCHES } from '../../sites/registry';
import { initializeMaskingPreferences } from '../../shared/masking-preferences';
import { ensureAlertFonts } from '../../alert/typography';

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
    ensureAlertFonts(document);

    console.info(`[blAInd] Content Script ready: ${site.name}`);

    const notice = createHoldNotice();
    const adapter = getTextSiteAdapter(site.id);
    const settings = initializeMaskingPreferences();
    // A failed settings read holds the send/upload path just like a failed scan.
    void settings.ready.catch(() => {});
    const client = createPiiDetectorClient();
    const detector = {
      ...client,
      async scanText(...args: Parameters<typeof client.scanText>) {
        await settings.ready;
        return client.scanText(...args);
      },
      async scanSegments(...args: Parameters<typeof client.scanSegments>) {
        await settings.ready;
        return client.scanSegments(...args);
      },
    };
    const documentReview = createDocumentReview();
    let documentStage = '';
    let documentFailed = false;
    const documentOptions = {
      detector, review: documentReview,
      onStage(stage: string) {
        documentStage = stage;
        if (stage === 'extracting') documentFailed = false;
        const labels: Record<string, string> = {
          extracting: '문서에서 텍스트를 추출하고 있습니다. 업로드를 보류합니다.',
          scanning: '문서의 개인정보를 검사하고 있습니다. 업로드를 보류합니다.',
          reviewing: '확인 창에서 마스킹할 항목을 선택해 주세요.',
          rebuilding: '선택한 항목을 마스킹한 파일을 만들고 있습니다.',
        };
        notice.show(labels[stage] ?? '문서를 처리하고 있습니다.');
      },
      onError(error: unknown) {
        documentFailed = true;
        console.error('[blAInd] Document processing failed', {
          stage: documentStage,
          code: error instanceof PiiError ? error.code : documentErrorCode(error),
        }, error);
        notice.show(`${documentErrorNotice(error)} 원본은 첨부되지 않았습니다.`);
      },
    };
    const createFileUploadInterceptor = {
      chatgpt: createChatgptFileUploadInterceptor,
      claude: createClaudeFileUploadInterceptor,
      gemini: createGeminiFileUploadInterceptor,
    }[site.id];
    const fileInterceptor = createFileUploadInterceptor({
      processors: {
        pdf: createPdfProcessor({ ...documentOptions, openPdf: openPdfOffscreen }),
        docx: createDocxProcessor({ ...documentOptions, openDocx: openDocxOffscreen }),
      },
      onProcessed() { notice.show(`검사가 끝난 파일을 ${site.name}에 첨부했습니다.`); },
      onSkipped() {
        if (!documentFailed) notice.show('문서 업로드를 취소했습니다. 파일은 첨부되지 않았습니다.');
      },
      onError: documentOptions.onError,
    });
    fileInterceptor.start();
    let downloadProgress = -1;
    const onScanError = (error: unknown) => {
      console.error(`[blAInd] PII scan failed: ${site.name}`, {
        code: error instanceof PiiError ? error.code : 'INFERENCE_FAILED',
      });
      notice.show('개인정보 검사에 실패해 전송을 보류했습니다. 입력은 유지됩니다. 다시 시도해 주세요.');
    };
    const review = createTextReviewController({
      getCurrentResult: () => scanner.getResult(),
      onApproved(text) {
        const result = scanner.getResult();
        if (!result) return;
        scanner.clear();
        const automatic = result.detections.length === 0;
        notice.dispose();
        void sender.send(result, text).then(() => {
          notice.dispose();
          console.info(automatic
            ? '[blAInd] No-detection text send requested'
            : '[blAInd] Approved text send requested');
        }).catch(() => {
          if (ctx.isInvalid) return;
          notice.show('입력 변경 또는 전송 버튼 확인 실패로 전송을 중단했습니다. 입력창을 확인하고 다시 시도해 주세요.');
        });
      },
      onCancelled() {
        notice.show('확인을 취소했습니다. 입력은 유지되며 전송하지 않습니다.');
      },
      onError: onScanError,
    });
    const scanner = createTextScanController({
      detector,
      readText: editor => adapter.readText(editor),
      getPageUrl: () => window.location.href,
      onScanning({ text }) {
        review.close();
        downloadProgress = -1;
        console.info(`[blAInd] PII scan started: ${site.name}`, { length: text.length });
        if (!fileInterceptor.isProcessing) notice.dispose();
      },
      onResult(result) {
        const { detections } = result;
        const types = [...new Set(detections.map(detection => detection.type))];
        console.info(`[blAInd] PII scan completed: ${site.name}`, { count: detections.length, types });
        notice.dispose();
        review.open(result);
      },
      onError: onScanError,
      onDiscarded() {
        review.close();
        notice.show('입력 또는 대화가 변경되어 검사 결과를 폐기했습니다. 전송하려면 다시 검사해 주세요.');
      },
    });
    const unsubscribeStatus = detector.onStatus(status => {
      // 텍스트 검사는 조용히 진행하고, 문서 검사 진행 안내는 유지합니다.
      if (!(fileInterceptor.isProcessing && documentStage === 'scanning')) return;
      if (status.state === 'downloading') {
        const progress = Math.round(status.progress * 100);
        if (progress === downloadProgress) return;
        downloadProgress = progress;
        notice.show(`개인정보 검사 모델을 준비하고 있습니다 (${progress}%). 전송과 업로드는 보류됩니다.`);
      } else if (status.state === 'loading') {
        notice.show('개인정보 검사 모델을 불러오고 있습니다. 전송은 보류됩니다.');
      } else if (status.state === 'ready') {
        notice.show('입력한 내용에서 개인정보를 검사하고 있습니다. 전송은 보류됩니다.');
      }
    });
    const interceptor = createTextSubmitInterceptor({
      adapter,
      onIntercept(context) {
        sender.cancel();
        const { text, source } = context;
        const action = source === 'enter' ? 'Enter' : 'Send button';
        console.info(`[blAInd] ${action} intercepted: ${site.name}`, { length: text.length });
        void scanner.scan(context).catch(onScanError);
      },
      onError() {
        sender.cancel();
        scanner.cancel();
        console.error(`[blAInd] Text send interception failed: ${site.name}`);
        notice.show('입력 내용을 확인하지 못해 전송을 보류했습니다.');
      },
    });
    const sender = createTextSender(adapter, interceptor, () => window.location.href);
    // Background 응답을 기다리는 동안에도 Enter와 버튼 전송을 잡습니다.
    interceptor.start();
    const invalidate = () => scanner.invalidate();
    const cancel = () => { sender.cancel(); scanner.cancel(); };
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    window.addEventListener('input', invalidate, true);
    window.addEventListener('change', invalidate, true);
    window.addEventListener('popstate', cancel);
    window.addEventListener('hashchange', cancel);
    window.addEventListener('pagehide', cancel);
    navigation?.addEventListener('navigate', cancel);
    ctx.onInvalidated(() => {
      fileInterceptor.stop();
      interceptor.stop();
      window.removeEventListener('input', invalidate, true);
      window.removeEventListener('change', invalidate, true);
      window.removeEventListener('popstate', cancel);
      window.removeEventListener('hashchange', cancel);
      window.removeEventListener('pagehide', cancel);
      navigation?.removeEventListener('navigate', cancel);
      sender.cancel();
      review.dispose();
      scanner.dispose();
      unsubscribeStatus();
      detector.dispose();
      settings.dispose();
      notice.dispose();
    });

    // 페이지 진입 시 미리 준비합니다. await하지 않아 전송/업로드 차단과
    // Background 상태 확인을 지연하지 않으며, 검사 요청은 진행 중인 초기화를 공유합니다.
    console.info(`[blAInd] Model preload started: ${site.name}`);
    void detector.initialize().then(() => {
      if (ctx.isInvalid) return;
      console.info(`[blAInd] Model preload ready: ${site.name}`);
    }).catch((error: unknown) => {
      if (ctx.isInvalid) return;
      console.warn(`[blAInd] Model preload failed; will retry on scan: ${site.name}`, {
        code: error instanceof PiiError ? error.code : 'MODEL_LOAD_FAILED',
      });
    });

    try {
      const response = await requestBackgroundStatus();
      if (ctx.isInvalid) return;

      console.info(`[blAInd] Background connected: ${response.extensionVersion}`);
    } catch (error) {
      if (ctx.isInvalid) return;

      console.error('[blAInd] Background connection failed', error);
    }

    // 탐지가 없거나 Alert에서 승인하면 원문 유효성을 확인하고 전송합니다.
  },
});
