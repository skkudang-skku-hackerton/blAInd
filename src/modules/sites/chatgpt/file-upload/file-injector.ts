/**
 * 승인된 File[] 을 ChatGPT 입력에 다시 붙이는(대체 첨부) 유틸.
 *
 * input.files 는 읽기 전용처럼 보이지만 DataTransfer.files 를 대입하는 방식은
 * Chrome에서 정상 동작한다. React(17+)는 root 컨테이너에 change 리스너를 위임하므로
 * bubbles:true 로 change 를 재발행하면 페이지의 onChange 가 새 FileList 를 읽는다.
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

/** input[type=file] 에 파일을 주입하고 change 를 재발행한다. */
export function injectFilesIntoInput(input: HTMLInputElement, files: readonly File[]): void {
  input.files = createFileList(files);
  const event = new Event('change', { bubbles: true, composed: true });
  markInternalEvent(event);
  input.dispatchEvent(event);
}

/**
 * drop 이벤트를 재구성해 원래 드롭 대상에 전달한다.
 * DragEvent 생성자에 dataTransfer 를 넘기는 것은 Chrome에서 지원된다.
 * 실패하는 환경에서는 fallbackInput 으로 우회한다.
 */
export function injectFilesIntoDrop(
  target: EventTarget | null,
  files: readonly File[],
  fallbackInput?: HTMLInputElement,
): boolean {
  const transfer = new DataTransfer();
  for (const file of files) {
    transfer.items.add(file);
  }

  if (target) {
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

  if (fallbackInput) {
    injectFilesIntoInput(fallbackInput, files);
    return true;
  }
  return false;
}
