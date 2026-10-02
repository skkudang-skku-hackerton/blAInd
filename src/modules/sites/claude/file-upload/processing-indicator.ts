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

import { createLoadingLogo, popupThemeStyles } from '../../../../alert/popup-theme';
import { ensureAlertFonts } from '../../../../alert/typography';
import { processingIndicatorStyles } from '../../processing-indicator-styles';

export interface ProcessingIndicatorLabels {
  /** @deprecated 파일명 기반 한 줄 안내를 사용하므로 별도 제목은 표시하지 않습니다. */
  title: string;
  /** 파일명이 없을 때 표시할 한 줄 안내. */
  files: (count: number) => string;
  /** @deprecated 파일명 기반 한 줄 안내를 사용하므로 보조 문구는 표시하지 않습니다. */
  hint: string;
}

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
  /** @deprecated 처리 중 표시는 항상 화면 중앙에 배치됩니다. */
  bottomOffsetPx?: number;
  /** z-index. 기본 2147483000. */
  zIndex?: number;
}

const HOST_ID = 'blaind-claude-processing-indicator';

const STYLE = `${popupThemeStyles}
${processingIndicatorStyles}
.wrap { pointer-events: none; }
`;

export function createProcessingIndicator(
  options: ProcessingIndicatorOptions = {},
): ProcessingIndicator {
  const root: Document | ShadowRoot = options.root ?? document;

  function getHostParent(): Element {
    if ('body' in root && root.body) return root.body;
    const hostEl = (root as ShadowRoot).host;
    return hostEl?.parentElement ?? document.body ?? document.documentElement;
  }

  let host: HTMLElement | null = null;
  let wrap: HTMLElement | null = null;
  let titleEl: HTMLElement | null = null;
  let visible = false;

  function buildAndMount(): void {
    ensureAlertFonts(document);
    // 이전 인스턴스/중복 호스트 제거
    document.getElementById(HOST_ID)?.remove();

    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = `all: initial; position: fixed; z-index: ${options.zIndex ?? 2147483000};`;

    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;

    wrap = document.createElement('div');
    wrap.className = 'blaind-popup wrap';
    wrap.setAttribute('data-visible', 'false');
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-live', 'polite');

    titleEl = document.createElement('p');
    titleEl.className = 'title';
    wrap.append(createLoadingLogo(document), titleEl);
    shadow.append(style, wrap);
    getHostParent().append(host);
  }

  function apply(info: ProcessingIndicatorInfo): void {
    if (!titleEl) return;
    const filename = info.fileNames[0];
    titleEl.textContent = filename
      ? `${filename}${info.fileCount > 1 ? ` 외 ${info.fileCount - 1}개` : ''} 처리 중…`
      : options.labels?.files?.(info.fileCount)
        ?? (info.fileCount > 1 ? `문서 ${info.fileCount}개 처리 중…` : '문서 처리 중…');
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
      }
    }, 200);
  }

  function destroy(): void {
    visible = false;
    host?.remove();
    host = null;
    wrap = null;
    titleEl = null;
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
