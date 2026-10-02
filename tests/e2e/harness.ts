import { KoPiiRuntime } from '../../src/core/detector/ko-pii/runtime';
import { KoPiiDetector } from '../../src/core/detector/ko-pii/detector';
import { DEFAULT_CHUNK_SIZE, chunkTokens } from '../../src/core/detector/ko-pii/chunker';
import { MODEL_CONFIG } from '../../src/core/detector/ko-pii/model-config';
import type { PiiDetectorApi } from '../../src/core/api/pii-detector';
import { cancellationChecks } from './cancellation';

const options = {
  preferredBackend: 'wasm',
  wasmPaths: '/node_modules/onnxruntime-web/dist/',
} as const;
let runtime = new KoPiiRuntime(options);
let detector = new KoPiiDetector(runtime);

declare global {
  interface Window {
    piiHarness: {
      detector: PiiDetectorApi;
      backend(): string;
      reset(): Promise<void>;
      cancellationChecks(longText: string, shortText: string): ReturnType<typeof cancellationChecks>;
      boundaryFixture(): { text: string; boundary: number; tokenCount: number; chunkCount: number };
    };
    piiDetector?: PiiDetectorApi;
  }
}

window.piiHarness = {
  get detector() { return detector; },
  backend: () => runtime.backend(),
  cancellationChecks: (longText, shortText) => cancellationChecks(runtime, longText, shortText),
  async reset() {
    await runtime.dispose?.();
    runtime = new KoPiiRuntime(options);
    detector = new KoPiiDetector(runtime);
  },
  boundaryFixture() {
    // Verify a phone crosses a real token-chunk edge; overlap must recover it.
    const filler = '문서 ';
    const phone = '010-1234-5678';
    for (let count = 1; count <= DEFAULT_CHUNK_SIZE; count++) {
      const prefix = `😀 ${filler.repeat(count)}연락처는 ${phone}입니다. `;
      const input = runtime.tokenizer().encode(prefix, false);
      const boundary = input.offsets[DEFAULT_CHUNK_SIZE]?.[0] ?? -1;
      const start = prefix.indexOf(phone);
      if (start < boundary && boundary < start + phone.length) {
        const text = `${prefix}${filler.repeat(MODEL_CONFIG.maxSequenceLength)}이메일은 minsu@example.com입니다.`;
        const fullInput = runtime.tokenizer().encode(text, false);
        return { text, boundary, tokenCount: fullInput.ids.length, chunkCount: chunkTokens(fullInput).length };
      }
    }
    throw new Error('Could not place phone across the real tokenizer chunk boundary');
  },
};
document.querySelector('#state')!.textContent = 'Harness ready';
