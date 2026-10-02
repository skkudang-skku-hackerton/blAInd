import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createTextSender } from '../../src/features/review/text-send';
import { createTextSubmitInterceptor } from '../../src/modules/text';
import { getTextSiteAdapter } from '../../src/modules/sites/text-adapters';
import type { TextSubmitContext } from '../../src/modules/text';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function setup() {
  const { window, document } = parseHTML('<html><body><form data-chat-id="one"><textarea id="prompt-textarea"></textarea><button aria-label="보내기">Send</button></form></body></html>');
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('MouseEvent', window.Event);
  const editor = document.querySelector('textarea')! as unknown as HTMLTextAreaElement;
  editor.value = 'original';
  const button = document.querySelector('button')! as unknown as HTMLButtonElement;
  const adapter = getTextSiteAdapter('chatgpt');
  const onIntercept = vi.fn();
  const interceptor = createTextSubmitInterceptor({ adapter, root: document as unknown as Document, onIntercept });
  interceptor.start(); cleanups.push(interceptor.stop);
  const sent = vi.fn(); document.addEventListener('click', () => sent(editor.value));
  let url = 'https://chatgpt.com/c/one';
  const sender = createTextSender(adapter, interceptor, () => url);
  cleanups.push(sender.cancel);
  const context: TextSubmitContext = { siteId: 'chatgpt', source: 'enter', editor, text: 'original' };
  return { document, window, editor, button, adapter, interceptor, sender, context, sent, onIntercept,
    navigate: () => { url += '/other'; } };
}
describe('approved text sending', () => {
  it('replaces the editor and passes exactly one approved click without scanning again', async () => {
    const f = setup(); await f.sender.send(f.context, '[PERSON_1]');
    expect(f.sent).toHaveBeenCalledExactlyOnceWith('[PERSON_1]');
    expect(f.onIntercept).not.toHaveBeenCalled();
    f.button.dispatchEvent(new f.window.Event('click', { bubbles: true, cancelable: true }));
    expect(f.onIntercept).toHaveBeenCalledOnce();
    expect(f.sent).toHaveBeenCalledTimes(1);
  });
  it('sends approved unchanged text through the same one-time gate', async () => {
    const f = setup(); await f.sender.send(f.context, 'original');
    expect(f.sent).toHaveBeenCalledExactlyOnceWith('original');
  });
  it.each(['edit', 'navigation', 'cancel', 'conversation'] as const)('blocks %s during the update', async kind => {
    const f = setup(); const task = f.sender.send(f.context, '[PERSON_1]');
    if (kind === 'edit') f.editor.value = 'new unreviewed text';
    if (kind === 'navigation') f.navigate();
    if (kind === 'cancel') f.sender.cancel();
    if (kind === 'conversation') f.document.querySelector('form')!.setAttribute('data-chat-id', 'two');
    await expect(task).rejects.toThrow(); expect(f.sent).not.toHaveBeenCalled();
  });
  it('blocks a stale approval before replacing', async () => {
    const f = setup(); f.editor.value = 'changed';
    await expect(f.sender.send(f.context, '[PERSON_1]')).rejects.toThrow();
    expect(f.editor.value).toBe('changed'); expect(f.sent).not.toHaveBeenCalled();
  });
  it('does not send using a disabled or missing button', async () => {
    vi.useFakeTimers(); const f = setup(); f.button.disabled = true;
    const task = expect(f.sender.send(f.context, '[PERSON_1]')).rejects.toThrow('Send button');
    await vi.runAllTimersAsync(); await task; expect(f.sent).not.toHaveBeenCalled();
  });
  it('fails closed when approved-event validation throws', () => {
    const f = setup(); vi.spyOn(f.adapter, 'readText').mockImplementation(() => { throw new Error('read failed'); });
    expect(() => f.interceptor.sendApproved(f.button, f.editor, 'original')).toThrow();
    expect(f.sent).not.toHaveBeenCalled();
  });
});
