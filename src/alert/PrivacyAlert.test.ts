import { expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { mountPrivacyAlert } from './PrivacyAlert';
import { analyzeDetections } from './policy';

function setup(overlap = false) {
  const { document, window } = parseHTML('<html><body><div id="host"></div></body></html>');
  const host = document.querySelector<HTMLElement>('#host')!;
  const onComplete = vi.fn(), onSelectionChange = vi.fn();
  const analysis = analyzeDetections('김민수의 사번 AB-2048, 전화 010-1234-5678 <script>', [
    { type: 'PERSON', confidence: 1, span: { start: 0, end: 3 } },
    { type: 'GENERIC_ID', confidence: 1, span: { start: 8, end: 15 } },
    { type: 'PHONE', confidence: 1, span: { start: 20, end: 33 } },
    ...(overlap ? [{ type: 'ADDRESS' as const, confidence: 1, span: { start: 0, end: 5 } },
      { type: 'SECRET' as const, confidence: 1, span: { start: 1, end: 2 } }] : []),
  ]);
  const cleanup = mountPrivacyAlert(host, { analysis, onComplete, onSelectionChange });
  const inputs = [...host.querySelectorAll<HTMLInputElement>('.blaind-alert-items input')];
  const all = host.querySelector<HTMLInputElement>('.blaind-alert-select-all')!;
  const change = (input: HTMLInputElement, checked: boolean) => {
    input.checked = checked;
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const click = (selector: string) => host.querySelector(selector)!.dispatchEvent(new window.Event('click', { bubbles: true }));
  return { host, inputs, all, cleanup, change, click, onComplete, onSelectionChange };
}

it('selects and clears all items, including partial selection and callbacks', () => {
  const f = setup();
  f.change(f.inputs[0]!, true);
  expect(f.all.indeterminate).toBe(true);
  f.change(f.all, true);
  expect(f.inputs.every(input => input.checked)).toBe(true);
  expect(f.all.indeterminate).toBe(false);
  expect(f.onSelectionChange).toHaveBeenCalledTimes(2);
  f.change(f.all, false);
  expect(f.inputs.every(input => !input.checked)).toBe(true);
  expect(f.onSelectionChange).toHaveBeenCalledTimes(4);
  f.cleanup();
});

it('links preview clicks to selections and submits the selected masking decisions', () => {
  const f = setup();
  f.click('.blaind-alert-document button');
  expect(f.inputs[0]!.checked).toBe(true);
  expect(f.host.querySelector('.blaind-alert-document button')!.getAttribute('data-state')).toBe('selected');
  f.change(f.all, true);
  f.click('.blaind-alert-mask');
  const result = f.onComplete.mock.calls[0]![0];
  expect(result.confirm.masking.map((item: { type: string }) => item.type)).toEqual(['PERSON', 'GENERIC_ID']);
  expect(result.autoMask[0].type).toBe('PHONE');
  expect(f.host.querySelector('[role=dialog]')).toBeNull();
});

it('renders source as text and keeps automatic spans protected across overlapping selections', () => {
  const f = setup(true);
  const preview = f.host.querySelector('.blaind-alert-document')!;
  expect(preview.querySelector('script')).toBeNull();
  expect(preview.textContent).toContain('<script>');
  expect(preview.textContent).not.toContain('010-1234-5678');
  const automatic = [...preview.querySelectorAll('[data-state=auto]')].map(node => node.textContent);
  f.change(f.all, true);
  f.change(f.all, false);
  expect([...preview.querySelectorAll('[data-state=auto]')].map(node => node.textContent)).toEqual(automatic);
  f.cleanup();
});
