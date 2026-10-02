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

/** DOM 참조를 캐시하지 않아 SPA에서 입력창이 교체되어도 다시 찾습니다. */
export function createDomTextAdapter(
  siteId: RegisteredSiteId,
  editorSelector: string,
): TextSiteAdapter {
  return {
    siteId,
    findEditor(event) {
      for (const target of event.composedPath()) {
        if (!(target instanceof HTMLElement)) continue;
        const editor = target.closest<HTMLElement>(editorSelector);
        if (!editor || !editor.isConnected) continue;
        if (editor.matches('[disabled], [readonly], [aria-disabled="true"]')) continue;
        if (!isTextEditor(editor)) continue;
        return editor;
      }
      return null;
    },
    readText(editor) {
      if (editor.matches('textarea')) return (editor as HTMLTextAreaElement).value;
      return editor.innerText;
    },
  };
}
