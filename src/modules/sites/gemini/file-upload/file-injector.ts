/**
 * 처리된 File[] 을 Gemini 입력에 다시 붙이는(대체 첨부) 유틸.
 *
 * input.files 는 읽기 전용처럼 보이지만 DataTransfer.files 를 대입하는 방식은
 * Chrome에서 정상 동작한다. Angular도 DOM 이벤트 위임을 쓰므로 bubbles:true 로
 * change 를 재발행하면 페이지의 변경 핸들러가 새 FileList 를 읽는다.
 */

import { markInternalEvent } from './event-guard';

/** DataTransfer 에 파일 목록을 담아 FileList 로 만든다. */
export function createFileList(files: readonly File[]): FileList {
  const transfer = new DataTransfer();
  for (const file of files) {
    transfer.items.add(file);
  }
  return transfer.files;
}

/**
 * 재주입에 사용할 file input 을 찾는다.
 * 문서 전체 검색은 금지한다. 리렌더 fallback은 대화/입력 영역을 검증한 호출자가 정한다.
 */
export function resolveFileInput(
  preferred: HTMLInputElement | null,
  _acceptHint?: string,
): HTMLInputElement | null {
  return preferred?.isConnected ? preferred : null;
}

/** input[type=file] 에 파일을 주입하고 change 를 재발행한다. 성공 여부를 반환. */
export function injectFilesIntoInput(
  input: HTMLInputElement,
  files: readonly File[],
): boolean {
  try {
    input.files = createFileList(files);
  } catch {
    return false;
  }
  const event = new Event('change', { bubbles: true, composed: true });
  markInternalEvent(event);
  input.dispatchEvent(event);
  return true;
}

/**
 * drop 이벤트를 재구성해 원래 드롭 대상에 전달한다.
 * DragEvent 생성자에 dataTransfer 를 넘기는 것은 Chrome에서 지원된다.
 * 실패하거나 대상이 분리됐으면 fallbackInput(input)으로 우회한다.
 */
export function injectFilesIntoDrop(
  target: EventTarget | null,
  files: readonly File[],
  fallbackInput?: HTMLInputElement | null,
): boolean {
  if (target instanceof Element && target.isConnected) {
    const transfer = new DataTransfer();
    for (const file of files) {
      transfer.items.add(file);
    }
    try {
      const event = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: transfer,
      });
      markInternalEvent(event);
      target.dispatchEvent(event);
      return true;
    } catch {
      // 일부 환경에서 DragEvent + dataTransfer 생성이 막힐 수 있다.
    }
  }

  const input = resolveFileInput(fallbackInput ?? null);
  if (input) {
    return injectFilesIntoInput(input, files);
  }
  return false;
}
