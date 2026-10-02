import { analyzeDetections } from '../policy';
import { mountPrivacyAlert } from '../PrivacyAlert';
import { sampleDetections, sampleText } from './sample';
import type { Detection, ReviewResult } from '../types';

function logItem(detection: Detection) {
  return {
    segmentId: 'text',
    type: detection.type,
    span: { ...detection.span },
    word: sampleText.slice(detection.span.start, detection.span.end),
  };
}

/** Development-only controls rendered by the extension's content script. */
export function mountMockAlertPreview(): () => void {
  let host: HTMLElement | undefined;
  let closeAlert: (() => void) | undefined;
  let disposed = false;

  const mount = () => {
    if (disposed || !document.body) return;
    host = document.createElement('div');
    host.dataset.blaindMockAlert = 'true';

    const panel = document.createElement('section');
    panel.setAttribute('aria-label', 'blAInd Alert 테스트');
    panel.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:2147483646;max-width:min(380px,calc(100vw - 40px));padding:14px;border:1px solid #53689e;border-radius:14px;background:#17223a;color:#edf2ff;font:13px/1.6 system-ui,sans-serif;box-shadow:0 8px 28px #0004;';

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'blAInd · 목업 Alert 열기';
    button.style.cssText = 'display:block;padding:10px 14px;border:0;border-radius:9px;background:#526ff0;color:white;font:600 13px system-ui,sans-serif;cursor:pointer;';

    const result = document.createElement('p');
    result.setAttribute('role', 'status');
    result.style.cssText = 'margin:10px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;';
    result.style.maxHeight = '240px';
    result.style.overflowY = 'auto';
    result.textContent = '샘플 이름·전화번호·이메일·사번으로 확인창을 테스트합니다.';

    const publishResult = async (decision: ReviewResult) => {
      const json = JSON.stringify(decision, null, 2);
      console.info('[blAInd:mock-alert] final result\n' + json);
      result.textContent = json;
      try {
        const response = await browser.runtime.sendMessage({ type: 'BLAIND_MOCK_REVIEW_RESULT', result: decision });
        if (!response?.ok) throw new Error(response?.error ?? 'No terminal logger response');
      } catch (error) {
        result.textContent = `${json}\n\n터미널 전달 실패: npm run dev를 재시작하고 확장과 페이지를 새로고침해 주세요.`;
        console.error('[blAInd:mock-alert] terminal delivery failed', error);
      }
    };

    button.addEventListener('click', () => {
      closeAlert?.();
      result.textContent = '확인창에서 마스킹할 항목을 선택해 주세요.';
      const analysis = analyzeDetections(sampleText, sampleDetections);
      console.info('[blAInd:mock-alert] opened', {
        originalText: sampleText,
        autoMask: analysis.autoMaskedDetections.map(logItem),
        confirm: analysis.confirmDetections.map(logItem),
      });
      closeAlert = mountPrivacyAlert(host!, {
        analysis,
        onSelectionChange(detection, masking) {
          console.info('[blAInd:mock-alert] selection changed', {
            ...logItem(detection),
            action: masking ? 'MASK' : 'KEEP',
          });
        },
        onComplete(decision) {
          closeAlert = undefined;
          void publishResult(decision);
          button.focus();
        },
        onCancel() {
          closeAlert = undefined;
          void publishResult({ status: 'cancelled' });
          button.focus();
        },
      });
    });

    panel.append(button, result);
    host.append(panel);
    document.body.append(host);
  };

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });

  return () => {
    disposed = true;
    document.removeEventListener('DOMContentLoaded', mount);
    closeAlert?.();
    host?.remove();
  };
}
import { browser } from 'wxt/browser';
