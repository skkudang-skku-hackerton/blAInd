import { protectStatusUi } from '../../shared/status-ui-events.ts';

/** 검사 진행과 전송 보류 상태를 표시하는 안내. */
export function createHoldNotice(page: Document = document) {
  let host: HTMLDivElement | null = null;
  let messageNode: HTMLParagraphElement | null = null;
  let unprotect: (() => void) | undefined;

  function dismiss(): void {
    unprotect?.();
    unprotect = undefined;
    host?.remove();
    host = null;
    messageNode = null;
  }

  return {
    show(message: string): void {
      if (!host?.isConnected) {
        dismiss();
        host = page.createElement('div');
        host.dataset.blaindNotice = 'hold';
        host.style.cssText = 'all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;';
        const shadow = host.attachShadow({ mode: 'open' });
        const style = page.createElement('style');
        style.textContent = `
          :host { color-scheme: light; }
          section { box-sizing:border-box; width:320px; max-width:calc(100vw - 40px);
            padding:16px; border:1px solid #E7E7E3; border-radius:8px;
            background:#FFFFFF; color:#191919; font:14px/1.6 system-ui,sans-serif;
            box-shadow:none; }
          strong { font-size:14px; } p { color:#6F6F6B; margin:8px 0 12px; }
          button { padding:5px 12px; border:1px solid #E7E7E3; border-radius:6px;
            background:#FCFCFB; color:#191919; font:inherit; cursor:pointer; }
          button:hover { background:#F1F3FF; }
          button:focus-visible { outline:2px solid #191919; outline-offset:2px; }
        `;
        const panel = page.createElement('section');
        panel.setAttribute('role', 'status');
        panel.setAttribute('aria-live', 'polite');
        const title = page.createElement('strong');
        title.textContent = 'blAInd · 전송 보류';
        messageNode = page.createElement('p');
        const close = page.createElement('button');
        close.type = 'button';
        close.textContent = '닫기';
        unprotect = protectStatusUi(host, close, dismiss);
        panel.append(title, messageNode, close);
        shadow.append(style, panel);
        (page.body ?? page.documentElement).append(host);
      }
      messageNode!.textContent = message;
    },
    dispose: dismiss,
  };
}
