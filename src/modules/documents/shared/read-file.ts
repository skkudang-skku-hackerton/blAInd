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
      if (result instanceof ArrayBuffer) resolve(result);
      else reject(new Error('Invalid file reader result'));
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
