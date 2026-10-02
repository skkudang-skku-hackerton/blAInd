import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createTextScanController } from '../../src/features/review/text-scan';
import { createTextSubmitInterceptor } from '../../src/modules/text';
import { getTextSiteAdapter } from '../../src/modules/sites/text-adapters';
import type { Detection } from '../../src/core/api';
import type { TextSubmitContext } from '../../src/modules/text';
import { deferred } from './messaging/helpers';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture(text = '😀 김민수\n010-1234-5678') {
  const { document, window } = parseHTML('<html><body><form data-chat-id="first"><textarea id="prompt-textarea"></textarea><button aria-label="보내기">전송</button></form></body></html>');
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  const editor = document.querySelector('textarea')! as unknown as HTMLTextAreaElement;
  editor.value = text;
  const adapter = getTextSiteAdapter('chatgpt');
  const pending: Array<ReturnType<typeof deferred<Detection[]>> & { signal: AbortSignal }> = [];
  const scanText = vi.fn((_text: string, options?: { signal?: AbortSignal }) => {
    const request = { ...deferred<Detection[]>(), signal: options!.signal! };
    pending.push(request);
    return request.promise;
  });
  const onScanning = vi.fn(), onResult = vi.fn(), onError = vi.fn(), onDiscarded = vi.fn();
  let pageUrl = 'https://chatgpt.com/c/first';
  const scanner = createTextScanController({
    detector: { scanText }, readText: adapter.readText, getPageUrl: () => pageUrl,
    onScanning, onResult, onError, onDiscarded,
  });
  const context: TextSubmitContext = { editor, text, siteId: 'chatgpt', source: 'enter' };
  cleanups.push(() => scanner.dispose());
  return { document, window, editor, adapter, scanner, context, pending, scanText,
    onScanning, onResult, onError, onDiscarded, navigate: () => { pageUrl += '/next'; } };
}

describe('held text → model', () => {
  it.each(['enter', 'button'] as const)('%s is blocked before the original snapshot reaches the model', async source => {
    const f = fixture();
    const submit = vi.fn();
    const interceptor = createTextSubmitInterceptor({
      adapter: f.adapter, root: f.document as unknown as Document,
      onIntercept: context => {
        expect(event.defaultPrevented).toBe(true);
        void f.scanner.scan(context);
      },
    });
    interceptor.start();
    cleanups.push(() => interceptor.stop());
    f.document.addEventListener(source === 'enter' ? 'keydown' : 'click', submit);
    const event = new f.window.Event(source === 'enter' ? 'keydown' : 'click', { bubbles: true, cancelable: true });
    Object.assign(event, { key: 'Enter', keyCode: 13 });
    const target = source === 'enter' ? f.editor : f.document.querySelector('button')!;
    target.dispatchEvent(event);

    expect(submit).not.toHaveBeenCalled();
    expect(f.scanText).toHaveBeenCalledWith(f.context.text, { signal: expect.any(AbortSignal) });
    const detections: Detection[] = [{ type: 'PHONE', confidence: 0.99, span: { start: 7, end: 20 } }];
    f.pending[0]!.resolve(detections);
    await vi.waitFor(() => expect(f.onResult).toHaveBeenCalledOnce());
    expect(f.scanner.getResult()).toEqual({ ...f.context, source, detections });
    expect(f.editor.value).toBe(f.context.text);
    expect(submit).not.toHaveBeenCalled();
  });

  it('joins repeated Enter/button attempts for the same pending input', async () => {
    const f = fixture();
    const first = f.scanner.scan(f.context);
    const second = f.scanner.scan({ ...f.context, source: 'button' });
    expect(second).toBe(first);
    expect(f.scanText).toHaveBeenCalledOnce();
    f.pending[0]!.resolve([]);
    await first;
    expect(f.onResult).toHaveBeenCalledWith({ ...f.context, detections: [] });
  });

  it('new input cancels only its previous scan and ignores that scan’s late result', async () => {
    const f = fixture();
    const first = f.scanner.scan(f.context);
    f.editor.value = '새 질문';
    const secondContext = { ...f.context, text: f.editor.value };
    const second = f.scanner.scan(secondContext);
    expect(f.pending[0]!.signal.aborted).toBe(true);
    expect(f.pending[1]!.signal.aborted).toBe(false);
    f.pending[0]!.resolve([{ type: 'PERSON', confidence: 1, span: { start: 3, end: 6 } }]);
    await first;
    expect(f.onResult).not.toHaveBeenCalled();
    f.pending[1]!.resolve([]);
    await second;
    expect(f.onResult).toHaveBeenCalledWith({ ...secondContext, detections: [] });
    expect(f.onDiscarded).not.toHaveBeenCalled();
  });

  it('input events invalidate a scan even if the user immediately restores the original text', async () => {
    const f = fixture();
    const scanning = f.scanner.scan(f.context);
    f.editor.value = '수정';
    f.scanner.invalidate();
    f.editor.value = f.context.text;
    expect(f.pending[0]!.signal.aborted).toBe(true);
    f.pending[0]!.resolve([]);
    await scanning;
    expect(f.onResult).not.toHaveBeenCalled();
    expect(f.onDiscarded).toHaveBeenCalledOnce();
  });

  it('detects programmatic textarea changes during inference without an input event', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const scanning = f.scanner.scan(f.context);
    f.editor.value = '수정';
    await vi.advanceTimersByTimeAsync(100);
    expect(f.pending[0]!.signal.aborted).toBe(true);
    f.pending[0]!.resolve([]);
    await scanning;
    expect(f.onResult).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['url', 'removed-editor', 'conversation-id'] as const)('discards results after changing %s', async change => {
    const f = fixture();
    const scanning = f.scanner.scan(f.context);
    if (change === 'url') f.navigate();
    else if (change === 'removed-editor') f.editor.remove();
    else f.document.querySelector('form')!.setAttribute('data-chat-id', 'second');
    f.pending[0]!.resolve([]);
    await scanning;
    expect(f.onResult).not.toHaveBeenCalled();
    expect(f.scanner.getResult()).toBeNull();
    expect(f.onDiscarded).toHaveBeenCalledOnce();
  });

  it('explicit navigation cancellation ignores late failures and releases retained results', async () => {
    const f = fixture();
    const scanning = f.scanner.scan(f.context);
    f.scanner.cancel();
    f.pending[0]!.reject(new Error('late failure'));
    await scanning;
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.scanner.getResult()).toBeNull();
  });

  it('holds model failures and allows a new attempt', async () => {
    const f = fixture();
    const scanning = f.scanner.scan(f.context);
    const error = new Error('model unavailable');
    f.pending[0]!.reject(error);
    await scanning;
    expect(f.onError).toHaveBeenCalledWith(error);
    expect(f.onResult).not.toHaveBeenCalled();
    expect(f.scanner.isScanning()).toBe(false);
    const retry = f.scanner.scan(f.context);
    f.pending[1]!.resolve([]);
    await retry;
    expect(f.onResult).toHaveBeenCalledOnce();
  });

  it('revalidates completed results and stops input watching after completion', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const scanning = f.scanner.scan(f.context);
    f.pending[0]!.resolve([]);
    await scanning;
    expect(vi.getTimerCount()).toBe(0);
    f.editor.value = '수정';
    expect(f.scanner.getResult()).toBeNull();
  });

  it('disposal cancels pending inference and suppresses all late UI updates', async () => {
    const f = fixture();
    const scanning = f.scanner.scan(f.context);
    f.scanner.dispose();
    expect(f.pending[0]!.signal.aborted).toBe(true);
    f.pending[0]!.resolve([]);
    await scanning;
    await f.scanner.scan(f.context);
    expect(f.scanText).toHaveBeenCalledOnce();
    expect(f.onResult).not.toHaveBeenCalled();
    expect(f.onDiscarded).not.toHaveBeenCalled();
  });
});
