import { buildReviewResult } from './policy';
import type { ApprovedReview, Detection, PrivacyAnalysis } from './types';

export interface PrivacyAlertOptions {
  analysis: PrivacyAnalysis;
  onComplete: (result: ApprovedReview) => void;
  onSelectionChange?: (detection: Detection, masking: boolean) => void;
  onCancel?: () => void;
  itemContext?: (detection: Detection) => string;
}

const labels: Record<string, string> = {
  RRN: '주민등록번호', FRN: '외국인등록번호', CARD_NUMBER: '카드번호', ACCOUNT_NUMBER: '계좌번호',
  SECRET: '비밀번호 · 키', PASSPORT: '여권번호', DRIVER_LICENSE: '운전면허번호', CVC: '카드 CVC',
  IPIN: '아이핀', PHONE: '전화번호', EMAIL: '이메일', USER_ID: '사용자 ID', PERSON: '이름',
  ADDRESS: '주소', ZIPCODE: '우편번호', DATE: '날짜 · 시간', GENERIC_ID: '기타 식별번호', CARD_EXPIRY: '카드 유효기간',
};

function detectedText(text: string, detection: Detection): string {
  return text.slice(detection.span.start, detection.span.end);
}

/** Mounts an accessible privacy review dialog. The caller owns the host and should call the returned cleanup. */
export function mountPrivacyAlert(host: HTMLElement, options: PrivacyAlertOptions): () => void {
  const document = host.ownerDocument;
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
  overlay.innerHTML = `<section class="blaind-alert" role="dialog" aria-modal="true" aria-labelledby="blaind-alert-title" aria-describedby="blaind-alert-description" tabindex="-1">
    <header class="blaind-alert-header"><span class="blaind-alert-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M16 3.5 27 8v7.1c0 6.5-4.5 11.2-11 13.4C9.5 26.3 5 21.6 5 15.1V8l11-4.5Z" stroke="currentColor" stroke-width="2"/><path d="m11.3 15.7 3.1 3.1 6.6-6.7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span><div><p class="blaind-alert-eyebrow"><span class="blaind-alert-live-dot"></span> blAInd <span class="blaind-alert-eyebrow-divider">/</span> PRIVACY CHECK</p><h2 id="blaind-alert-title">보내기 전에 확인해 주세요</h2></div></header>
    <p id="blaind-alert-description" class="blaind-alert-description"></p>
    <div class="blaind-alert-auto" aria-live="polite"></div>
    <fieldset class="blaind-alert-list"><legend>직접 선택할 항목</legend><div class="blaind-alert-items"></div></fieldset>
    <footer class="blaind-alert-actions"><button type="button" class="blaind-alert-cancel">취소</button><div><button type="button" class="blaind-alert-keep">보호된 내용으로 진행</button><button type="button" class="blaind-alert-mask">선택 항목 가리고 진행</button></div></footer>
  </section>`;
  host.append(style, overlay);
  const dialog = overlay.querySelector<HTMLElement>('[role="dialog"]')!;
  const auto = overlay.querySelector<HTMLElement>('.blaind-alert-auto')!;
  const items = overlay.querySelector<HTMLElement>('.blaind-alert-items')!;
  const description = overlay.querySelector<HTMLElement>('#blaind-alert-description')!;
  const autoCounts = new Map<string, number>();
  for (const d of analysis.autoMaskedDetections) autoCounts.set(d.type, (autoCounts.get(d.type) ?? 0) + 1);
  description.textContent = analysis.hasConfirmItems
    ? '자동 보호 대상은 항상 마스킹됩니다. 아래 항목은 가릴지 선택할 수 있습니다. 겹치는 구간은 자동 보호 또는 선택한 마스킹이 우선합니다.'
    : analysis.autoMaskedDetections.length ? '아래 정보는 처리 모듈에서 자동으로 마스킹됩니다.' : '개인정보가 탐지되지 않았습니다. 확인 후 진행해 주세요.';
  if (autoCounts.size) {
    const summary = [...autoCounts].map(([type, count]) => `${labels[type] ?? type} ${count}개`).join(' · ');
    auto.textContent = `자동 보호 대상  ${summary}`;
  } else auto.remove();

  analysis.confirmDetections.forEach((detection, index) => {
    const inputId = `blaind-confirm-${index}`;
    const row = document.createElement('label');
    row.className = 'blaind-alert-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.value = String(index);
    checkbox.addEventListener('change', () => options.onSelectionChange?.(detection, checkbox.checked));
    checkbox.setAttribute('aria-label', `${labels[detection.type] ?? detection.type} 가리기`);
    const content = document.createElement('span'); content.className = 'blaind-alert-item-copy';
    const kind = document.createElement('span'); kind.className = 'blaind-alert-kind';
    kind.textContent = [options.itemContext?.(detection), labels[detection.type] ?? detection.type].filter(Boolean).join(' · ');
    const value = document.createElement('span'); value.className = 'blaind-alert-value';
    value.textContent = detectedText(analysis.originalText, detection);
    content.append(kind, value); row.append(checkbox, content); row.htmlFor = inputId; checkbox.id = inputId;
    items.append(row);
  });
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
  const selected = () => [...items.querySelectorAll<HTMLInputElement>('input:checked')]
    .map((input) => analysis.confirmDetections[Number(input.value)])
    .filter((detection): detection is Detection => detection !== undefined);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    if (event.key === 'Tab') {
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
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
.blaind-alert-backdrop{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:16px;background:rgba(8,14,32,.68);backdrop-filter:blur(9px);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033}
.blaind-alert,.blaind-alert *{box-sizing:border-box}.blaind-alert{position:relative;width:min(100%,540px);max-height:min(90vh,740px);overflow:auto;background:linear-gradient(145deg,#fff 0%,#fbfcff 60%,#f4f7ff 100%);border:1px solid rgba(255,255,255,.85);border-radius:24px;padding:30px;box-shadow:0 32px 100px rgba(5,12,34,.38),0 0 0 1px rgba(112,143,224,.15);outline:none}.blaind-alert:before{content:"";position:absolute;inset:0 0 auto;height:5px;border-radius:24px 24px 0 0;background:linear-gradient(90deg,#39d6c5,#5588ff 52%,#9c6cff)}
.blaind-alert-header{display:flex;align-items:center;gap:15px}.blaind-alert-mark{display:grid;place-items:center;width:52px;height:52px;flex:none;border-radius:17px;background:linear-gradient(145deg,#e3fffb,#e5edff 72%,#f0e7ff);color:#416ef0;box-shadow:inset 0 1px 0 #fff,0 7px 20px rgba(79,115,211,.14)}.blaind-alert-mark svg{width:31px;height:31px}.blaind-alert-eyebrow{display:flex;align-items:center;gap:7px;margin:0 0 5px;color:#65738e;font-size:10px;font-weight:800;letter-spacing:.12em}.blaind-alert-live-dot{width:7px;height:7px;border-radius:50%;background:#25c8a6;box-shadow:0 0 0 3px rgba(37,200,166,.13)}.blaind-alert-eyebrow-divider{color:#aab4c6}.blaind-alert h2{margin:0;color:#17233c;font-size:21px;line-height:1.35;letter-spacing:-.035em}.blaind-alert-description{margin:22px 0 15px;color:#596781;font-size:14px;line-height:1.7}
.blaind-alert-auto{display:flex;align-items:center;gap:10px;padding:14px 15px;border:1px solid #cfeee8;border-radius:14px;background:linear-gradient(105deg,#edfcf8,#f0f5ff);color:#214d61;font-size:13px;font-weight:700;line-height:1.55}.blaind-alert-auto:before{content:"✓";display:grid;place-items:center;width:24px;height:24px;flex:none;border-radius:8px;background:#d6f7ee;color:#079879;font-size:14px;font-weight:900}.blaind-alert-list{min-width:0;margin:21px 0 0;padding:0;border:0}.blaind-alert-list legend{margin-bottom:10px;color:#344158;font-size:13px;font-weight:800}.blaind-alert-items{display:grid;gap:8px;max-height:34vh;overflow:auto;padding:1px 3px 2px 1px}.blaind-alert-item{display:flex;align-items:flex-start;gap:12px;min-width:0;padding:13px 14px;border:1px solid #e1e7f1;border-radius:14px;background:rgba(255,255,255,.78);cursor:pointer;transition:border-color .15s ease,background .15s ease,box-shadow .15s ease,transform .15s ease}.blaind-alert-item:hover{transform:translateY(-1px);border-color:#a9bdf4;background:#fff;box-shadow:0 6px 18px rgba(57,82,144,.08)}.blaind-alert-item:has(input:checked){border-color:#8faaf4;background:#f3f6ff;box-shadow:inset 3px 0 #5b7ff0}.blaind-alert-item input{flex:none;width:18px;height:18px;margin:2px 0 0;accent-color:#536ff0}.blaind-alert-item-copy{display:grid;gap:4px;min-width:0}.blaind-alert-kind{font-size:11px;font-weight:800;color:#697792}.blaind-alert-value{overflow-wrap:anywhere;white-space:pre-wrap;color:#1c2942;font-size:14px;line-height:1.5}
.blaind-alert-actions{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:23px;padding-top:17px;border-top:1px solid #e8ecf4}.blaind-alert-actions>div{display:flex;gap:9px}.blaind-alert button{min-height:43px;padding:0 15px;border:1px solid #dce2ed;border-radius:12px;background:rgba(255,255,255,.8);color:#43516b;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;transition:transform .15s ease,box-shadow .15s ease,background .15s ease}.blaind-alert button:hover{transform:translateY(-1px);background:#fff;box-shadow:0 5px 14px rgba(37,55,99,.1)}.blaind-alert button:focus-visible,.blaind-alert-item input:focus-visible{outline:3px solid #83aaf8;outline-offset:2px}.blaind-alert .blaind-alert-mask{border:0;background:linear-gradient(110deg,#3978ef,#6959ed);color:#fff;box-shadow:0 7px 17px rgba(77,101,225,.27)}.blaind-alert .blaind-alert-mask:hover{background:linear-gradient(110deg,#2869e5,#5848dc);box-shadow:0 9px 22px rgba(77,101,225,.35)}
@media(max-width:440px){.blaind-alert{padding:24px 20px 20px;border-radius:20px}.blaind-alert h2{font-size:19px}.blaind-alert-actions{align-items:stretch;flex-direction:column-reverse}.blaind-alert-actions>div{display:grid}.blaind-alert-actions button{width:100%}}
@media(prefers-reduced-motion:reduce){.blaind-alert-item,.blaind-alert button{transition:none}.blaind-alert-item:hover,.blaind-alert button:hover{transform:none}}
`;
