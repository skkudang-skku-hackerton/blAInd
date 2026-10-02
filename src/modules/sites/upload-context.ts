/** A batch may only write back into the conversation and composer that created it. */
export interface UploadContext {
  isValid(): boolean;
  resolveInput(preferred: HTMLInputElement | null, accept?: string): HTMLInputElement | null;
  watch(onInvalid: () => void): () => void;
}

export function captureUploadContext(target: EventTarget | null, root: Document | ShadowRoot): UploadContext {
  const element = target instanceof Element ? target : null;
  const document = root instanceof Document ? root : root.ownerDocument;
  const view = document.defaultView!;
  const href = view.location?.href;
  // Never search the whole document. A surviving composer can host a replacement input.
  const scope = element?.closest('form, [data-conversation-id], [data-chat-id]') ?? null;
  const identities: Array<[Element, string, string]> = [];
  for (let parent = element; parent; parent = parent.parentElement) {
    for (const name of ['data-conversation-id', 'data-chat-id']) {
      const value = parent.getAttribute(name);
      if (value) identities.push([parent, name, value]);
    }
  }
  const hasConversationId = identities.length > 0 || !!href && /\/(?:c|chat|app)\/[^/?#]+/.test(new URL(href).pathname);
  let invalid = false;
  const isValid = () => {
    if (invalid) return false;
    const anchor = scope ?? element;
    if (!href || view.location.href !== href || !anchor?.isConnected || !root.contains(anchor) ||
        (scope && element?.isConnected && !scope.contains(element)) ||
        identities.some(([node, name, value]) => !node.isConnected || node.getAttribute(name) !== value)) {
      invalid = true;
    }
    return !invalid;
  };
  return {
    isValid,
    resolveInput(preferred, accept) {
      if (!isValid()) return null;
      if (preferred?.isConnected && root.contains(preferred) && (!scope || scope.contains(preferred))) return preferred;
      // Rerender fallback needs both a stable conversation identity and the original composer.
      if (!hasConversationId || !scope) return null;
      const inputs = Array.from(scope.querySelectorAll<HTMLInputElement>('input[type=file]'))
        .filter((input) => !input.disabled && (accept === undefined || input.accept === accept));
      return inputs.length === 1 ? inputs[0]! : null;
    },
    watch(onInvalid) {
      const check = () => { if (!isValid()) onInvalid(); };
      const navigation = (view as Window & { navigation?: EventTarget }).navigation;
      // Navigation API events cross the page/content-script boundary, unlike patches to
      // isolated-world history.pushState. Also catches away-and-back navigation immediately.
      const navigating = () => { invalid = true; onInvalid(); };
      navigation?.addEventListener('navigate', navigating);
      navigation?.addEventListener('currententrychange', check);
      view.addEventListener('popstate', check);
      view.addEventListener('hashchange', check);
      view.addEventListener('pagehide', navigating);
      const observer = new MutationObserver(check);
      observer.observe(root, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['data-conversation-id', 'data-chat-id'] });
      // Fallback for environments without the Navigation API; validity is also checked
      // synchronously immediately before reinjection.
      const timer = view.setInterval(check, 100);
      check();
      return () => {
        navigation?.removeEventListener('navigate', navigating);
        navigation?.removeEventListener('currententrychange', check);
        view.removeEventListener('popstate', check);
        view.removeEventListener('hashchange', check);
        view.removeEventListener('pagehide', navigating);
        observer.disconnect();
        view.clearInterval(timer);
      };
    },
  };
}
