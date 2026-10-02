/**
 * 네트워크 안전망 (사이트 모듈의 2차 방어선, 보조).
 *
 * DOM 가로채기가 1차 방어선이다. 이 모듈은 DOM 경로를 우회해 페이지가 직접
 * fetch/XHR 로 업로드하는 경우를 감시한다. 반드시 페이지 컨텍스트(MAIN world)에서
 * 실행해야 window.fetch 를 패치할 수 있다.
 *
 * ChatGPT는 보통 `POST /backend-api/files`(메타 JSON) + `PUT {upload_url}`(원본 바이트)
 * 2단계로 올린다. 두 단계는 파일과 직접 상관시키기 어려워, 이 모듈은
 * - FormData 업로드: 파일을 찾아 문서 모듈에 넘기고 재구성
 * - 그 외 바이너리 업로드: 감지·리포트, enforce 시 차단
 * 까지만 담당한다. 코어는 모른다. 기본값은 감지 리포트이며 차단은 opt-in 이다.
 */

import { classifyFile } from './classify';
import type { DocumentProcessorRegistry } from './types';

const DEFAULT_UPLOAD_PATTERNS: readonly RegExp[] = [
  /\/backend-api\/files/i,
  /oaiusercontent\.com/i,
  /blob\.core\.windows\.net/i,
  /storage\.googleapis\.com/i,
  /\/upload/i,
];

export interface NetworkGuardDetectInfo {
  url: string;
  method: string;
  /** FormData 안에서 파일을 찾은 경우 개수, 아니면 null. */
  fileCount: number | null;
  /** DOM 가로채기로 처리되지 않은 것으로 보이는 순수 바이너리 업로드. */
  untrackedBinary: boolean;
}

export interface NetworkGuardOptions {
  /** 종류별 문서 처리기. 주어지면 FormData 업로드의 파일을 처리해 재구성한다. */
  processors?: DocumentProcessorRegistry;
  /** 처리기가 없는 종류의 정책. 기본 'passthrough'. */
  unhandled?: 'passthrough' | 'hold';
  /** true 면 처리되지 않은 바이너리 업로드를 차단(throw). 기본 false(감지만). */
  enforce?: boolean;
  /** 업로드로 판단할 URL 패턴. 기본 패턴에 추가된다. */
  extraUrlPatterns?: readonly RegExp[];
  onDetect?: (info: NetworkGuardDetectInfo) => void;
  debug?: boolean;
}

export interface NetworkGuard {
  uninstall(): void;
}

const LOG_PREFIX = '[blAInd:chatgpt:network-guard]';

function resolveUrl(input: RequestInfo | URL): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof input === 'object' && input && 'url' in input) return (input as Request).url;
  return null;
}

function isUploadUrl(url: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(url));
}

function collectFormDataFiles(form: FormData): File[] {
  const files: File[] = [];
  form.forEach((value) => {
    if (value instanceof File) files.push(value);
  });
  return files;
}

function rebuildFormData(form: FormData, replacements: Map<File, File>): FormData {
  const next = new FormData();
  form.forEach((value, key) => {
    if (value instanceof File) {
      const replacement = replacements.get(value) ?? value;
      next.append(key, replacement, replacement.name);
    } else {
      next.append(key, value);
    }
  });
  return next;
}

function isBinaryBody(body: unknown): boolean {
  return body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
}

export function installNetworkGuard(options: NetworkGuardOptions = {}): NetworkGuard {
  const patterns = [...DEFAULT_UPLOAD_PATTERNS, ...(options.extraUrlPatterns ?? [])];
  const unhandledPolicy = options.unhandled ?? 'passthrough';
  const log = (...args: unknown[]): void => {
    if (options.debug) console.debug(LOG_PREFIX, ...args);
  };

  let sequence = 0;

  const originalFetch = window.fetch.bind(window);

  const guardedFetch: typeof window.fetch = async (input, init) => {
    const url = resolveUrl(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

    if (url && isUploadUrl(url, patterns) && method !== 'GET' && method !== 'HEAD') {
      const body = init?.body;

      if (body instanceof FormData) {
        const files = collectFormDataFiles(body);
        options.onDetect?.({ url, method, fileCount: files.length, untrackedBinary: false });

        if (files.length > 0 && options.processors) {
          const controller = new AbortController();
          const replacements = new Map<File, File>();

          for (const file of files) {
            const kind = classifyFile(file);
            const processor = options.processors[kind];
            if (!processor) {
              if (unhandledPolicy === 'hold') {
                throw new DOMException('blAInd: unhandled upload held', 'AbortError');
              }
              continue;
            }
            const processed = await processor(file, controller.signal);
            if (processed === null) {
              throw new DOMException('blAInd: upload cancelled', 'AbortError');
            }
            if (processed !== file) replacements.set(file, processed);
          }

          if (replacements.size > 0) {
            init = { ...init, body: rebuildFormData(body, replacements) };
          }
        }
      } else if (isBinaryBody(body)) {
        // 메타 JSON POST + 바이너리 PUT 구조에서 이 PUT 은 DOM 경로로 이미 처리됐어야 한다.
        options.onDetect?.({ url, method, fileCount: null, untrackedBinary: true });
        log('untracked binary upload', { url, method, requestId: ++sequence });
        if (options.enforce) {
          throw new DOMException('blAInd: untracked upload blocked', 'AbortError');
        }
      }
    }

    return originalFetch(input, init);
  };

  window.fetch = guardedFetch;

  // XHR 은 본문 재작성이 어려워 감지만 한다. open 시점의 method/url 을 기억해 둔다.
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const xhrRequest = new WeakMap<XMLHttpRequest, { method: string; url: string }>();

  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ): void {
    xhrRequest.set(this, {
      method: method.toUpperCase(),
      url: typeof url === 'string' ? url : url.href,
    });
    // 원본 시그니처 보존을 위한 전달.
    return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const request = xhrRequest.get(this);
    if (
      request &&
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      isUploadUrl(request.url, patterns)
    ) {
      if (body instanceof FormData) {
        options.onDetect?.({
          url: request.url,
          method: request.method,
          fileCount: collectFormDataFiles(body).length,
          untrackedBinary: false,
        });
      } else if (isBinaryBody(body)) {
        options.onDetect?.({
          url: request.url,
          method: request.method,
          fileCount: null,
          untrackedBinary: true,
        });
      }
    }
    return originalSend.call(this, body);
  };

  log('network guard installed');

  return {
    uninstall(): void {
      window.fetch = originalFetch;
      XMLHttpRequest.prototype.open = originalOpen;
      XMLHttpRequest.prototype.send = originalSend;
      log('network guard uninstalled');
    },
  };
}
