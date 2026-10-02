import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createTextReviewController } from '../../src/features/review/text-review';
import { createTextScanController } from '../../src/features/review/text-scan';
import { createTextSender } from '../../src/features/review/text-send';
import { createTextSubmitInterceptor } from '../../src/modules/text';
import { getTextSiteAdapter } from '../../src/modules/sites/text-adapters';
import type { Detection } from '../../src/core/api';
import { deferred } from './messaging/helpers';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  const { window, document } = parseHTML('<html><body><form data-chat-id="one"><textarea id="prompt-textarea"></textarea><button aria-label="보내기">Send</button></form></body></html>');
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('MouseEvent', window.Event);
  vi.stubGlobal('document', document);
  const editor = document.querySelector('textarea')! as unknown as HTMLTextAreaElement;
  const button = document.querySelector('button')!;
  const original = '  안녕하세요 😀\n오늘 회의 안건을 정리해 주세요.  ';
  editor.value = original;
  const adapter = getTextSiteAdapter('chatgpt');
  const pending = deferred<Detection[]>();
  const scanText = vi.fn(() => pending.promise);
  const onError = vi.fn(), onDiscarded = vi.fn(), sent = vi.fn();
  const getPageUrl = () => 'https://chatgpt.com/c/one';
  let scanTask = Promise.resolve();
  const review = createTextReviewController({
    getCurrentResult: () => scanner.getResult(),
    onApproved(text) {
      const result = scanner.getResult();
      if (!result) return;
      scanner.clear();
      void sender.send(result, text).catch(onError);
    },
    onCancelled: vi.fn(), onError,
  });
  const scanner = createTextScanController({
    detector: { scanText }, readText: adapter.readText, getPageUrl,
    onScanning: () => review.close(), onResult: result => review.open(result),
    onError, onDiscarded,
  });
  const interceptor = createTextSubmitInterceptor({
    adapter, root: document as unknown as Document,
    onIntercept(context) {
      sender.cancel();
      scanTask = scanner.scan(context);
    },
    onError,
  });
  const sender = createTextSender(adapter, interceptor, getPageUrl);
  interceptor.start();
  document.addEventListener('keydown', () => sent(editor.value));
  document.addEventListener('click', () => sent(editor.value));
  cleanups.push(interceptor.stop, scanner.dispose, review.dispose, sender.cancel);
  const submit = (source: 'enter' | 'button') => {
    const event = new window.Event(source === 'enter' ? 'keydown' : 'click', { bubbles: true, cancelable: true });
    Object.assign(event, { key: 'Enter', keyCode: 13 });
    (source === 'enter' ? editor : button).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  };
  return { document, editor, original, pending, scanText, onError, onDiscarded, sent, submit,
    finishScan: () => scanTask };
}

describe('clean text automatically sends after scanning', () => {
  it.each(['enter', 'button'] as const)('holds %s and sends the exact original once without another scan or dialog', async source => {
    const f = setup();
    f.submit(source);
    f.submit(source === 'enter' ? 'button' : 'enter');
    expect(f.sent).not.toHaveBeenCalled();
    expect(f.scanText).toHaveBeenCalledExactlyOnceWith(f.original, { signal: expect.any(AbortSignal) });
    f.pending.resolve([]);
    await f.finishScan();
    await vi.advanceTimersByTimeAsync(50);
    expect(f.sent).toHaveBeenCalledExactlyOnceWith(f.original);
    expect(f.editor.value).toBe(f.original);
    expect(f.scanText).toHaveBeenCalledOnce();
    expect(f.document.querySelector('[data-blaind-review]')).toBeNull();
    expect(f.onError).not.toHaveBeenCalled();
  });

  it('keeps text held when scanning fails', async () => {
    const f = setup(); f.submit('enter');
    const error = new Error('model unavailable');
    f.pending.reject(error);
    await f.finishScan();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(f.sent).not.toHaveBeenCalled();
    expect(f.editor.value).toBe(f.original);
  });

  it.each(['during scanning', 'while preparing send'] as const)('does not send when input changes %s', async timing => {
    const f = setup(); f.submit('button');
    if (timing === 'during scanning') f.editor.value = '수정한 질문';
    f.pending.resolve([]);
    await f.finishScan();
    if (timing === 'while preparing send') f.editor.value = '수정한 질문';
    await vi.advanceTimersByTimeAsync(100);
    expect(f.sent).not.toHaveBeenCalled();
    expect(f.editor.value).toBe('수정한 질문');
    expect(f.scanText).toHaveBeenCalledOnce();
    expect(f.document.querySelector('[data-blaind-review]')).toBeNull();
    if (timing === 'during scanning') expect(f.onDiscarded).toHaveBeenCalledOnce();
    else expect(f.onError).toHaveBeenCalledOnce();
  });
});
