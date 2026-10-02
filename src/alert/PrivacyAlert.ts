import { buildReviewResult } from './policy';
import { ensureAlertFonts } from './typography';
import { createPopupLogo, popupThemeStyles } from './popup-theme';
import { PII_LABELS as labels } from '../core/pii/preferences';
import type { ApprovedReview, Detection, PrivacyAnalysis } from './types';

export interface PrivacyAlertOptions {
  analysis: PrivacyAnalysis;
  onComplete: (result: ApprovedReview) => void;
  onSelectionChange?: (detection: Detection, masking: boolean) => void;
  onCancel?: () => void;
  itemContext?: (detection: Detection) => string;
}

function detectedText(text: string, detection: Detection): string {
  return text.slice(detection.span.start, detection.span.end);
}

/** Mounts an accessible privacy review dialog. The caller owns the host and should call the returned cleanup. */
export function mountPrivacyAlert(host: HTMLElement, options: PrivacyAlertOptions): () => void {
  const document = host.ownerDocument;
  ensureAlertFonts(document);
  const { analysis, onComplete, onCancel } = options;
  const automaticDetections = new Set(analysis.autoMaskedDetections);
  const detections = [...analysis.autoMaskedDetections, ...analysis.confirmDetections]
    .sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
  const previousFocus = document.activeElement as HTMLElement | null;
  const style = document.createElement('style');
  style.textContent = `${popupThemeStyles}\n${alertStyles}`;
  const overlay = document.createElement('div');
  overlay.className = 'blaind-alert-backdrop';
  // Shadow DOM isolates styles, but composed UI events still reach the site's
  // delegated handlers. Stop bubbling after our controls have handled them.
  // Keep these listeners on the detached overlay during cleanup too: the click
  // that approves/cancels is still in flight when its button removes the dialog.
  for (const type of [
    'click', 'dblclick', 'contextmenu', 'pointerdown', 'pointerup',
    'mousedown', 'mouseup', 'touchstart', 'touchend',
    'keydown', 'keypress', 'keyup', 'input', 'change', 'focusin', 'focusout',
  ]) overlay.addEventListener(type, event => event.stopPropagation());
  overlay.innerHTML = `<section class="blaind-alert" role="dialog" aria-modal="true" aria-label="가릴 항목 선택" tabindex="-1">
    <header class="blaind-alert-header"><p class="blaind-alert-eyebrow blaind-popup-header"><span>개인정보 확인</span></p></header>
    <div class="blaind-alert-workspace">
      <section class="blaind-alert-preview" aria-label="보호할 내용">
        <div class="blaind-alert-preview-legend"><span class="blaind-legend-confirm">선택 가능</span><span class="blaind-legend-selected">선택한 항목</span></div>
        <div class="blaind-alert-document" role="region" aria-label="보호할 내용 미리보기" tabindex="0"></div>
      </section>
      <fieldset class="blaind-alert-list"><legend>가릴 항목 선택</legend>
        <div class="blaind-alert-selection-toolbar"><label><input type="checkbox" class="blaind-alert-select-all"> 전체 선택</label><span class="blaind-alert-selection-count" role="status"></span></div>
        <div class="blaind-alert-items"></div>
      </fieldset>
    </div>
    <footer class="blaind-alert-actions"><button type="button" class="blaind-alert-cancel">취소</button><div><button type="button" class="blaind-alert-keep">원문으로 진행</button><button type="button" class="blaind-alert-mask">선택 항목 가리고 진행</button></div></footer>
  </section>`;
  const logo = createPopupLogo(document);
  logo.classList.add('blaind-alert-logo');
  overlay.querySelector('.blaind-alert-eyebrow')!.prepend(logo);
  host.append(style, overlay);
  const dialog = overlay.querySelector<HTMLElement>('[role="dialog"]')!;
  const items = overlay.querySelector<HTMLElement>('.blaind-alert-items')!;
  const checkboxes: HTMLInputElement[] = [];
  const selectAll = overlay.querySelector<HTMLInputElement>('.blaind-alert-select-all')!;
  const count = overlay.querySelector<HTMLElement>('.blaind-alert-selection-count')!;
  const preview = overlay.querySelector<HTMLElement>('.blaind-alert-document')!;
  const fragments: { node: HTMLElement; original: string; indexes: number[] }[] = [];
  const syncSelection = () => {
    const total = checkboxes.filter(input => input.checked).length;
    selectAll.checked = total > 0 && total === checkboxes.length;
    selectAll.indeterminate = total > 0 && total < checkboxes.length;
    count.textContent = `${total} / ${checkboxes.length}개 선택`;
    for (const fragment of fragments) {
      const masked = fragment.indexes.some(index => checkboxes[index]!.checked);
      fragment.node.dataset.state = masked ? 'selected' : 'confirm';
      fragment.node.textContent = masked ? '•'.repeat(Math.min(fragment.original.length, 12)) : fragment.original;
      fragment.node.setAttribute('aria-pressed', String(masked));
    }
  };
  const setChecked = (index: number, checked: boolean) => {
    const input = checkboxes[index]!;
    if (input.checked === checked) return;
    input.checked = checked;
    options.onSelectionChange?.(detections[index]!, checked);
  };
  const highlight = (index: number | null) => {
    for (const fragment of fragments) fragment.node.classList.toggle('is-active', index !== null && fragment.indexes.includes(index));
  };
  detections.forEach((detection, index) => {
    const inputId = `blaind-choice-${index}`;
    const row = document.createElement('label');
    row.className = 'blaind-alert-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.value = String(index);
    checkbox.checked = automaticDetections.has(detection);
    checkboxes.push(checkbox);
    checkbox.addEventListener('change', () => { syncSelection(); options.onSelectionChange?.(detection, checkbox.checked); });
    checkbox.setAttribute('aria-label', `${labels[detection.type] ?? detection.type} 가리기`);
    const content = document.createElement('span'); content.className = 'blaind-alert-item-copy';
    const kind = document.createElement('span'); kind.className = 'blaind-alert-kind';
    kind.textContent = [options.itemContext?.(detection), labels[detection.type] ?? detection.type].filter(Boolean).join(' · ');
    const value = document.createElement('span'); value.className = 'blaind-alert-value';
    value.textContent = detectedText(analysis.originalText, detection);
    content.append(kind, value); row.append(checkbox, content); row.htmlFor = inputId; checkbox.id = inputId;
    row.addEventListener('mouseenter', () => highlight(index));
    row.addEventListener('mouseleave', () => highlight(null));
    checkbox.addEventListener('focus', () => {
      highlight(index);
      fragments.find(fragment => fragment.indexes.includes(index))?.node.scrollIntoView?.({ block: 'nearest' });
    });
    checkbox.addEventListener('blur', () => highlight(null));
    items.append(row);
  });
  selectAll.addEventListener('change', () => {
    const checked = selectAll.checked;
    checkboxes.forEach((_, index) => setChecked(index, checked));
    syncSelection();
  });
  // Split at every boundary so overlapping checked items mask their combined coverage.
  const boundaries = [...new Set([0, analysis.originalText.length, ...detections.flatMap(d => [d.span.start, d.span.end])])].sort((a, b) => a - b);
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!, end = boundaries[i + 1]!;
    const original = analysis.originalText.slice(start, end);
    const indexes = detections.flatMap((d, index) => d.span.start < end && d.span.end > start ? [index] : []);
    if (!indexes.length) { preview.append(document.createTextNode(original)); continue; }
    const node = document.createElement('button');
    node.className = 'blaind-alert-highlight';
    node.type = 'button';
    node.setAttribute('aria-label', `${indexes.map(index => labels[detections[index]!.type] ?? detections[index]!.type).join(' · ')} 가리기 전환`);
    node.addEventListener('click', () => {
      const checked = !indexes.some(index => checkboxes[index]!.checked);
      indexes.forEach(index => setChecked(index, checked));
      syncSelection();
      checkboxes[indexes[0]!]!.focus();
      checkboxes[indexes[0]!]!.closest('label')?.scrollIntoView?.({ block: 'nearest' });
    });
    fragments.push({ node, original, indexes });
    preview.append(node);
  }
  if (!analysis.originalText) preview.textContent = '미리볼 내용이 없습니다.';
  syncSelection();
  if (!detections.length) overlay.querySelector('.blaind-alert-list')?.remove();
  const cancelButton = overlay.querySelector<HTMLButtonElement>('.blaind-alert-cancel')!;
  const keep = overlay.querySelector<HTMLButtonElement>('.blaind-alert-keep')!;
  const mask = overlay.querySelector<HTMLButtonElement>('.blaind-alert-mask')!;
  if (!detections.length) mask.remove();

  let finished = false;
  const finish = (selectedDetections: readonly Detection[]) => {
    if (finished) return;
    const result = buildReviewResult(analysis,
      selectedDetections.filter(detection => !automaticDetections.has(detection)),
      selectedDetections.filter(detection => automaticDetections.has(detection)));
    cleanup();
    onComplete(result);
  };
  const selected = () => checkboxes.filter(input => input.checked)
    .map((input) => detections[Number(input.value)])
    .filter((detection): detection is Detection => detection !== undefined);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    if (event.key === 'Tab') {
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
      const first = focusable[0], last = focusable[focusable.length - 1];
      const root = host.getRootNode() as Document | ShadowRoot;
      if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  const cancel = () => { if (finished) return; cleanup(); onCancel?.(); };
  const onBackdrop = (event: MouseEvent) => { if (event.target === overlay) cancel(); };
  const onKeep = () => finish([]);
  const onMask = () => finish(selected());
  const cleanup = () => {
    if (finished) return;
    finished = true;
    overlay.removeEventListener('keydown', onKey);
    cancelButton.removeEventListener('click', cancel);
    overlay.removeEventListener('click', onBackdrop);
    keep.removeEventListener('click', onKeep); mask.removeEventListener('click', onMask);
    overlay.remove(); style.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  overlay.addEventListener('keydown', onKey);
  cancelButton.addEventListener('click', cancel);
  overlay.addEventListener('click', onBackdrop);
  keep.addEventListener('click', onKeep); mask.addEventListener('click', onMask);
  dialog.focus();
  return cleanup;
}

const alertStyles = `
.blaind-alert-backdrop {
  position: fixed; inset: 0; z-index: 2147483647;
  display: grid; place-items: center; box-sizing: border-box; padding: 20px;
  background: rgba(12, 12, 12, .32);
  font-family: var(--blaind-font);
  font-weight: 400;
  color: var(--blaind-ink); color-scheme: light;
}
.blaind-alert, .blaind-alert * { box-sizing: border-box; }
.blaind-alert {
  width: min(100%, 1000px); max-height: min(900px, calc(100dvh - 40px)); overflow: auto;
  background: var(--blaind-surface); border: 1px solid var(--blaind-border); border-radius: var(--blaind-radius-panel); padding: 28px; outline: none;
  box-shadow: var(--blaind-shadow);
}
.blaind-alert-header { display: flex; align-items: center; gap: 14px; }
.blaind-alert-selection-count, .blaind-alert-value, .blaind-alert-kind { font-family: "IBM Plex Mono", "IBM Plex Sans KR", monospace; font-weight: 500; }
.blaind-alert-workspace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 260px); gap: 20px; margin-top: 20px; }
.blaind-alert-preview { min-width: 0; padding: 18px; border: 1px solid var(--blaind-border); border-radius: var(--blaind-radius-inset); background: var(--blaind-inset); }
.blaind-alert-preview-legend { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 0 14px; font-size: 11px; color: var(--blaind-muted); }
.blaind-alert-preview-legend span:before { content: ''; display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
.blaind-legend-confirm:before { background: var(--blaind-soft); border: 1px dashed var(--blaind-muted); }
.blaind-legend-selected:before { background: var(--blaind-ink); border: 1px solid var(--blaind-ink); }
.blaind-alert-document { max-height: 42vh; min-height: 220px; overflow: auto; padding: 22px; border: 1px solid var(--blaind-border); border-radius: var(--blaind-radius-button); background: var(--blaind-surface); color: var(--blaind-ink); font-size: 14px; line-height: 2; white-space: pre-wrap; overflow-wrap: anywhere; }
.blaind-alert-document:focus-visible { outline: 2px solid var(--blaind-ink); outline-offset: 2px; }
.blaind-alert-list { min-width: 0; margin: 0; padding: 0; border: 0; }
.blaind-alert-workspace:not(:has(.blaind-alert-list)) { grid-template-columns: minmax(0, 1fr); }
.blaind-alert-selection-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; padding: 0 4px 10px; border-bottom: 1px solid var(--blaind-border); font-size: 12px; }
.blaind-alert-selection-toolbar label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.blaind-alert-select-all { width: 18px; height: 18px; margin: 0; accent-color: var(--blaind-ink); }
.blaind-alert-select-all:focus-visible { outline: 2px solid var(--blaind-ink); outline-offset: 2px; }
.blaind-alert-selection-count { color: var(--blaind-muted); font-size: 11px; white-space: nowrap; }
.blaind-alert-list legend { margin-bottom: 10px; color: var(--blaind-ink); font-size: 13px; font-weight: 500; }
.blaind-alert-items { display: grid; gap: 8px; max-height: 46vh; overflow: auto; padding: 4px; margin: -4px; }
.blaind-alert-item { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 8px 4px; border: 0; background: transparent; cursor: pointer; }
.blaind-alert-item:hover { background: transparent; }
.blaind-alert-item:has(input:checked) { background: transparent; }
.blaind-alert-item:focus-within { outline: 2px solid var(--blaind-ink); outline-offset: 2px; }
.blaind-alert-item input { flex: none; width: 18px; height: 18px; margin: 0; accent-color: var(--blaind-ink); }
.blaind-alert-item-copy { display: grid; gap: 3px; min-width: 0; flex: 1; }
.blaind-alert-kind { overflow-wrap: anywhere; font-size: 12px; font-weight: 500; color: var(--blaind-muted); }
.blaind-alert-value { overflow-wrap: anywhere; white-space: pre-wrap; color: var(--blaind-ink); font-size: 14px; line-height: 1.5; }
.blaind-alert-actions {
  display: flex; justify-content: space-between; align-items: center; gap: 10px;
  margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--blaind-border);
}
.blaind-alert-actions > div { display: flex; gap: 8px; }
.blaind-alert button {
  min-height: 42px; padding: 10px 14px; border: 1px solid var(--blaind-border); border-radius: var(--blaind-radius-button);
  background: var(--blaind-surface); color: var(--blaind-ink); font-family: inherit; font-size: 13px;
  font-weight: 500; line-height: 1.5; cursor: pointer;
  transition: border-color .15s ease, background .15s ease;
}
.blaind-alert button:hover { border-color: var(--blaind-border); background: var(--blaind-inset); }
.blaind-alert button:focus-visible, .blaind-alert-item input:focus-visible { outline: 2px solid var(--blaind-ink); outline-offset: 2px; }
.blaind-alert .blaind-alert-cancel { border-color: transparent; color: var(--blaind-muted); }
.blaind-alert .blaind-alert-mask { border-color: var(--blaind-ink); background: var(--blaind-ink); color: var(--blaind-surface); }
.blaind-alert .blaind-alert-mask:hover { border-color: var(--blaind-ink); background: var(--blaind-ink); opacity: .9; }
.blaind-alert .blaind-alert-highlight { display: inline; min-height: 0; padding: 0 3px; border: 0; border-radius: 3px; font: inherit; line-height: 1.4; color: var(--blaind-ink); background: var(--blaind-soft); border-bottom: 1px dashed var(--blaind-muted); box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.blaind-alert .blaind-alert-highlight[data-state="selected"] { color: var(--blaind-surface); background: var(--blaind-ink); border-bottom: 1px solid var(--blaind-ink); }
.blaind-alert button.blaind-alert-highlight:hover { background: #ECECE9; }
.blaind-alert button.blaind-alert-highlight[data-state="selected"]:hover { background: var(--blaind-ink); color: var(--blaind-surface); }
.blaind-alert .blaind-alert-highlight.is-active { outline: 2px solid var(--blaind-ink); outline-offset: 1px; }
@media (max-width: 760px) {
  .blaind-alert-workspace { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .blaind-alert-document { min-height: 140px; max-height: 25vh; padding: 16px; }
  .blaind-alert-items { max-height: 28vh; }
}
@media (max-width: 540px) {
  .blaind-alert { padding: 22px 20px; }
  .blaind-alert-actions { align-items: stretch; flex-direction: column-reverse; }
  .blaind-alert-actions > div { display: grid; gap: 8px; }
  .blaind-alert-actions button { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .blaind-alert-item, .blaind-alert button { transition: none; }
}
`;
