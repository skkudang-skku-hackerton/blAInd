import { defineContentScript } from 'wxt/utils/define-content-script';
import { getRegisteredSite, REGISTERED_SITE_MATCHES } from '../../sites/registry';

export default defineContentScript({
  matches: REGISTERED_SITE_MATCHES,
  runAt: 'document_start',
  allFrames: false,
  world: 'ISOLATED',

  main() {
    const site = getRegisteredSite(new URL(window.location.href));
    if (!site) return;

    console.info(`[blAInd] Content Script ready: ${site.name}`);

    // 다음 단계에서 사이트 어댑터와 전송 Controller를 연결합니다.
  },
});
