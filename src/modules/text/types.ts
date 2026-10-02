import type { RegisteredSiteId } from '../../sites/registry.ts';

/** 사이트별 입력창 탐색과 읽기. 교체·전송은 다음 단계에서 추가합니다. */
export interface TextSiteAdapter {
  readonly siteId: RegisteredSiteId;
  findEditor(event: Event): HTMLElement | null;
  readText(editor: HTMLElement): string;
}

export interface TextEnterContext {
  siteId: RegisteredSiteId;
  editor: HTMLElement;
  /** Enter를 누른 시점의 원문. 모델 연결 시 이 값을 검사합니다. */
  text: string;
}

export interface TextEnterInterceptorOptions {
  adapter: TextSiteAdapter;
  root?: EventTarget;
  /** 원래 Enter는 이미 차단된 상태입니다. 콜백 반환으로 전송을 재개하지 않습니다. */
  onIntercept(context: TextEnterContext): void;
  onError?(error: unknown): void;
}

export interface TextEnterInterceptor {
  start(): void;
  stop(): void;
}
