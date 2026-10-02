import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createTextReviewController } from '../../src/features/review/text-review';
import { applyMasking } from '../../src/alert/masking';
import type { TextScanResult } from '../../src/features/review/text-scan';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
function setup(detections: TextScanResult['detections'] = [
  { type: 'PERSON', confidence: 0.99, span: { start: 0, end: 3 } },
  { type: 'PHONE', confidence: 0.99, span: { start: 4, end: 17 } },
]) {
  const { document, window } = parseHTML('<html><body><textarea></textarea></body></html>');
  vi.stubGlobal('document', document);
  const attachShadow = window.Element.prototype.attachShadow;
  vi.spyOn(window.Element.prototype, 'attachShadow').mockImplementation(function (this: Element) {
    return attachShadow.call(this, { mode: 'open' });
  });
  const editor = document.querySelector('textarea')!;
  editor.value = '김민수 010-1234-5678';
  let current: TextScanResult | null = {
    text: editor.value, editor: editor as unknown as HTMLElement,
    detections, siteId: 'chatgpt', source: 'enter',
  };
  const onApproved = vi.fn(), onCancelled = vi.fn(), onError = vi.fn();
  const review = createTextReviewController({ getCurrentResult: () => current, onApproved, onCancelled, onError });
  cleanups.push(review.dispose);
  review.open(current);
  const root = () => document.querySelector('[data-blaind-review]')?.shadowRoot;
  const click = (selector: string) => root()!.querySelector(selector)!.dispatchEvent(new window.Event('click', { bubbles: true }));
  return { review, root, click, editor, onApproved, onCancelled, onError,
    invalidate: () => { current = null; } };
}

describe('model result → privacy review → preview output', () => {
  it('shows the detected value and masks selected Confirm plus mandatory Auto items', () => {
    const f = setup();
    expect(f.root()!.querySelector('[role=dialog]')!.textContent).toContain('김민수');
    f.root()!.querySelector('input')!.setAttribute('checked', '');
    f.click('.blaind-alert-mask');
    expect(f.onApproved).toHaveBeenCalledExactlyOnceWith('[PERSON_1] [PHONE_1]');
    expect(f.editor.value).toBe('김민수 010-1234-5678');
    expect(f.root()).toBeUndefined();
    expect(f.onError).not.toHaveBeenCalled();
  });
  it('keeps unselected Confirm but always masks Auto', () => {
    const f = setup(); f.click('.blaind-alert-keep');
    expect(f.onApproved).toHaveBeenCalledExactlyOnceWith('김민수 [PHONE_1]');
  });
  it.each([false, true])('reviews constituents of a merged region independently (select Confirm: %s)', selectConfirm => {
    const f = setup([{
      type: 'PHONE', confidence: 0.99, span: { start: 0, end: 17 }, constituents: [
        { type: 'PERSON', confidence: 0.95, span: { start: 0, end: 7 } },
        { type: 'PHONE', confidence: 0.99, span: { start: 4, end: 17 } },
      ],
    }]);
    expect(f.root()!.querySelectorAll('input')).toHaveLength(1);
    expect(f.root()!.querySelector('.blaind-alert-value')!.textContent).toBe('김민수 010');
    if (selectConfirm) f.root()!.querySelector('input')!.setAttribute('checked', '');
    f.click(selectConfirm ? '.blaind-alert-mask' : '.blaind-alert-keep');
    expect(f.onApproved).toHaveBeenCalledExactlyOnceWith(selectConfirm ? '[PERSON_1]' : '김민수 [PHONE_1]');
  });
  it('cancel produces no output', () => {
    const f = setup(); f.click('.blaind-alert-cancel');
    expect(f.onApproved).not.toHaveBeenCalled();
    expect(f.onCancelled).toHaveBeenCalledOnce();
  });
  it('rejects stale approval even before the periodic check', () => {
    const f = setup(); f.invalidate(); f.click('.blaind-alert-keep');
    expect(f.onApproved).not.toHaveBeenCalled();
    expect(f.root()).toBeUndefined();
  });
  it('removes a stale dialog and disposes its timer', () => {
    vi.useFakeTimers();
    const f = setup(); f.invalidate(); vi.advanceTimersByTime(100);
    expect(f.root()).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });
  it('requires approval even when no detections exist', () => {
    const f = setup([]);
    expect(f.root()!.querySelector('[role=dialog]')!.textContent).toContain('탐지된 개인정보가 없습니다');
    expect(f.onApproved).not.toHaveBeenCalled();
    f.click('.blaind-alert-keep');
    expect(f.onApproved).toHaveBeenCalledExactlyOnceWith(f.editor.value);
  });
  it('cannot complete twice from a retained button', () => {
    const f = setup(); const button = f.root()!.querySelector<HTMLButtonElement>('button.blaind-alert-keep')!;
    button.click(); button.click(); expect(f.onApproved).toHaveBeenCalledOnce();
  });
});

describe('mask aliases', () => {
  it('reuses labels for exact values and assigns distinct values in original order', () => {
    const d = (start: number, end: number): TextScanResult['detections'][number] =>
      ({ type: 'PERSON', confidence: 1, span: { start, end } });
    expect(applyMasking('김민수 이영희 김민수', [d(8, 11), d(4, 7), d(0, 3)]))
      .toBe('[PERSON_1] [PERSON_2] [PERSON_1]');
    expect(applyMasking('이영희', [d(0, 3)])).toBe('[PERSON_1]');
  });
});
