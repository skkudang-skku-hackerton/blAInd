/**
 * Gemini 파일 입력 가로채기 (사이트 모듈의 1차 방어선).
 *
 * 하는 일
 * 1. change / drop / paste 를 capture 단계에서 잡아 페이지(Angular)로 전파되기 전에 끊는다.
 * 2. 파일을 종류별로 분류해 알맞은 문서 모듈(DocumentProcessor)에 넘긴다.
 * 3. 문서 모듈이 돌려준 파일을 Gemini 첨부로 재주입한다.
 * 4. 처리하는 동안 "검사 중" 오버레이를 보여준다(processing-indicator).
 *
 * 코어와의 통신은 문서 모듈 안에서 일어나며 이 모듈은 관여하지 않는다.
 *
 * 전파 차단이 핵심이다. Gemini는 Angular 기반이고 Angular도 DOM 이벤트 위임을 쓰므로,
 * document 의 capture 리스너가 root/target 핸들러보다 항상 먼저 실행된다. 여기서
 * stopImmediatePropagation 하면 페이지 업로드 핸들러는 이벤트를 보지 못한다.
 * (프레임워크 내부 구현이 바뀔 수 있으니 실제 페이지에서 검증한다.)
 *
 * isolated world content script 에서도 DOM 이벤트는 공유되므로 이 모듈은 chrome.*
 * 없이 순수 DOM 만으로 동작한다.
 */

import { classifyFile } from './classify';
import { isInternalEvent } from './event-guard';
import { injectFilesIntoDrop, injectFilesIntoInput, resolveFileInput } from './file-injector';
import { createProcessingIndicator, type ProcessingIndicator } from './processing-indicator';
import type {
  DocumentKind,
  FileInterceptContext,
  FileSource,
  FileUploadInterceptorOptions,
} from './types';

export interface FileUploadInterceptor {
  start(): void;
  stop(): void;
  abort(): void;
  readonly isProcessing: boolean;
}

interface ActiveBatch {
  controller: AbortController;
}

type ProcessOutcome =
  | { ok: true; file: File; context: FileInterceptContext }
  | { ok: false; reason: 'unhandled' | 'cancelled'; context: FileInterceptContext };

const LOG_PREFIX = '[blAInd:gemini:file-upload]';
const INDICATOR_SHOW_DELAY_MS = 150;

export function createFileUploadInterceptor(
  options: FileUploadInterceptorOptions,
): FileUploadInterceptor {
  const { processors } = options;
  const unhandledPolicy = options.unhandled ?? 'passthrough';
  const root: Document | ShadowRoot = options.root ?? document;
  const ownsIndicator = options.indicator === undefined;
  const indicator: ProcessingIndicator | null =
    options.indicator === false
      ? null
      : options.indicator ?? createProcessingIndicator();

  const log = (...args: unknown[]): void => {
    if (options.debug) {
      console.debug(LOG_PREFIX, ...args);
    }
  };

  let active: ActiveBatch | null = null;
  let sequence = 0;
  let started = false;

  // 오버레이는 잠깐의 처리(즉시 passthrough)에서 깜빡이지 않도록 살짝 지연해 띄운다.
  let showTimer: number | null = null;
  let indicatorToken = 0;

  function showIndicator(info: { fileCount: number; fileNames: readonly string[] }): void {
    if (!indicator) return;
    const token = ++indicatorToken;
    if (showTimer !== null) window.clearTimeout(showTimer);
    showTimer = window.setTimeout(() => {
      showTimer = null;
      if (token === indicatorToken) indicator.show(info);
    }, INDICATOR_SHOW_DELAY_MS);
  }

  function hideIndicator(): void {
    indicatorToken += 1;
    if (showTimer !== null) {
      window.clearTimeout(showTimer);
      showTimer = null;
    }
    indicator?.hide();
  }

  function abortActive(): void {
    if (active) {
      active.controller.abort();
      active = null;
    }
  }

  async function processFile(
    file: File,
    kind: DocumentKind,
    source: FileSource,
    requestId: string,
    signal: AbortSignal,
  ): Promise<ProcessOutcome> {
    const context: FileInterceptContext = { requestId, source, kind, file };
    const processor = processors[kind];

    if (!processor) {
      if (unhandledPolicy === 'hold') {
        return { ok: false, reason: 'unhandled', context };
      }
      return { ok: true, file, context }; // passthrough
    }

    const processed = await processor(file, signal);
    if (processed === null) {
      return { ok: false, reason: 'cancelled', context };
    }
    return { ok: true, file: processed, context };
  }

  /**
   * 파일 묶음을 하나의 승인 단위로 처리한다.
   * 하나라도 취소/보류면 묶음 전체를 첨부하지 않는다(부분 첨부로 인한 유출 방지).
   */
  async function process(
    files: readonly File[],
    source: FileSource,
    reinject: (processedFiles: readonly File[]) => boolean,
  ): Promise<void> {
    if (files.length === 0) return;

    // 새 선택/드롭이 들어오면 이전 처리는 무효화한다.
    abortActive();

    const controller = new AbortController();
    const requestId = `gemini-file-${Date.now()}-${++sequence}`;
    active = { controller };

    const fileNames = files.map((file) => file.name);
    log('captured', { requestId, source, names: fileNames });
    showIndicator({ fileCount: files.length, fileNames });

    try {
      const outcomes = await Promise.all(
        files.map((file) => {
          const kind = classifyFile(file);
          log('classified', { requestId, name: file.name, type: file.type, kind });
          return processFile(file, kind, source, requestId, controller.signal);
        }),
      );

      if (controller.signal.aborted) {
        log('discarded stale batch', { requestId });
        return;
      }

      const skipped = outcomes.filter((o): o is Extract<ProcessOutcome, { ok: false }> => !o.ok);
      if (skipped.length > 0) {
        for (const outcome of skipped) {
          options.onSkipped?.({ requestId, context: outcome.context, reason: outcome.reason });
        }
        log('batch held', { requestId, skipped: skipped.length });
        return;
      }

      const processedFiles = outcomes
        .filter((o): o is Extract<ProcessOutcome, { ok: true }> => o.ok)
        .map((o) => o.file);

      if (processedFiles.length !== files.length) return;

      const reinjected = reinject(processedFiles);
      if (!reinjected) {
        // 첨부 input 을 찾지 못한 경우. 원본을 대신 흘리지 않고 오류로 알린다.
        const first = outcomes[0];
        log('reinject failed', { requestId });
        if (first) {
          options.onError?.(new Error('Failed to re-attach processed file'), first.context);
        }
        return;
      }

      for (const outcome of outcomes) {
        if (outcome.ok) options.onProcessed?.({ requestId, context: outcome.context });
      }
      log('reinjected', { requestId, count: processedFiles.length });
    } catch (error) {
      if (controller.signal.aborted) return;
      // 오류 정책: 원본을 절대 대신 첨부하지 않는다.
      log('error, holding batch', { requestId, error });
      options.onError?.(error, {
        requestId,
        source,
        kind: files[0] ? classifyFile(files[0]) : 'unknown',
        file: files[0]!,
      });
    } finally {
      if (active?.controller === controller) {
        active = null;
        hideIndicator();
      }
    }
  }

  function onChange(event: Event): void {
    if (isInternalEvent(event)) return;

    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;

    const files = Array.from(input.files ?? []);
    if (files.length === 0) return;

    // 페이지 업로드 핸들러보다 먼저 끊는다.
    event.stopImmediatePropagation();
    event.preventDefault();

    // 원본이 다른 경로로 새지 않게 즉시 비운다. File 참조는 위에서 확보했다.
    const accept = input.accept;
    input.value = '';

    void process(files, 'input', (processedFiles) => {
      const target = resolveFileInput(input, accept);
      return target ? injectFilesIntoInput(target, processedFiles) : false;
    });
  }

  function onDrop(event: DragEvent): void {
    if (isInternalEvent(event)) return;

    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;

    event.stopImmediatePropagation();
    event.preventDefault();

    const target = event.target;
    void process(files, 'drop', (processedFiles) => {
      return injectFilesIntoDrop(target, processedFiles);
    });
  }

  function onPaste(event: ClipboardEvent): void {
    if (isInternalEvent(event)) return;

    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;

    event.stopImmediatePropagation();
    event.preventDefault();

    const target = event.target;
    void process(files, 'paste', (processedFiles) => {
      return injectFilesIntoDrop(target, processedFiles);
    });
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      root.addEventListener('change', onChange, true);
      root.addEventListener('drop', onDrop as EventListener, true);
      root.addEventListener('paste', onPaste as EventListener, true);
      log('interceptor started');
    },
    stop(): void {
      if (!started) return;
      started = false;
      abortActive();
      hideIndicator();
      if (ownsIndicator) {
        indicator?.destroy();
      }
      root.removeEventListener('change', onChange, true);
      root.removeEventListener('drop', onDrop as EventListener, true);
      root.removeEventListener('paste', onPaste as EventListener, true);
      log('interceptor stopped');
    },
    abort(): void {
      abortActive();
      hideIndicator();
    },
    get isProcessing(): boolean {
      return active !== null;
    },
  };
}
