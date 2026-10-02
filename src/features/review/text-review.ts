import { analyzeDetections, createFinalText, mountPrivacyAlert } from '../../alert';
import type { TextScanResult } from './text-scan';

interface TextReviewOptions {
  getCurrentResult(): TextScanResult | null;
  onApproved(text: string): void;
  onCancelled(): void;
  onError(error: unknown): void;
}

/** 승인한 최종 텍스트를 호출자에게 전달합니다. */
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
          onComplete(selected) {
            // 승인 직전에 원문/입력창/대화를 다시 확인합니다.
            const current = options.getCurrentResult() === result;
            close();
            if (!current) return;
            try { options.onApproved(createFinalText(analysis, selected)); }
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
