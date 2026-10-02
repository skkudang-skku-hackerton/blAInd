import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createFileUploadInterceptor as chatgpt } from '../../src/modules/sites/chatgpt/file-upload/dom-interceptor';
import { createFileUploadInterceptor as claude } from '../../src/modules/sites/claude/file-upload/dom-interceptor';
import { createFileUploadInterceptor as gemini } from '../../src/modules/sites/gemini/file-upload/dom-interceptor';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.unstubAllGlobals(); });

function fixture(factory: typeof chatgpt, href: string) {
  const { window, document } = parseHTML('<html><body><form id="old-chat"><input id="old-upload" type="file" accept="application/pdf"><div id="editor"></div></form></body></html>');
  for (const name of ['window', 'document', 'Document', 'Element', 'HTMLElement', 'HTMLInputElement', 'Event', 'MutationObserver'] as const) {
    vi.stubGlobal(name, name === 'window' ? window : name === 'document' ? document : window[name]);
  }
  const location = { href };
  Object.defineProperty(window, 'location', { configurable: true, value: location });
  const navigation = new window.EventTarget();
  Object.defineProperty(window, 'navigation', { configurable: true, value: navigation });
  class Transfer {
    files: File[] = [];
    items = { add: (file: File) => this.files.push(file) };
  }
  vi.stubGlobal('DataTransfer', Transfer);
  vi.stubGlobal('DragEvent', class extends window.Event {
    dataTransfer: Transfer;
    constructor(type: string, options: EventInit & { dataTransfer: Transfer }) {
      super(type, options); this.dataTransfer = options.dataTransfer;
    }
  });
  const pending: Array<{ resolve: (file: File | null) => void; signal: AbortSignal }> = [];
  const onProcessed = vi.fn(), onError = vi.fn();
  const indicator = { show: vi.fn(), hide: vi.fn(), update: vi.fn(), destroy: vi.fn(), visible: false, element: null };
  const interceptor = factory({ root: document as unknown as Document, indicator,
    processors: { pdf: (_file, signal) => new Promise((resolve) => { pending.push({ resolve, signal }); }) },
    onProcessed, onError,
  });
  interceptor.start();
  cleanups.push(() => interceptor.stop());
  const original = document.querySelector('input')!;
  const file = new File(['original'], 'input.pdf', { type: 'application/pdf' });
  const processed = new File(['processed'], 'masked.pdf', { type: 'application/pdf' });
  const select = (input = original) => {
    Object.defineProperty(input, 'files', { configurable: true, writable: true, value: [file] });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const finish = async (index = 0) => {
    pending[index]!.resolve(processed);
    // Flush the processFile / Promise.all / process continuation chain.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const replaceInput = () => {
    original.remove();
    const next = document.createElement('input');
    next.type = 'file'; next.accept = 'application/pdf'; next.id = 'new-upload';
    document.querySelector('form')!.append(next);
    return next;
  };
  return { document, window, original, location, navigation, pending, select, finish, replaceInput,
    processed, file, interceptor, onProcessed, onError, indicator };
}

describe.each([
  ['ChatGPT', chatgpt, 'https://chatgpt.com/c/old-chat'],
  ['Claude', claude, 'https://claude.ai/chat/old-chat'],
  ['Gemini', gemini, 'https://gemini.google.com/app/old-chat'],
] as const)('%s upload conversation binding', (_name, factory, href) => {
  it('reproduces #13: never injects into another conversation with identical accept', async () => {
    const f = fixture(factory, href);
    f.select();
    f.document.querySelector('form')!.remove();
    f.document.body.innerHTML = '<form id="new-chat"><input id="new-upload" type="file" accept="application/pdf"></form>';
    f.location.href = href.replace('old-chat', 'new-chat');
    const next = f.document.querySelector('input')!;
    const change = vi.fn(); next.addEventListener('change', change);
    await f.finish();
    expect(change).not.toHaveBeenCalled();
    expect(f.pending[0]!.signal.aborted).toBe(true);
    expect(f.onProcessed).not.toHaveBeenCalled();
    expect(f.interceptor.isProcessing).toBe(false);
  });

  it('allows a single replacement input inside the same surviving composer', async () => {
    const f = fixture(factory, href);
    f.select();
    const next = f.replaceInput();
    const change = vi.fn(); next.addEventListener('change', change);
    await f.finish();
    expect(change).toHaveBeenCalledOnce();
    expect((next as unknown as HTMLInputElement).files?.[0]).toBe(f.processed);
    expect(f.onProcessed).toHaveBeenCalledOnce();
  });

  it('holds when composer identity is lost even at the same URL', async () => {
    const f = fixture(factory, href);
    f.select();
    f.document.body.innerHTML = '<form><input type="file" accept="application/pdf"></form>';
    await f.finish();
    expect(f.onProcessed).not.toHaveBeenCalled();
  });

  it('holds ambiguous replacement inputs and unknown conversation identities', async () => {
    const f = fixture(factory, new URL(href).origin);
    f.select(); f.replaceInput();
    await f.finish();
    expect(f.onProcessed).not.toHaveBeenCalled();
    expect(f.onError).toHaveBeenCalledOnce();
  });

  it('rejects reused inputs after URL changes without waiting for a timer', async () => {
    const f = fixture(factory, href);
    f.select();
    f.location.href = href.replace('old-chat', 'new-chat');
    await f.finish();
    expect(f.onProcessed).not.toHaveBeenCalled();
    expect(f.pending[0]!.signal.aborted).toBe(true);
  });

  it('cancels on navigation even if the user immediately returns to the same URL', async () => {
    const f = fixture(factory, href);
    f.select();
    f.navigation.dispatchEvent(new f.window.Event('navigate'));
    expect(f.pending[0]!.signal.aborted).toBe(true);
    await f.finish();
    expect(f.onProcessed).not.toHaveBeenCalled();
    expect(f.indicator.hide).toHaveBeenCalled();
  });

  it('new file selection discards only the previous batch', async () => {
    const f = fixture(factory, href);
    f.select(); f.select();
    expect(f.pending[0]!.signal.aborted).toBe(true);
    expect(f.pending[1]!.signal.aborted).toBe(false);
    await f.finish(0);
    expect(f.onProcessed).not.toHaveBeenCalled();
    expect(f.interceptor.isProcessing).toBe(true);
    await f.finish(1);
    expect(f.onProcessed).toHaveBeenCalledOnce();
  });

  it.each(['abort', 'stop'] as const)('%s cancels processing and late results', async (method) => {
    const f = fixture(factory, href);
    f.select(); f.interceptor[method]();
    await f.finish();
    expect(f.pending[0]!.signal.aborted).toBe(true);
    expect(f.onProcessed).not.toHaveBeenCalled();
    expect(f.interceptor.isProcessing).toBe(false);
  });

  it.each(['drop', 'paste'] as const)('%s cannot fall back to another composer', async (kind) => {
    const f = fixture(factory, href);
    const event = new f.window.Event(kind, { bubbles: true });
    Object.assign(event, kind === 'drop' ? { dataTransfer: { files: [f.file] } } : { clipboardData: { files: [f.file] } });
    f.document.querySelector('#editor')!.dispatchEvent(event);
    expect(f.pending).toHaveLength(1);
    f.document.body.innerHTML = '<form><input type="file" accept="application/pdf"></form>';
    await f.finish();
    expect(f.onProcessed).not.toHaveBeenCalled();
  });
});
