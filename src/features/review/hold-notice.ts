import { protectStatusUi } from '../../shared/status-ui-events.ts';
import { createPopupLogo, popupThemeStyles } from '../../alert/popup-theme';
import { ensureAlertFonts } from '../../alert/typography';

/** Show a single central notice for a held send, a document error or cancellation. */
export function createHoldNotice(page: Document = document) {
  let host: HTMLDivElement | null = null;
  let messageNode: HTMLParagraphElement | null = null;
  let unprotect: (() => void) | undefined;
  let previousFocus: HTMLElement | null = null;
  let removeDialogEvents: (() => void) | undefined;
  let removeClosingKeyGuard: (() => void) | undefined;

  function dismiss(closingKey?: string): void {
    const restoreFocus = host?.isConnected && page.activeElement === host;
    removeClosingKeyGuard?.();
    if (closingKey) {
      // Focus returns to the composer immediately. Consume the rest of this
      // key press there as well so closing cannot trigger a site action.
      const view = page.defaultView!;
      const clear = () => {
        view.removeEventListener('keydown', consume, true);
        view.removeEventListener('keyup', consume, true);
        view.removeEventListener('blur', clear);
        removeClosingKeyGuard = undefined;
      };
      const consume = (event: KeyboardEvent) => {
        if (event.key !== closingKey) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type === 'keyup') clear();
      };
      view.addEventListener('keydown', consume, true);
      view.addEventListener('keyup', consume, true);
      view.addEventListener('blur', clear);
      removeClosingKeyGuard = clear;
    }
    removeDialogEvents?.();
    removeDialogEvents = undefined;
    unprotect?.();
    unprotect = undefined;
    host?.remove();
    host = null;
    messageNode = null;
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus();
    previousFocus = null;
  }

  return {
    show(message: string): void {
      if (!host?.isConnected) {
        dismiss();
        ensureAlertFonts(page);
        previousFocus = page.activeElement as HTMLElement | null;
        host = page.createElement('div');
        host.dataset.blaindNotice = 'hold';
        host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
        const shadow = host.attachShadow({ mode: 'open' });
        const style = page.createElement('style');
        style.textContent = popupThemeStyles;
        const backdrop = page.createElement('div');
        backdrop.className = 'blaind-popup-backdrop';
        const panel = page.createElement('section');
        panel.className = 'blaind-popup blaind-popup-dialog';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-labelledby', 'blaind-notice-title');
        panel.setAttribute('aria-describedby', 'blaind-notice-message');
        const title = page.createElement('strong');
        title.className = 'blaind-popup-header';
        const titleText = page.createElement('span');
        titleText.id = 'blaind-notice-title';
        titleText.textContent = '전송 보류';
        title.append(createPopupLogo(page), titleText);
        messageNode = page.createElement('p');
        messageNode.id = 'blaind-notice-message';
        messageNode.className = 'blaind-popup-message';
        messageNode.setAttribute('aria-live', 'polite');
        const footer = page.createElement('footer');
        footer.className = 'blaind-popup-footer';
        const close = page.createElement('button');
        close.className = 'blaind-popup-button blaind-popup-button-primary';
        close.type = 'button';
        close.textContent = '닫기';
        // Handle modal navigation before the site's capture listeners and the
        // status guard. Dismissing must consume the event before restoring focus.
        const view = page.defaultView!;
        const onKey = (event: KeyboardEvent) => {
          if (!host || !event.composedPath().includes(host)) return;
          const closing = event.key === 'Escape' || event.composedPath().includes(close) &&
            (event.key === 'Enter' || event.key === ' ');
          if (!closing && event.key !== 'Tab') return;
          event.preventDefault();
          event.stopImmediatePropagation();
          if (closing) {
            if (!event.repeat) dismiss(event.key);
          } else close.focus();
        };
        const onBackdrop = (event: MouseEvent) => {
          if (event.composedPath()[0] !== backdrop) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          dismiss();
        };
        view.addEventListener('keydown', onKey, true);
        view.addEventListener('click', onBackdrop, true);
        removeDialogEvents = () => {
          view.removeEventListener('keydown', onKey, true);
          view.removeEventListener('click', onBackdrop, true);
        };
        unprotect = protectStatusUi(host, close, dismiss);
        footer.append(close);
        panel.append(title, messageNode, footer);
        backdrop.append(panel);
        shadow.append(style, backdrop);
        messageNode.textContent = message;
        (page.body ?? page.documentElement).append(host);
        close.focus();
      }
      messageNode!.textContent = message;
    },
    dispose: dismiss,
  };
}
