import type { PiiDetectorApi, Detection } from '../../core/api';
import type { TextSubmitContext } from '../../modules/text';

/** 원문과 원문 기준 UTF-16 탐지 구간. 다음 단계의 확인 UI에 전달합니다. */
export interface TextScanResult extends TextSubmitContext {
  detections: Detection[];
}

interface TextScanOptions {
  detector: Pick<PiiDetectorApi, 'scanText'>;
  readText(editor: HTMLElement): string;
  getPageUrl(): string;
  onScanning(context: TextSubmitContext): void;
  onResult(result: TextScanResult): void;
  onError(error: unknown): void;
  onDiscarded(): void;
}

interface ScanRequest {
  context: TextSubmitContext;
  pageUrl: string;
  parent: HTMLElement | null;
  identities: Array<[Element, string, string]>;
  controller: AbortController;
  pending: boolean;
  result: TextScanResult | null;
  promise: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
}

/** 한 입력창의 최신 검사만 유지합니다. 결과가 나와도 전송은 계속 보류합니다. */
export function createTextScanController(options: TextScanOptions) {
  let current: ScanRequest | null = null;
  let disposed = false;

  function isCurrent(request: ScanRequest): boolean {
    try {
      return !disposed && !request.controller.signal.aborted
        && request.context.editor.isConnected
        && request.context.editor.parentElement === request.parent
        && options.getPageUrl() === request.pageUrl
        && options.readText(request.context.editor) === request.context.text
        && request.identities.every(([node, name, value]) =>
          node.isConnected && node.getAttribute(name) === value);
    } catch { return false; }
  }

  function cancel(notify: boolean): void {
    const previous = current;
    current = null;
    if (!previous) return;
    clearInterval(previous.timer);
    previous.controller.abort();
    if (notify && !disposed) options.onDiscarded();
  }

  function invalidate(): void {
    if (current && !isCurrent(current)) cancel(true);
  }

  async function run(request: ScanRequest): Promise<void> {
    try {
      const detections = await options.detector.scanText(request.context.text, {
        signal: request.controller.signal,
      });
      if (current !== request) return;
      if (!isCurrent(request)) { cancel(true); return; }
      request.pending = false;
      request.result = { ...request.context, detections };
      options.onResult(request.result);
    } catch (error) {
      if (current !== request) return;
      if (!isCurrent(request)) { cancel(true); return; }
      request.pending = false;
      request.result = null;
      options.onError(error);
    } finally { clearInterval(request.timer); }
  }

  return {
    scan(context: TextSubmitContext): Promise<void> {
      if (disposed) return Promise.resolve();
      // Enter 다음 버튼 클릭처럼 같은 원문으로 연속 시도해도 검사를 중복하지 않습니다.
      if (current?.pending && isCurrent(current)
        && current.context.editor === context.editor && current.context.text === context.text
        && current.context.siteId === context.siteId) return current.promise;
      cancel(false);
      const identities: ScanRequest['identities'] = [];
      for (let node: Element | null = context.editor; node; node = node.parentElement) {
        for (const name of ['data-conversation-id', 'data-chat-id']) {
          const value = node.getAttribute(name);
          if (value) identities.push([node, name, value]);
        }
      }
      const request: ScanRequest = {
        context: { ...context }, pageUrl: options.getPageUrl(),
        parent: context.editor.parentElement, identities,
        controller: new AbortController(), pending: true, result: null,
        promise: Promise.resolve(),
      };
      current = request;
      options.onScanning(request.context);
      // 프로그램이 textarea.value를 바꾸거나 입력창을 교체한 경우도 검사 중 감지합니다.
      request.timer = setInterval(invalidate, 100);
      request.promise = run(request);
      return request.promise;
    },
    isScanning(): boolean { return current?.pending ?? false; },
    getResult(): TextScanResult | null {
      invalidate();
      return current?.result ?? null;
    },
    invalidate,
    cancel(): void { cancel(true); },
    clear(): void { cancel(false); },
    dispose(): void {
      disposed = true;
      cancel(false);
    },
  };
}
