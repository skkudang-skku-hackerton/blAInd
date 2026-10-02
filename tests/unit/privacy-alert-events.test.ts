import { afterEach, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { analyzeDetections, mountPrivacyAlert } from '../../src/alert';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const { document, window } = parseHTML('<html><body><div id="host"></div></body></html>');
  vi.stubGlobal('document', document);
  const host = document.querySelector('#host')!;
  const onComplete = vi.fn(), onCancel = vi.fn();
  const cleanup = mountPrivacyAlert(host as unknown as HTMLElement, {
    analysis: analyzeDetections('김민수', [{ type: 'PERSON', confidence: 1, span: { start: 0, end: 3 } }]),
    onComplete, onCancel,
  });
  // A page-level delegated handler would dismiss/re-render the upload context.
  const pageHandler = vi.fn(() => host.remove());
  const dispatch = (selector: string, type: string, key?: string) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true, composed: true });
    if (key) Object.defineProperty(event, 'key', { value: key });
    host.querySelector(selector)!.dispatchEvent(event);
    return event;
  };
  return { document, host, onComplete, onCancel, cleanup, pageHandler, dispatch };
}

it.each(['click', 'pointerdown', 'mousedown', 'input', 'change', 'keydown'])(
  'keeps internal %s events away from delegated page handlers', type => {
    const f = setup();
    f.document.addEventListener(type, f.pageHandler);
    const event = f.dispatch('input', type);
    expect(f.pageHandler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(f.host.querySelector('[role=dialog]')).not.toBeNull();
    expect(f.onComplete).not.toHaveBeenCalled();
    expect(f.onCancel).not.toHaveBeenCalled();
    f.cleanup();
  },
);

it.each(['.blaind-alert-keep', '.blaind-alert-mask', '.blaind-alert-cancel'])(
  'does not leak the closing click from %s after cleanup', selector => {
    const f = setup();
    f.document.addEventListener('click', f.pageHandler);
    f.dispatch(selector, 'click');
    expect(f.pageHandler).not.toHaveBeenCalled();
    expect(selector.endsWith('cancel') ? f.onCancel : f.onComplete).toHaveBeenCalledOnce();
    expect(f.host.querySelector('[role=dialog]')).toBeNull();
  },
);

it('handles Escape inside the dialog without forwarding it to the page', () => {
  const f = setup();
  f.document.addEventListener('keydown', f.pageHandler);
  f.dispatch('input', 'keydown', 'Escape');
  expect(f.onCancel).toHaveBeenCalledOnce();
  expect(f.pageHandler).not.toHaveBeenCalled();
});
