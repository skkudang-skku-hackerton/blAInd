import { analyzeDetections, mountPrivacyAlert } from '../../alert';
import { applyMasking } from '../../alert/masking';
import type { TextScanResult } from './text-scan';

interface TextReviewOptions {
  getCurrentResult(): TextScanResult | null;
  onApproved(text: string): void;
  onCancelled(): void;
  onError(error: unknown): void;
}

/** 탐지가 없으면 원문을, 탐지가 있으면 승인한 최종 텍스트를 전송 경로에 전달합니다. */
export function createTextReviewController(options: TextReviewOptions) {
  let closeCurrent: (() => void) | null = null;
  function close(): void {
    closeCurrent?.();
    closeCurrent = null;
  }

  return {
    open(result: TextScanResult): void {
      close();
      if (options.getCurrentResult() !== result) return;
      if (result.detections.length === 0) {
        try { options.onApproved(result.text); }
        catch (error) { options.onError(error); }
        return;
      }
      const host = document.createElement('div');
      host.dataset.blaindReview = 'text';
      const shadow = host.attachShadow({ mode: 'closed' });
      const container = document.createElement('div');
      shadow.append(container);
      (document.body ?? document.documentElement).append(host);
      let unmount: (() => void) | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      closeCurrent = () => { clearInterval(timer); unmount?.(); host.remove(); };
      try {
        const analysis = analyzeDetections(result.text, result.detections);
        unmount = mountPrivacyAlert(container, {
          analysis,
          onComplete(decision) {
            // 승인 직전에 원문/입력창/대화를 다시 확인합니다.
            const current = options.getCurrentResult() === result;
            close();
            if (!current) return;
            try { options.onApproved(applyMasking(result.text, [...decision.autoMask, ...decision.confirm.masking]
              .map(item => ({ ...item, confidence: 1 })))); }
            catch (error) { options.onError(error); }
          },
          onCancel() { close(); options.onCancelled(); },
        });
        timer = setInterval(() => {
          if (options.getCurrentResult() !== result) close();
        }, 100);
      } catch (error) {
        close();
        options.onError(error);
      }
    },
    close,
    dispose: close,
  };
}
