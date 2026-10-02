import type { RegisteredSiteId } from '../../sites/registry.ts';
import type { TextSiteAdapter } from './types.ts';

function isTextEditor(editor: HTMLElement): boolean {
  if (editor.matches('textarea')) return true;
  const editable = editor.getAttribute('contenteditable')?.toLowerCase();
  if (editable === 'false') return false;
  if (editable === '' || editable === 'true' || editable === 'plaintext-only') return true;
  // 속성이 없거나 유효하지 않은 경우 상속 여부는 브라우저가 판단합니다.
  return editor.isContentEditable === true;
}

function isAvailableEditor(editor: HTMLElement): boolean {
  return editor.isConnected &&
    !editor.matches('[disabled], [readonly], [aria-disabled="true"]') &&
    isTextEditor(editor);
}

function isVisibleEditor(editor: HTMLElement): boolean {
  if (editor.closest('[hidden], [aria-hidden="true"]')) return false;
  // 브라우저에서는 숨겨진 보조 textarea를 제외합니다. LinkeDOM은 레이아웃 API가 없습니다.
  return typeof editor.getClientRects !== 'function' || editor.getClientRects().length > 0;
}

function isAvailableSendButton(button: HTMLElement): boolean {
  if (!button.isConnected || !button.matches('button, [role="button"]')) return false;
  if (button.matches(':disabled, [disabled], [aria-disabled="true"]')) return false;
  // 생성 중에는 같은 버튼 ID·클래스를 중지 기능에 쓰는 사이트도 있습니다.
  if (button.matches('[data-testid="stop-button"], [data-test-id="stop-button"], .stop-button')) return false;
  const label = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''}`;
  return !/stop|중지|정지/i.test(label);
}

/** DOM 참조를 캐시하지 않아 SPA에서 입력창이 교체되어도 다시 찾습니다. */
export function createDomTextAdapter(
  siteId: RegisteredSiteId,
  editorSelector: string,
  sendButtonSelector?: string,
): TextSiteAdapter {
  function editorsIn(scope: HTMLElement): HTMLElement[] {
    const editors = [...scope.querySelectorAll<HTMLElement>(editorSelector)];
    if (scope.matches(editorSelector)) editors.unshift(scope);
    return editors.filter((editor) => isAvailableEditor(editor) && isVisibleEditor(editor));
  }

  const adapter: TextSiteAdapter = {
    siteId,
    findEditor(event) {
      for (const target of event.composedPath()) {
        if (!(target instanceof HTMLElement)) continue;
        const editor = target.closest<HTMLElement>(editorSelector);
        if (!editor || !isAvailableEditor(editor)) continue;
        return editor;
      }
      return null;
    },
    findSendButton(event) {
      if (!sendButtonSelector) return null;
      for (const target of event.composedPath()) {
        if (!(target instanceof HTMLElement)) continue;
        const button = target.closest<HTMLElement>(sendButtonSelector);
        if (button && isAvailableSendButton(button)) return button;
      }
      return null;
    },
    findEditorForSendButton(button) {
      // 버튼과 같은 form을 먼저 사용합니다. 다른 form의 원문을 고르지 않습니다.
      const form = (button as HTMLButtonElement).form ?? button.closest('form');
      if (form) {
        const editors = editorsIn(form);
        return editors.length === 1 ? editors[0] ?? null : null;
      }
      // form 없는 사이트에서는 가장 가까운 공통 입력 영역을 찾습니다.
      for (let scope = button.parentElement; scope; scope = scope.parentElement) {
        const editors = editorsIn(scope);
        if (editors.length > 0) return editors.length === 1 ? editors[0] ?? null : null;
      }
      return null;
    },
    findSendButtonForEditor(editor) {
      if (!sendButtonSelector || !isAvailableEditor(editor)) return null;
      const buttons = [...editor.ownerDocument.querySelectorAll<HTMLElement>(sendButtonSelector)]
        .filter(button => isAvailableSendButton(button) && isVisibleEditor(button)
          && adapter.findEditorForSendButton(button) === editor);
      return buttons.length === 1 ? buttons[0]! : null;
    },
    replaceText(editor, text) {
      if (!isAvailableEditor(editor)) throw new Error('Editor is unavailable');
      const page = editor.ownerDocument;
      editor.focus();
      if (editor.matches('textarea')) {
        const setter = Object.getOwnPropertyDescriptor(page.defaultView!.HTMLTextAreaElement.prototype, 'value')?.set;
        if (!setter) throw new Error('Textarea setter is unavailable');
        setter.call(editor, text);
        editor.dispatchEvent(new page.defaultView!.Event('input', { bubbles: true, composed: true }));
      } else {
        const selection = page.getSelection();
        if (!selection) throw new Error('Editor selection is unavailable');
        const range = page.createRange();
        range.selectNodeContents(editor);
        selection.removeAllRanges();
        selection.addRange(range);
        // ProseMirror/Quill 등의 편집 상태에도 브라우저 입력 트랜잭션을 전달합니다.
        if (!page.execCommand('insertText', false, text)) throw new Error('Editor replacement failed');
      }
      if (adapter.readText(editor) !== text) throw new Error('Editor replacement did not match approved text');
    },
    readText(editor) {
      if (editor.matches('textarea')) return (editor as HTMLTextAreaElement).value;
      return editor.innerText;
    },
  };
  return adapter;
}
