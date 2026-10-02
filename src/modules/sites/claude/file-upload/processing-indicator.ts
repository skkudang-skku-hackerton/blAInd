/**
 * 처리 중 표시 UI (사이트 모듈 전용).
 *
 * 파일을 가로채 문서 모듈이 처리하는 동안 사용자에게 "검사 중"임을 알린다.
 * 사이트 CSS와 충돌하지 않도록 Shadow DOM 안에 렌더링하고, 페이지 조작을 막지 않도록
 * pointer-events: none 으로 둔다.
 *
 * 이 UI는 코어의 승인/탐지 결과를 표시하지 않는다. 그건 features/review 의 몫이다.
 * 여기서는 순수하게 "처리 중" 상태만 보여준다.
 */

export interface ProcessingIndicatorLabels {
  /** 제목. 기본 "파일 검사 중" */
  title: string;
  /** 파일 개수 문구. */
  files: (count: number) => string;
  /** 보조 문구. */
  hint: string;
}

const DEFAULT_LABELS: ProcessingIndicatorLabels = {
  title: '파일 검사 중',
  files: (count) => (count > 1 ? `파일 ${count}개를 처리하고 있어요` : '파일을 처리하고 있어요'),
  hint: '개인정보를 확인하는 중입니다. 잠시만 기다려 주세요.',
};

export interface ProcessingIndicatorInfo {
  fileCount: number;
  fileNames: readonly string[];
}

export interface ProcessingIndicator {
  show(info: ProcessingIndicatorInfo): void;
  update(info: ProcessingIndicatorInfo): void;
  hide(): void;
  destroy(): void;
  readonly visible: boolean;
  readonly element: HTMLElement | null;
}

export interface ProcessingIndicatorOptions {
  /** 문구 커스터마이즈(부분 지정 가능). */
  labels?: Partial<ProcessingIndicatorLabels>;
  /** 붙일 루트. 기본 document. ShadowRoot 전달 시 그 안에 붙는다. */
  root?: Document | ShadowRoot;
  /** 하단에서 띄울 거리(px). 기본 96. */
  bottomOffsetPx?: number;
  /** z-index. 기본 2147483000. */
  zIndex?: number;
}

const HOST_ID = 'blaind-claude-processing-indicator';

const STYLE = `
:host { all: initial; }
.wrap {
  position: fixed;
  left: 50%;
  bottom: var(--blaind-bottom, 96px);
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  box-sizing: border-box;
  max-width: min(92vw, 420px);
  padding: 12px 16px 12px 14px;
  border-radius: 8px;
  background: #191919;
  color: #FFFFFF;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue",
    Arial, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
  font-size: 13px;
  line-height: 1.35;
  box-shadow: 0 8px 30px rgba(12, 12, 12, 0.28);
  pointer-events: none;
  -webkit-font-smoothing: antialiased;
  opacity: 0;
  transition: opacity 140ms ease, transform 140ms ease;
}
.wrap[data-visible="true"] { opacity: 1; }
.spinner {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid rgba(231, 231, 227, 0.28);
  border-top-color: #191919;
  animation: blaind-spin 0.8s linear infinite;
}
.title { font-weight: 600; }
.detail { color: #ECECE9; margin-top: 2px; word-break: break-word; }
.files { color: #ECECE9; margin-top: 2px; }
@keyframes blaind-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .spinner { animation-duration: 2s; }
  .wrap { transition: none; }
}
`;

export function createProcessingIndicator(
  options: ProcessingIndicatorOptions = {},
): ProcessingIndicator {
  const root: Document | ShadowRoot = options.root ?? document;
  const labels: ProcessingIndicatorLabels = { ...DEFAULT_LABELS, ...options.labels };

  function getHostParent(): Element {
    if ('body' in root && root.body) return root.body;
    const hostEl = (root as ShadowRoot).host;
    return hostEl?.parentElement ?? document.body ?? document.documentElement;
  }

  let host: HTMLElement | null = null;
  let wrap: HTMLElement | null = null;
  let titleEl: HTMLElement | null = null;
  let filesEl: HTMLElement | null = null;
  let detailEl: HTMLElement | null = null;
  let visible = false;

  function buildAndMount(): void {
    // 이전 인스턴스/중복 호스트 제거
    document.getElementById(HOST_ID)?.remove();

    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText =
      `all: initial; position: fixed; z-index: ${options.zIndex ?? 2147483000}; ` +
      `--blaind-bottom: ${options.bottomOffsetPx ?? 96}px;`;

    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;

    wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.setAttribute('data-visible', 'false');
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-live', 'polite');

    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');

    const text = document.createElement('div');
    titleEl = document.createElement('div');
    titleEl.className = 'title';
    filesEl = document.createElement('div');
    filesEl.className = 'files';
    detailEl = document.createElement('div');
    detailEl.className = 'detail';
    text.append(titleEl, filesEl, detailEl);

    wrap.append(spinner, text);
    shadow.append(style, wrap);
    getHostParent().append(host);
  }

  function apply(info: ProcessingIndicatorInfo): void {
    if (titleEl) titleEl.textContent = labels.title;
    if (filesEl) filesEl.textContent = labels.files(info.fileCount);
    if (detailEl) {
      // 단일 파일이면 파일명을, 여러 개면 안내 문구를 보여준다.
      detailEl.textContent =
        info.fileCount === 1 && info.fileNames[0] ? info.fileNames[0] : labels.hint;
    }
  }

  function show(info: ProcessingIndicatorInfo): void {
    if (!host) buildAndMount();
    apply(info);
    wrap?.setAttribute('data-visible', 'true');
    visible = true;
  }

  function update(info: ProcessingIndicatorInfo): void {
    if (!visible) {
      show(info);
      return;
    }
    apply(info);
  }

  function hide(): void {
    if (!host) return;
    wrap?.setAttribute('data-visible', 'false');
    visible = false;
    const toRemove = host;
    window.setTimeout(() => {
      // 그 사이 다시 보이지 않았으면 DOM 에서 제거해 누수를 막는다.
      if (!visible && toRemove === host) {
        toRemove.remove();
        host = null;
        wrap = null;
        titleEl = null;
        filesEl = null;
        detailEl = null;
      }
    }, 200);
  }

  function destroy(): void {
    visible = false;
    host?.remove();
    host = null;
    wrap = null;
    titleEl = null;
    filesEl = null;
    detailEl = null;
  }

  return {
    show,
    update,
    hide,
    destroy,
    get visible() {
      return visible;
    },
    get element() {
      return host;
    },
  };
}
