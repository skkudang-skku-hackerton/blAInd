import { defineContentScript } from 'wxt/utils/define-content-script';
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
