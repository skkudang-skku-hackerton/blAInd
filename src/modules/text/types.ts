import type { RegisteredSiteId } from '../../sites/registry.ts';

/** 사이트별 입력창·전송 버튼 탐색과 텍스트 읽기·교체. */
export interface TextSiteAdapter {
  readonly siteId: RegisteredSiteId;
  findEditor(event: Event): HTMLElement | null;
  findSendButton(event: Event): HTMLElement | null;
  findEditorForSendButton(button: HTMLElement): HTMLElement | null;
  readText(editor: HTMLElement): string;
  replaceText(editor: HTMLElement, text: string): void;
  findSendButtonForEditor(editor: HTMLElement): HTMLElement | null;
}

export type TextSubmitSource = 'enter' | 'button';

export interface TextSubmitContext {
  siteId: RegisteredSiteId;
  editor: HTMLElement;
  source: TextSubmitSource;
  /** 전송을 시도한 시점의 원문. 모델 연결 시 이 값을 검사합니다. */
  text: string;
}

export interface TextSubmitInterceptorOptions {
  adapter: TextSiteAdapter;
  root?: EventTarget;
  /** 원래 전송 이벤트는 이미 차단된 상태입니다. 콜백 반환으로 전송을 재개하지 않습니다. */
  onIntercept(context: TextSubmitContext): void;
  onError?(error: unknown): void;
}

export interface TextSubmitInterceptor {
  start(): void;
  stop(): void;
  sendApproved(button: HTMLElement, editor: HTMLElement, text: string): void;
}

/** 기존 연결 코드에서 사용하는 이름도 유지합니다. */
export type TextEnterContext = TextSubmitContext;
export type TextEnterInterceptorOptions = TextSubmitInterceptorOptions;
export type TextEnterInterceptor = TextSubmitInterceptor;
