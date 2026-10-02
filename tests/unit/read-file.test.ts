import { afterEach, expect, it, vi } from 'vitest';
import { readFileBytes } from '../../src/modules/documents/shared/read-file';

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  let reader!: Reader;
  class Reader {
    result: ArrayBuffer | null = null;
    error: DOMException | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    readAsArrayBuffer = vi.fn();
    abort = vi.fn(() => this.onabort?.());
    constructor() { reader = this; }
  }
  vi.stubGlobal('FileReader', Reader);
  const file = new Blob(['document']);
  const arrayBuffer = vi.spyOn(file, 'arrayBuffer').mockImplementation(() => {
    throw new Error('Permission denied to access property "constructor"');
  });
  const controller = new AbortController();
  return { file, arrayBuffer, controller, get reader() { return reader; } };
}

it('reads through the local FileReader without accessing the page file Promise', async () => {
  const f = fixture();
  const pending = readFileBytes(f.file, f.controller.signal);
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  expect(f.reader.readAsArrayBuffer).toHaveBeenCalledWith(f.file);
  f.reader.result = bytes;
  f.reader.onload!();
  await expect(pending).resolves.toBe(bytes);
  expect(f.arrayBuffer).not.toHaveBeenCalled();
  f.controller.abort();
  expect(f.reader.abort).not.toHaveBeenCalled();
});

it('aborts an in-progress read and detaches handlers', async () => {
  const f = fixture();
  const pending = readFileBytes(f.file, f.controller.signal);
  f.controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.reader.abort).toHaveBeenCalledOnce();
  expect(f.reader.onload).toBeNull();
});

it('propagates read errors and removes the cancellation listener', async () => {
  const f = fixture();
  const pending = readFileBytes(f.file, f.controller.signal);
  f.reader.error = new DOMException('Cannot read file', 'NotReadableError');
  f.reader.onerror!();
  await expect(pending).rejects.toBe(f.reader.error);
  f.controller.abort();
  expect(f.reader.abort).not.toHaveBeenCalled();
});

it('does not start reading when already cancelled', () => {
  const f = fixture();
  f.controller.abort();
  expect(() => readFileBytes(f.file, f.controller.signal)).toThrow();
  expect(f.arrayBuffer).not.toHaveBeenCalled();
});
