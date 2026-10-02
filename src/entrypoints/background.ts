import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import {
  isBackgroundStatusRequest,
  type BackgroundStatusResponse,
} from '../shared/messaging/protocol';

export default defineBackground(() => {
  // 동기적으로 등록하고, 이 진입점의 요청에만 응답합니다.
  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isBackgroundStatusRequest(message)) return;

    const response: BackgroundStatusResponse = {
      type: 'BACKGROUND_STATUS',
      status: 'ready',
      extensionVersion: browser.runtime.getManifest().version,
    };

    sendResponse(response);
  });

  console.info('[blAInd] Background ready');
});
