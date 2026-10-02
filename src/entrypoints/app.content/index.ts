import { defineContentScript } from 'wxt/utils/define-content-script';
import { createPiiDetectorClient, PiiError } from '../../core/api';
import { createHoldNotice } from '../../features/review/hold-notice';
import { createTextScanController } from '../../features/review/text-scan';
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

    const notice = createHoldNotice();
    const adapter = getTextSiteAdapter(site.id);
    const detector = createPiiDetectorClient();
    let downloadProgress = -1;
    const onScanError = (error: unknown) => {
      console.error(`[blAInd] PII scan failed: ${site.name}`, {
        code: error instanceof PiiError ? error.code : 'INFERENCE_FAILED',
      });
      notice.show('개인정보 검사에 실패해 전송을 보류했습니다. 입력은 유지됩니다. 다시 시도해 주세요.');
    };
    const scanner = createTextScanController({
      detector,
      readText: editor => adapter.readText(editor),
      getPageUrl: () => window.location.href,
      onScanning({ text }) {
        downloadProgress = -1;
        console.info(`[blAInd] PII scan started: ${site.name}`, { length: text.length });
        notice.show('입력한 내용에서 개인정보를 검사하고 있습니다. 전송은 보류됩니다.');
      },
      onResult({ detections }) {
        // 값과 원문은 로그에 남기지 않고, 확인 UI 연결에 필요한 결과는 scanner가 유지합니다.
        const types = [...new Set(detections.map(detection => detection.type))];
        console.info(`[blAInd] PII scan completed: ${site.name}`, { count: detections.length, types });
        notice.show(detections.length > 0
          ? `개인정보 후보 ${detections.length}개를 찾았습니다. 전송은 보류되며 입력 내용은 유지됩니다.`
          : '개인정보 검사가 완료됐습니다. 탐지된 항목은 없으며, 전송은 보류됩니다.');
      },
      onError: onScanError,
      onDiscarded() {
        notice.show('입력 또는 대화가 변경되어 검사 결과를 폐기했습니다. 전송하려면 다시 검사해 주세요.');
      },
    });
    const unsubscribeStatus = detector.onStatus(status => {
      if (!scanner.isScanning()) return;
      if (status.state === 'downloading') {
        const progress = Math.round(status.progress * 100);
        if (progress === downloadProgress) return;
        downloadProgress = progress;
        notice.show(`개인정보 검사 모델을 준비하고 있습니다 (${progress}%). 전송은 보류됩니다.`);
      } else if (status.state === 'loading') {
        notice.show('개인정보 검사 모델을 불러오고 있습니다. 전송은 보류됩니다.');
      } else if (status.state === 'ready') {
        notice.show('입력한 내용에서 개인정보를 검사하고 있습니다. 전송은 보류됩니다.');
      }
    });
    const interceptor = createTextSubmitInterceptor({
      adapter,
      onIntercept(context) {
        const { text, source } = context;
        const action = source === 'enter' ? 'Enter' : 'Send button';
        console.info(`[blAInd] ${action} intercepted: ${site.name}`, { length: text.length });
        void scanner.scan(context).catch(onScanError);
      },
      onError() {
        scanner.cancel();
        console.error(`[blAInd] Text send interception failed: ${site.name}`);
        notice.show('입력 내용을 확인하지 못해 전송을 보류했습니다.');
      },
    });
    // Background 응답을 기다리는 동안에도 Enter와 버튼 전송을 잡습니다.
    interceptor.start();
    const invalidate = () => scanner.invalidate();
    const cancel = () => scanner.cancel();
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    window.addEventListener('input', invalidate, true);
    window.addEventListener('change', invalidate, true);
    window.addEventListener('popstate', cancel);
    window.addEventListener('hashchange', cancel);
    window.addEventListener('pagehide', cancel);
    navigation?.addEventListener('navigate', cancel);
    ctx.onInvalidated(() => {
      interceptor.stop();
      window.removeEventListener('input', invalidate, true);
      window.removeEventListener('change', invalidate, true);
      window.removeEventListener('popstate', cancel);
      window.removeEventListener('hashchange', cancel);
      window.removeEventListener('pagehide', cancel);
      navigation?.removeEventListener('navigate', cancel);
      scanner.dispose();
      unsubscribeStatus();
      detector.dispose();
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

    // 다음 단계: scanner의 TextScanResult → Alert 항목 선택 → 교체·전송.
  },
});
