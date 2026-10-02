import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDocumentServer } from '../../../src/shared/messaging/document-server';
import { DOCUMENT_CHANNEL } from '../../../src/shared/messaging/document-client';
import { mockRuntime } from './helpers';
import type { MessageSender } from '../../../src/shared/messaging/types';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); });
function fixture(host: 'background' | 'offscreen') {
  const { runtime, listeners } = mockRuntime();
  cleanups.push(installDocumentServer(runtime, host));
  const listener = [...listeners][0]!;
  const sender = { id: runtime.id, url: 'https://chatgpt.com/c/one', tab: { id: 1 }, frameId: 0 };
  const call = (op: string, from: MessageSender = sender, extra = {}) => new Promise<any>(resolve => {
    const handled = listener({ channel: DOCUMENT_CHANNEL, target: host, sessionId: 'same-id', kind: 'pdf',
      owner: 'forged-owner', op, ...extra }, from, resolve);
    if (!handled) resolve(undefined);
  });
  return { call, sender, runtime };
}
describe('document processing host routing', () => {
  it('Firefox handles document sessions in background without offscreen', async () => {
    const f = fixture('background');
    expect(await f.call('begin')).toEqual({ ok: true });
    expect(await f.call('append', f.sender, { data: btoa('pdf bytes') })).toEqual({ ok: true });
    expect(await f.call('close')).toEqual({ ok: true });
  });
  it('Firefox scopes equal session IDs to actual sender rather than supplied owner', async () => {
    const f = fixture('background');
    expect(await f.call('begin')).toEqual({ ok: true });
    const other = { ...f.sender, tab: { id: 2 } };
    expect(await f.call('append', other, { data: btoa('bytes') })).toMatchObject({ ok: false });
    expect(await f.call('begin', other)).toEqual({ ok: true });
    expect(await f.call('close', other)).toEqual({ ok: true });
    expect(await f.call('append', f.sender, { data: btoa('bytes') })).toEqual({ ok: true });
  });
  it('rejects external senders and direct content messages to Chrome offscreen', async () => {
    const firefox = fixture('background');
    expect(await firefox.call('begin', { ...firefox.sender, id: 'another-extension' })).toBeUndefined();
    const chrome = fixture('offscreen');
    expect(await chrome.call('begin')).toBeUndefined();
    expect(await chrome.call('begin', { id: chrome.runtime.id, url: chrome.runtime.getURL('background.js') })).toEqual({ ok: true });
  });
});
