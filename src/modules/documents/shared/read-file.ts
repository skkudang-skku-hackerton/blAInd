import { abortable } from './abortable';

/** Read page-owned files without chaining their Promises across Firefox realms. */
export function readFileBytes(file: Blob, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  // Document processors also run in non-DOM environments such as Node.
  if (typeof FileReader === 'undefined') return abortable(file.arrayBuffer(), signal);

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => {
      signal.removeEventListener('abort', cancel);
      reader.onload = reader.onerror = reader.onabort = null;
    };
    const cancel = () => {
      cleanup();
      reader.abort();
      reject(signal.reason ?? new DOMException('Document reading cancelled', 'AbortError'));
    };
    reader.onload = () => {
      const result = reader.result;
      cleanup();
      // FileReader guarantees ArrayBuffer | string | null. Firefox may expose
      // a buffer from another realm, where instanceof ArrayBuffer is false.
      if (result === null || typeof result === 'string') {
        reject(new Error('Invalid file reader result'));
        return;
      }
      try {
        // Copy into our realm without consulting the source's constructor or
        // species (as ArrayBuffer#slice would). Keep later processing local.
        const source = new Uint8Array(result);
        const bytes = new Uint8Array(source.byteLength);
        bytes.set(source);
        resolve(bytes.buffer);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => {
      const error = reader.error;
      cleanup();
      reject(error ?? new Error('File reading failed'));
    };
    reader.onabort = () => {
      cleanup();
      reject(new DOMException('Document reading cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      reader.readAsArrayBuffer(file);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
