import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { mountPrivacyAlert } from '../../src/alert/PrivacyAlert';
import { analyzeDetections } from '../../src/alert/policy';
import type { Detection } from '../../src/alert/types';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));

function setup(mode: 'mixed' | 'overlap' | 'automatic' | 'empty' = 'mixed') {
  const { document, window } = parseHTML('<html><body><div id="host"></div></body></html>');
  const host = document.querySelector<HTMLElement>('#host')!;
  const text = '김민수 · AB-2048 · 010-1234-5678 <script>';
  const detection = (type: Detection['type'], value: string): Detection => ({
    type, confidence: 1, span: { start: text.indexOf(value), end: text.indexOf(value) + value.length },
  });
  const phone = detection('PHONE', '010-1234-5678');
  const detections = mode === 'empty' ? [] : mode === 'automatic' ? [phone] : [
    phone, detection('GENERIC_ID', 'AB-2048'), detection('PERSON', '김민수'),
    ...(mode === 'overlap' ? [detection('ADDRESS', '김민수 ·'), detection('SECRET', '민')] : []),
  ];
  const analysis = analyzeDetections(text, detections);
  const onComplete = vi.fn(), onCancel = vi.fn(), onSelectionChange = vi.fn();
  cleanups.push(mountPrivacyAlert(host, { analysis, onComplete, onCancel, onSelectionChange }));
  const checkbox = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label} 가리기"]`)!;
  const all = host.querySelector<HTMLInputElement>('.blaind-alert-select-all');
  const preview = host.querySelector<HTMLElement>('.blaind-alert-document')!;
  const previewFor = (label: string) => preview.querySelector<HTMLButtonElement>(`button[aria-label*="${label}"]`)!;
  const change = (input: HTMLInputElement, checked: boolean) => {
    input.checked = checked;
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const click = (selector: string) => host.querySelector<HTMLElement>(selector)!.click();
  return { host, text, analysis, checkbox, all, preview, previewFor, change, click,
    onComplete, onCancel, onSelectionChange };
}

describe('privacy review selection', () => {
  it('lists all detections in source order and initially selects only automatic defaults', () => {
    const f = setup();
    expect([...f.host.querySelectorAll('.blaind-alert-value')].map(node => node.textContent))
      .toEqual(['김민수', 'AB-2048', '010-1234-5678']);
    expect(f.checkbox('전화번호').checked).toBe(true);
    expect(f.checkbox('이름').checked).toBe(false);
    expect(f.checkbox('기타 식별번호').checked).toBe(false);
    expect(f.all!.checked).toBe(false);
    expect(f.all!.indeterminate).toBe(true);
    expect(f.previewFor('전화번호').getAttribute('data-state')).toBe('selected');
    expect(f.previewFor('전화번호').getAttribute('aria-pressed')).toBe('true');
    expect(f.preview.textContent).not.toContain('010-1234-5678');
    expect(f.preview.textContent).toContain('<script>');
    expect(f.preview.querySelector('script')).toBeNull();
    expect(f.onSelectionChange).not.toHaveBeenCalled();
  });

  it('selects and clears all categories while notifying only changed decisions', () => {
    const f = setup();
    f.change(f.checkbox('이름'), true);
    expect(f.all!.indeterminate).toBe(true);
    f.change(f.all!, true);
    expect(f.all!.checked).toBe(true);
    expect(f.all!.indeterminate).toBe(false);
    f.change(f.all!, false);
    expect([...f.host.querySelectorAll<HTMLInputElement>('.blaind-alert-items input')].every(input => !input.checked)).toBe(true);
    expect(f.all!.indeterminate).toBe(false);
    expect(f.preview.textContent).toBe(f.text);
    expect(f.onSelectionChange.mock.calls.map(([item, checked]) => [item.type, checked])).toEqual([
      ['PERSON', true], ['GENERIC_ID', true], ['PERSON', false], ['GENERIC_ID', false], ['PHONE', false],
    ]);
  });

  it('toggles automatic and optional selections from the preview and submits the current decisions', () => {
    const f = setup();
    f.previewFor('전화번호').click();
    expect(f.checkbox('전화번호').checked).toBe(false);
    expect(f.previewFor('전화번호').textContent).toBe('010-1234-5678');
    expect(f.previewFor('전화번호').getAttribute('data-state')).toBe('confirm');
    f.previewFor('이름').click();
    expect(f.checkbox('이름').checked).toBe(true);
    expect(f.previewFor('이름').getAttribute('data-state')).toBe('selected');
    expect(f.onSelectionChange.mock.calls.map(([item, checked]) => [item.type, checked]))
      .toEqual([['PHONE', false], ['PERSON', true]]);
    f.click('.blaind-alert-mask');
    const result = f.onComplete.mock.calls[0]![0];
    expect(result.autoMask).toEqual([]);
    expect(result.confirm.masking.map((item: Detection) => item.type)).toEqual(['PERSON']);
  });

  it('masks overlapping fragments whenever any covering detection is selected', () => {
    const f = setup('overlap');
    const fragment = f.previewFor('비밀번호');
    expect(fragment.getAttribute('data-state')).toBe('selected');
    fragment.click();
    expect(f.checkbox('비밀번호 · 키').checked).toBe(false);
    expect(f.checkbox('이름').checked).toBe(false);
    expect(f.checkbox('주소').checked).toBe(false);
    expect(fragment.textContent).toBe('민');
    f.change(f.checkbox('이름'), true);
    expect(fragment.getAttribute('data-state')).toBe('selected');
    f.change(f.checkbox('주소'), true);
    f.change(f.checkbox('이름'), false);
    expect(fragment.getAttribute('aria-pressed')).toBe('true');
    expect(fragment.textContent).not.toBe('민');
    fragment.click();
    expect(f.checkbox('주소').checked).toBe(false);
    expect(fragment.getAttribute('data-state')).toBe('confirm');
    expect(fragment.textContent).toBe('민');
  });

  it('allows an automatic-only review to uncheck its default and submit no masking', () => {
    const f = setup('automatic');
    expect(f.all!.checked).toBe(true);
    expect(f.host.querySelector('.blaind-alert-list')).not.toBeNull();
    f.change(f.checkbox('전화번호'), false);
    f.click('.blaind-alert-mask');
    expect(f.onComplete.mock.calls[0]![0]).toMatchObject({ autoMask: [], confirm: { masking: [] } });
  });

  it('proceeds with no masking when original text is requested, even with everything selected', () => {
    const f = setup(); f.change(f.all!, true); f.click('.blaind-alert-keep');
    expect(f.onComplete.mock.calls[0]![0]).toMatchObject({ autoMask: [], confirm: { masking: [] } });
  });

  it('hides selection controls when no detections exist', () => {
    const f = setup('empty');
    expect(f.host.querySelector('.blaind-alert-list')).toBeNull();
    expect(f.host.querySelector('.blaind-alert-mask')).toBeNull();
    expect(f.preview.textContent).toBe(f.text);
    f.click('.blaind-alert-keep');
    expect(f.onComplete.mock.calls[0]![0]).toMatchObject({ autoMask: [], confirm: { masking: [] } });
  });

  it.each(['keep', 'mask', 'cancel'])('finishes only once when the %s button is retained', action => {
    const f = setup();
    const button = f.host.querySelector<HTMLButtonElement>(`.blaind-alert-${action}`)!;
    button.click(); button.click();
    expect(action === 'cancel' ? f.onCancel : f.onComplete).toHaveBeenCalledOnce();
    expect(action === 'cancel' ? f.onComplete : f.onCancel).not.toHaveBeenCalled();
    expect(f.host.querySelector('[role=dialog]')).toBeNull();
  });
});
