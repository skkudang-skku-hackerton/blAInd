import { expect, it, vi } from 'vitest';
import { installReviewRelay, REVIEW_PORT_PREFIX } from '../../../src/shared/messaging/review-channel';

const id = '12345678-1234-1234-1234-123456789abc';
const url = `moz-extension://test/document-review.html#${id}`;
function port(role: 'host' | 'frame', tabId = 1, page = role === 'frame' ? url : 'https://gemini.google.com/app') {
  const messages = new Set<(message: unknown) => void>();
  const disconnects = new Set<() => void>();
  return {
    name: `${REVIEW_PORT_PREFIX}${id}:${role}`,
    sender: { id: 'test', tab: { id: tabId }, frameId: role === 'host' ? 0 : 1, url: page },
    onMessage: { addListener: (fn: (message: unknown) => void) => messages.add(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.add(fn) },
    postMessage: vi.fn(), disconnect: vi.fn(),
    emit: (message: unknown) => messages.forEach(fn => fn(message)),
    close: () => disconnects.forEach(fn => fn()),
  };
}
function setup() {
  let connect!: (connection: ReturnType<typeof port>) => void;
  const runtime = {
    id: 'test', getURL: (path: string) => `moz-extension://test${path}`,
    onConnect: { addListener: vi.fn(fn => { connect = fn; }), removeListener: vi.fn() },
  };
  const cleanup = installReviewRelay(runtime as unknown as Parameters<typeof installReviewRelay>[0]);
  const host = port('host');
  connect(host);
  return { host, connect, cleanup };
}

it('relays review data only after the matching extension frame connects', () => {
  const f = setup(), frame = port('frame');
  f.connect(frame);
  frame.emit({ type: 'ready' });
  expect(f.host.postMessage).toHaveBeenCalledWith({ type: 'ready' });
  const message = { type: 'open', request: { segments: [] } };
  f.host.emit(message);
  expect(frame.postMessage).toHaveBeenCalledWith(message);
  const decision = { type: 'decision', result: { status: 'cancelled' } };
  frame.emit(decision);
  expect(f.host.postMessage).toHaveBeenCalledWith(decision);
  f.host.close();
  expect(frame.disconnect).toHaveBeenCalledOnce();
  f.cleanup();
});

it.each([
  ['different tab', 2, url],
  ['page origin', 1, `https://gemini.google.com/app#${id}`],
  ['wrong session URL', 1, 'moz-extension://test/document-review.html#other'],
] as const)('rejects an iframe from %s without delivering document data', (_case, tabId, page) => {
  const f = setup(), frame = port('frame', tabId, page);
  f.connect(frame);
  f.host.emit({ type: 'open', request: { segments: ['private'] } });
  expect(frame.disconnect).toHaveBeenCalledOnce();
  expect(frame.postMessage).not.toHaveBeenCalled();
  f.cleanup();
});

it('notifies the content side by disconnecting when the review frame is lost', () => {
  const f = setup(), frame = port('frame');
  f.connect(frame);
  frame.close();
  expect(f.host.disconnect).toHaveBeenCalledOnce();
  f.cleanup();
});
