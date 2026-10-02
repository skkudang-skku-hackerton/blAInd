import { vi } from 'vitest';
import { PII_CHANNEL, type MessageListener, type MessagingRuntime, type PiiRequest } from '../../../src/shared/messaging/types';
import type { InferenceWorker } from '../../../src/entrypoints/offscreen/rpc';

/** Assert fixture/call presence at runtime as well as under noUncheckedIndexedAccess. */
export function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing test fixture or mock call at index ${index}.`);
  return value;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function mockRuntime() {
  const listeners = new Set<MessageListener>();
  const sendMessage = vi.fn<MessagingRuntime['sendMessage']>();
  const runtime: MessagingRuntime = {
    id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`, sendMessage,
    onMessage: { addListener: listener => { listeners.add(listener); },
      removeListener: listener => { listeners.delete(listener); } },
  };
  return { runtime, listeners, sendMessage };
}
export function request(id = 'request-1', type: 'pii:init' | 'pii:scan-text' = 'pii:init'): PiiRequest {
  return type === 'pii:init' ? { channel: PII_CHANNEL, target: 'worker', clientId: 'test-client', requestId: id, type } :
    { channel: PII_CHANNEL, target: 'worker', clientId: 'test-client', requestId: id, type, text: '김민수' };
}
export function ready(req: { requestId: string; clientId?: string; ownerKey?: string }) {
  return { channel: PII_CHANNEL, requestId: req.requestId, clientId: req.clientId ?? 'test-client', ownerKey: req.ownerKey, type: 'pii:ready' } as const;
}
export class MockWorker implements InferenceWorker {
  listeners = new Map<string, Set<(event: any) => void>>();
  postMessage = vi.fn();
  terminate = vi.fn();
  addEventListener(type: string, listener: (event: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: any) => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string, event: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}
