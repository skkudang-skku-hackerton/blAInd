import type {
  TextSubmitInterceptor,
  TextSubmitInterceptorOptions,
  TextSubmitSource,
} from './types.ts';

export function createTextSubmitInterceptor(
  options: TextSubmitInterceptorOptions,
): TextSubmitInterceptor {
  // Window capture는 document/입력창에 등록된 페이지 핸들러보다 먼저 실행됩니다.
  const root = options.root ?? window;
  let started = false;
  let composing = new WeakSet<HTMLElement>();
  let approvedClick: { event: Event; editor: HTMLElement; text: string; button: HTMLElement; consumed: boolean } | null = null;
  let heldEditor: HTMLElement | null = null;

  function hold(event: Event): void {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function intercept(event: Event, editor: HTMLElement, source: TextSubmitSource): void {
    let text: string;
    try {
      text = options.adapter.readText(editor);
    } catch (error) {
      if (source === 'enter') heldEditor = editor;
      hold(event);
      options.onError?.(error);
      return;
    }
    // 파일만 첨부된 빈 입력창은 별도 문서 흐름의 대상입니다.
    if (text.trim().length === 0) return;

    if (source === 'enter') heldEditor = editor;
    hold(event); // 비동기 모델 호출보다 먼저, 현재 이벤트에서 전송을 끊습니다.
    if (source === 'enter' && (event as KeyboardEvent).repeat) return;

    try {
      options.onIntercept({ siteId: options.adapter.siteId, editor, text, source });
    } catch (error) {
      options.onError?.(error);
    }
  }

  function onKeyDown(event: Event): void {
    const keyboard = event as KeyboardEvent;
    if (keyboard.key !== 'Enter') return;
    heldEditor = null;
    if (
      keyboard.shiftKey || keyboard.ctrlKey || keyboard.altKey || keyboard.metaKey ||
      keyboard.isComposing || keyboard.keyCode === 229
    ) return;

    const editor = options.adapter.findEditor(event);
    if (!editor || composing.has(editor)) return;
    intercept(event, editor, 'enter');
  }

  function onClick(event: Event): void {
    if (approvedClick?.event === event) {
      const approval = approvedClick;
      approvedClick = null;
      try {
        if (options.adapter.findSendButton(event) === approval.button
          && options.adapter.findEditorForSendButton(approval.button) === approval.editor
          && options.adapter.readText(approval.editor) === approval.text) {
          approval.consumed = true;
          return;
        }
      } catch { /* 검증 실패 시 승인 이벤트도 차단합니다. */ }
      hold(event);
      return;
    }
    const button = options.adapter.findSendButton(event);
    if (!button) return;

    let editor: HTMLElement | null;
    try {
      editor = options.adapter.findEditorForSendButton(button);
      if (!editor) throw new Error('Cannot identify the editor for the send button');
    } catch (error) {
      // 전송 버튼은 확인했지만 입력창이 모호하면 원문을 자동 전송하지 않습니다.
      hold(event);
      options.onError?.(error);
      return;
    }
    intercept(event, editor, 'button');
  }

  function onEnterFollowup(event: Event): void {
    const keyboard = event as KeyboardEvent;
    if (keyboard.key !== 'Enter' || !heldEditor) return;
    // 같은 Enter의 keypress/keyup을 전송에 쓰는 페이지도 함께 보류합니다.
    if (options.adapter.findEditor(event) === heldEditor) hold(event);
    if (event.type === 'keyup') heldEditor = null;
  }

  function onCompositionStart(event: Event): void {
    const editor = options.adapter.findEditor(event);
    if (editor) composing.add(editor);
  }

  function onCompositionEnd(event: Event): void {
    const editor = options.adapter.findEditor(event);
    if (editor) composing.delete(editor);
  }

  const listeners: [string, EventListener][] = [
    ['keydown', onKeyDown],
    ['keypress', onEnterFollowup],
    ['keyup', onEnterFollowup],
    ['compositionstart', onCompositionStart],
    ['compositionend', onCompositionEnd],
    ['click', onClick],
  ];

  return {
    sendApproved(button, editor, text) {
      if (!started || !editor.isConnected || !button.isConnected) throw new Error('Send target is unavailable');
      const event = new button.ownerDocument.defaultView!.MouseEvent('click', {
        bubbles: true, cancelable: true, composed: true,
      });
      const approval = { event, editor, text, button, consumed: false };
      approvedClick = approval;
      try {
        button.dispatchEvent(event);
        if (!approval.consumed) throw new Error('Approved send was not accepted');
      } finally { approvedClick = null; }
    },
    start() {
      if (started) return;
      started = true;
      for (const [type, listener] of listeners) root.addEventListener(type, listener, true);
    },
    stop() {
      if (!started) return;
      started = false;
      for (const [type, listener] of listeners) root.removeEventListener(type, listener, true);
      composing = new WeakSet();
      heldEditor = null;
      approvedClick = null;
    },
  };
}
