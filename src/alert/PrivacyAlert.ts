import { buildReviewResult } from './policy';
import { ensureAlertFonts } from './typography';
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
  const previousFocus = document.activeElement as HTMLElement | null;
  const style = document.createElement('style');
  style.textContent = alertStyles;
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
    <header class="blaind-alert-header"><div><p class="blaind-alert-eyebrow"><span class="blaind-alert-live-dot"></span> <span class="blaind-alert-logo">blAInd</span> <span class="blaind-alert-eyebrow-divider">/</span> PRIVACY CHECK</p></div></header>
    <div class="blaind-alert-workspace">
      <section class="blaind-alert-preview" aria-label="보호할 내용">
        <div class="blaind-alert-preview-legend"><span class="blaind-legend-auto">자동 보호</span><span class="blaind-legend-confirm">선택 가능</span><span class="blaind-legend-selected">선택한 항목</span></div>
        <div class="blaind-alert-document" role="region" aria-label="보호할 내용 미리보기" tabindex="0"></div>
      </section>
      <fieldset class="blaind-alert-list"><legend>가릴 항목 선택</legend>
        <div class="blaind-alert-selection-toolbar"><label><input type="checkbox" class="blaind-alert-select-all"> 전체 선택</label><span class="blaind-alert-selection-count" role="status"></span></div>
        <div class="blaind-alert-items"></div>
      </fieldset>
    </div>
    <footer class="blaind-alert-actions"><button type="button" class="blaind-alert-cancel">취소</button><div><button type="button" class="blaind-alert-keep">보호된 내용으로 진행</button><button type="button" class="blaind-alert-mask">선택 항목 가리고 진행</button></div></footer>
  </section>`;
  host.append(style, overlay);
  const dialog = overlay.querySelector<HTMLElement>('[role="dialog"]')!;
  const items = overlay.querySelector<HTMLElement>('.blaind-alert-items')!;
  const checkboxes: HTMLInputElement[] = [];
  const selectAll = overlay.querySelector<HTMLInputElement>('.blaind-alert-select-all')!;
  const count = overlay.querySelector<HTMLElement>('.blaind-alert-selection-count')!;
  const preview = overlay.querySelector<HTMLElement>('.blaind-alert-document')!;
  const fragments: { node: HTMLElement; original: string; automatic: boolean; indexes: number[] }[] = [];
  const syncSelection = () => {
    const total = checkboxes.filter(input => input.checked).length;
    selectAll.checked = total > 0 && total === checkboxes.length;
    selectAll.indeterminate = total > 0 && total < checkboxes.length;
    count.textContent = `${total} / ${checkboxes.length}개 선택`;
    for (const fragment of fragments) {
      const masked = fragment.automatic || fragment.indexes.some(index => checkboxes[index]!.checked);
      fragment.node.dataset.state = fragment.automatic ? 'auto' : masked ? 'selected' : 'confirm';
      fragment.node.textContent = masked ? '•'.repeat(Math.min(fragment.original.length, 12)) : fragment.original;
      if (!fragment.automatic) fragment.node.setAttribute('aria-pressed', String(masked));
    }
  };
  const setChecked = (index: number, checked: boolean) => {
    const input = checkboxes[index]!;
    if (input.checked === checked) return;
    input.checked = checked;
    options.onSelectionChange?.(analysis.confirmDetections[index]!, checked);
  };
  const highlight = (index: number | null) => {
    for (const fragment of fragments) fragment.node.classList.toggle('is-active', index !== null && fragment.indexes.includes(index));
  };
  analysis.confirmDetections.forEach((detection, index) => {
    const inputId = `blaind-confirm-${index}`;
    const row = document.createElement('label');
    row.className = 'blaind-alert-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.value = String(index);
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
  // Split at every boundary so overlapping detections preserve protection priority.
  const detections = [...analysis.autoMaskedDetections, ...analysis.confirmDetections];
  const boundaries = [...new Set([0, analysis.originalText.length, ...detections.flatMap(d => [d.span.start, d.span.end])])].sort((a, b) => a - b);
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!, end = boundaries[i + 1]!;
    const original = analysis.originalText.slice(start, end);
    const automatic = analysis.autoMaskedDetections.some(d => d.span.start < end && d.span.end > start);
    const indexes = analysis.confirmDetections.flatMap((d, index) => d.span.start < end && d.span.end > start ? [index] : []);
    if (!automatic && !indexes.length) { preview.append(document.createTextNode(original)); continue; }
    const node = document.createElement(automatic ? 'mark' : 'button');
    node.className = 'blaind-alert-highlight';
    if (automatic) node.setAttribute('aria-label', '자동 보호된 정보');
    else {
      const button = node as HTMLButtonElement;
      button.type = 'button';
      button.setAttribute('aria-label', `${indexes.map(index => labels[analysis.confirmDetections[index]!.type] ?? analysis.confirmDetections[index]!.type).join(' · ')} 가리기 전환`);
      button.addEventListener('click', () => {
        const checked = !indexes.every(index => checkboxes[index]!.checked);
        indexes.forEach(index => setChecked(index, checked));
        syncSelection();
        checkboxes[indexes[0]!]!.focus();
        checkboxes[indexes[0]!]!.closest('label')?.scrollIntoView?.({ block: 'nearest' });
      });
    }
    fragments.push({ node, original, automatic, indexes });
    preview.append(node);
  }
  if (!analysis.originalText) preview.textContent = '미리볼 내용이 없습니다.';
  syncSelection();
  if (!analysis.hasConfirmItems) overlay.querySelector('.blaind-alert-list')?.remove();
  const cancelButton = overlay.querySelector<HTMLButtonElement>('.blaind-alert-cancel')!;
  const keep = overlay.querySelector<HTMLButtonElement>('.blaind-alert-keep')!;
  const mask = overlay.querySelector<HTMLButtonElement>('.blaind-alert-mask')!;
  if (!analysis.hasConfirmItems) mask.remove();
  else keep.textContent = '선택 없이 진행';

  let finished = false;
  const finish = (selectedConfirm: readonly Detection[]) => {
    if (finished) return;
    const result = buildReviewResult(analysis, selectedConfirm);
    cleanup();
    onComplete(result);
  };
  const selected = () => checkboxes.filter(input => input.checked)
    .map((input) => analysis.confirmDetections[Number(input.value)])
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
  font-family: "blAInd Numerals", "IBM Plex Sans KR", sans-serif;
  font-weight: 400;
  color: #191919; color-scheme: light;
}
.blaind-alert, .blaind-alert * { box-sizing: border-box; }
.blaind-alert {
  width: min(100%, 1000px); max-height: min(900px, calc(100dvh - 40px)); overflow: auto;
  background: #FFFFFF; border: 1px solid #E7E7E3; border-radius: 16px; padding: 28px; outline: none;
  box-shadow: 0 18px 60px rgba(12, 12, 12, .14);
}
.blaind-alert-header { display: flex; align-items: center; gap: 14px; }
.blaind-alert-eyebrow {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 0;
  color: #6F6F6B; font-size: 10px; font-weight: 500; line-height: 1.5; letter-spacing: .08em;
}
.blaind-alert-logo { color: #191919; font-family: "IBM Plex Mono", monospace; font-weight: 700; letter-spacing: -.03em; }
.blaind-alert-eyebrow, .blaind-alert-selection-count, .blaind-alert-value, .blaind-alert-kind { font-family: "IBM Plex Mono", "IBM Plex Sans KR", monospace; font-weight: 500; }
.blaind-alert-live-dot { width: 6px; height: 6px; border-radius: 50%; background: #191919; }
.blaind-alert-eyebrow-divider { color: #E7E7E3; }
.blaind-alert-workspace { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(280px, 1fr); gap: 24px; margin-top: 24px; }
.blaind-alert-preview { min-width: 0; padding: 18px; border: 1px solid #E7E7E3; border-radius: 12px; background: #FCFCFB; }
.blaind-alert-preview-legend { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 0 14px; font-size: 11px; color: #6F6F6B; }
.blaind-alert-preview-legend span:before { content: ''; display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
.blaind-legend-auto:before { background: #ECECE9; }
.blaind-legend-confirm:before { background: #F4F3EE; border: 1px dashed #6F6F6B; }
.blaind-legend-selected:before { background: #191919; border: 1px solid #191919; }
.blaind-alert-document { max-height: 42vh; min-height: 220px; overflow: auto; padding: 22px; border: 1px solid #E7E7E3; border-radius: 8px; background: #FFFFFF; color: #191919; font-size: 14px; line-height: 2; white-space: pre-wrap; overflow-wrap: anywhere; }
.blaind-alert-document:focus-visible { outline: 2px solid #191919; outline-offset: 2px; }
.blaind-alert-list { min-width: 0; margin: 0; padding: 0; border: 0; }
.blaind-alert-workspace:not(:has(.blaind-alert-list)) { grid-template-columns: minmax(0, 1fr); }
.blaind-alert-selection-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 8px; padding: 0 8px 12px; border-bottom: 1px solid #E7E7E3; font-size: 13px; }
.blaind-alert-selection-toolbar label { display: flex; align-items: center; gap: 12px; cursor: pointer; }
.blaind-alert-select-all { width: 18px; height: 18px; margin: 0; accent-color: #191919; }
.blaind-alert-select-all:focus-visible { outline: 2px solid #191919; outline-offset: 2px; }
.blaind-alert-selection-count { color: #6F6F6B; font-size: 12px; }
.blaind-alert-list legend { margin-bottom: 10px; color: #191919; font-size: 13px; font-weight: 500; }
.blaind-alert-items { display: grid; gap: 8px; max-height: 46vh; overflow: auto; padding: 4px; margin: -4px; }
.blaind-alert-item { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 10px 8px; border: 0; background: transparent; cursor: pointer; }
.blaind-alert-item:hover { background: transparent; }
.blaind-alert-item:has(input:checked) { background: transparent; }
.blaind-alert-item:focus-within { outline: 2px solid #191919; outline-offset: 2px; }
.blaind-alert-item input { flex: none; width: 18px; height: 18px; margin: 0; accent-color: #191919; }
.blaind-alert-item-copy { display: flex; align-items: baseline; gap: 16px; min-width: 0; flex: 1; }
.blaind-alert-kind { flex: none; font-size: 12px; font-weight: 500; color: #6F6F6B; }
.blaind-alert-value { overflow-wrap: anywhere; white-space: pre-wrap; color: #191919; font-size: 14px; line-height: 1.5; }
.blaind-alert-actions {
  display: flex; justify-content: space-between; align-items: center; gap: 10px;
  margin-top: 24px; padding-top: 20px; border-top: 1px solid #E7E7E3;
}
.blaind-alert-actions > div { display: flex; gap: 8px; }
.blaind-alert button {
  min-height: 42px; padding: 10px 14px; border: 1px solid #E7E7E3; border-radius: 8px;
  background: #FFFFFF; color: #191919; font-family: inherit; font-size: 13px;
  font-weight: 500; line-height: 1.5; cursor: pointer;
  transition: border-color .15s ease, background .15s ease;
}
.blaind-alert button:hover { border-color: #E7E7E3; background: #FCFCFB; }
.blaind-alert button:focus-visible, .blaind-alert-item input:focus-visible { outline: 2px solid #191919; outline-offset: 2px; }
.blaind-alert .blaind-alert-cancel { border-color: transparent; color: #6F6F6B; }
.blaind-alert .blaind-alert-mask { border-color: #191919; background: #191919; color: #FFFFFF; }
.blaind-alert .blaind-alert-mask:hover { border-color: #191919; background: #191919; opacity: .9; }
.blaind-alert .blaind-alert-highlight { display: inline; min-height: 0; padding: 0 3px; border: 0; border-radius: 3px; font: inherit; line-height: 1.4; color: #191919; background: #F4F3EE; border-bottom: 1px dashed #6F6F6B; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.blaind-alert .blaind-alert-highlight[data-state="auto"] { color: #6F6F6B; background: #ECECE9; border-bottom: 1px solid #ECECE9; }
.blaind-alert .blaind-alert-highlight[data-state="selected"] { color: #FFFFFF; background: #191919; border-bottom: 1px solid #191919; }
.blaind-alert button.blaind-alert-highlight:hover { background: #ECECE9; }
.blaind-alert button.blaind-alert-highlight[data-state="selected"]:hover { background: #191919; color: #FFFFFF; }
.blaind-alert .blaind-alert-highlight.is-active { outline: 2px solid #191919; outline-offset: 1px; }
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
