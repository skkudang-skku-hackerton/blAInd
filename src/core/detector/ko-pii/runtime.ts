import type * as Ort from 'onnxruntime-web/wasm';
import { PiiError, toPiiError } from '../../api/errors';
import type { PiiDetectorStatus } from '../../api/types';
import type { DetectorTokenizer, InferenceRuntime, ModelOutput, TokenizedInput } from '../types';
import { MODEL_CONFIG, validateLabels } from './model-config';
import { loadArtifact, loadMetadata, type ModelCacheOptions } from './model-cache';
import { KoPiiTokenizer } from './tokenizer';

export interface KoPiiRuntimeOptions {
  preferredBackend?: 'wasm' | 'webgpu';
  /** Locally bundled ORT assets. Defaults to the current extension origin's ort-wasm directory. */
  wasmPaths?: string;
  fetch?: typeof globalThis.fetch;
  cacheStorage?: CacheStorage;
}

export class KoPiiRuntime implements InferenceRuntime {
  private session?: Ort.InferenceSession;
  private ort?: typeof Ort;
  private gpuOrt?: typeof Ort;
  private tokenizerInstance?: KoPiiTokenizer;
  private labelMap?: Readonly<Record<string, string>>;
  private selectedBackend: 'wasm' | 'webgpu' = 'wasm';
  private initialization?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private status: PiiDetectorStatus = { state: 'idle' };
  private listeners = new Set<(status: PiiDetectorStatus) => void>();

  constructor(private readonly options: KoPiiRuntimeOptions = {}) {}

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private emit(status: PiiDetectorStatus): void {
    this.status = status;
    for (const listener of this.listeners) {
      try { listener(status); } catch { /* Observers cannot break inference. */ }
    }
  }
  onStatus(listener: (status: PiiDetectorStatus) => void): () => void {
    this.listeners.add(listener);
    try { listener(this.status); } catch { /* Observer isolation. */ }
    return () => { this.listeners.delete(listener); };
  }
  backend(): 'wasm' | 'webgpu' { return this.selectedBackend; }
  tokenizer(): DetectorTokenizer {
    if (!this.tokenizerInstance) throw new PiiError('MODEL_NOT_READY', 'Model is not initialized');
    return this.tokenizerInstance;
  }
  labels(): Readonly<Record<string, string>> {
    if (!this.labelMap) throw new PiiError('MODEL_NOT_READY', 'Model is not initialized');
    return this.labelMap;
  }
  private cacheOptions(): ModelCacheOptions {
    return { fetch: this.options.fetch, cacheStorage: this.options.cacheStorage,
      onProgress: progress => this.emit({ state: 'downloading', progress }) };
  }
  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = this.serialized(async () => {
      if (this.session) return;
      try {
        const config = await loadMetadata('config.json', this.cacheOptions());
        const tokenizerJson = await loadMetadata('tokenizer.json', this.cacheOptions());
        const tokenizerConfig = await loadMetadata('tokenizer_config.json', this.cacheOptions());
        this.labelMap = validateLabels(config);
        this.tokenizerInstance = new KoPiiTokenizer(tokenizerJson, tokenizerConfig);
        let gpuSupported = false;
        if (this.options.preferredBackend === 'webgpu') {
          try {
            const gpu = (globalThis.navigator as unknown as { gpu?: { requestAdapter(): Promise<{ features: { has(name: string): boolean } } | null> } })?.gpu;
            const adapter = await gpu?.requestAdapter();
            gpuSupported = !!adapter?.features.has('shader-f16');
          } catch { /* Unsupported/unavailable adapter: do not download FP16. */ }
        }
        if (gpuSupported) {
          try { await this.createSession('webgpu'); }
          catch { await this.releaseSession(); await this.createSession('wasm'); }
        } else await this.createSession('wasm');
        this.emit({ state: 'ready', backend: this.selectedBackend });
      } catch (error) {
        await this.releaseSession();
        this.tokenizerInstance = undefined;
        this.labelMap = undefined;
        const classified = toPiiError(error, 'MODEL_LOAD_FAILED');
        this.emit({ state: 'error', message: classified.message });
        throw classified;
      }
    }).finally(() => { this.initialization = undefined; });
    return this.initialization;
  }
  private async createSession(backend: 'wasm' | 'webgpu'): Promise<void> {
    let ort: typeof Ort;
    if (backend === 'webgpu') {
      if (import.meta.env.FIREFOX || import.meta.env.SAFARI) throw new Error('WebGPU backend is disabled in Firefox and Safari builds');
      ort = await import('onnxruntime-web/webgpu');
    } else ort = this.gpuOrt ?? await import('onnxruntime-web/wasm');
    if (backend === 'webgpu') this.gpuOrt = ort;
    const extensionApis = globalThis as unknown as {
      browser?: { runtime?: { getURL(path: string): string } };
      chrome?: { runtime?: { getURL(path: string): string } };
    };
    const extensionUrl = extensionApis.browser?.runtime?.getURL('ort-wasm/') ??
      extensionApis.chrome?.runtime?.getURL('ort-wasm/');
    const localOriginUrl = globalThis.location &&
      ['moz-extension:', 'chrome-extension:', 'safari-web-extension:', 'webkit-extension:'].includes(globalThis.location.protocol)
      ? new URL('/ort-wasm/', globalThis.location.href).href
      : undefined;
    const wasmPaths = this.options.wasmPaths ?? extensionUrl ?? localOriginUrl ?? '/ort-wasm/';
    const assetUrl = new URL(wasmPaths, globalThis.location?.href ?? 'http://localhost/');
    const applicationUrl = globalThis.location ? new URL(globalThis.location.href) : undefined;
    if (!['http:', 'https:', 'chrome-extension:', 'moz-extension:', 'safari-web-extension:', 'webkit-extension:'].includes(assetUrl.protocol) ||
        (applicationUrl && (assetUrl.protocol !== applicationUrl.protocol || assetUrl.host !== applicationUrl.host)) ||
        (!applicationUrl && /^[a-z][a-z0-9+.-]*:|^\/\//i.test(wasmPaths))) {
      throw new Error('ORT assets must be bundled at a local application URL');
    }
    const configure = (module: typeof Ort) => {
      module.env.wasm.wasmPaths = wasmPaths;
      module.env.wasm.numThreads = 1;
      module.env.wasm.proxy = false;
    };
    configure(ort);
    const bytes = await loadArtifact(backend === 'webgpu' ? 'model_fp16.onnx' : 'model_int8.onnx', this.cacheOptions());
    this.emit({ state: 'loading' });
    const sessionOptions: Ort.InferenceSession.SessionOptions = { executionProviders: [backend], preferredOutputLocation: 'cpu' };
    let session: Ort.InferenceSession;
    try {
      // The WebGPU build also provides WASM. Reuse its heap on ordinary GPU
      // graph/device failure rather than allocating a second retained WASM heap.
      session = await ort.InferenceSession.create(bytes, sessionOptions);
    } catch (error) {
      if (backend !== 'wasm' || ort !== this.gpuOrt || toPiiError(error, 'MODEL_LOAD_FAILED').code === 'OUT_OF_MEMORY') throw error;
      // A failed global JSEP initializer cannot be reused; plain WASM is the
      // last resort. Reuse the verified bytes instead of downloading again.
      ort = await import('onnxruntime-web/wasm');
      this.gpuOrt = undefined;
      configure(ort);
      session = await ort.InferenceSession.create(bytes, sessionOptions);
    }
    if (!session.inputNames.includes('input_ids') || !session.inputNames.includes('attention_mask') ||
        session.inputNames.length !== 2 || !session.outputNames.includes('logits')) {
      await session.release();
      throw new Error('Unexpected ONNX model inputs/outputs');
    }
    this.ort = ort;
    this.session = session;
    this.selectedBackend = backend;
  }
  private async releaseSession(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    this.ort = undefined;
    if (session) await session.release().catch(() => undefined);
  }
  async infer(input: TokenizedInput): Promise<ModelOutput> {
    this.validateInput(input);
    const snapshot: TokenizedInput = {
      ids: [...input.ids], attentionMask: [...input.attentionMask],
      offsets: input.offsets.map(([start, end]) => [start, end]), specialTokensMask: [...input.specialTokensMask],
    };
    await this.initialize();
    return this.serialized(async () => {
      if (!this.session) throw new PiiError('MODEL_NOT_READY', 'Runtime was disposed');
      try {
        try { return await this.run(snapshot); }
        catch (error) {
          if (this.selectedBackend !== 'webgpu') throw error;
          await this.releaseSession();
          await this.createSession('wasm');
          this.emit({ state: 'ready', backend: 'wasm' });
          return await this.run(snapshot);
        }
      } catch (error) {
        const classified = toPiiError(error, 'INFERENCE_FAILED');
        // A failed session may be poisoned; the next request can initialize anew.
        await this.releaseSession();
        this.emit({ state: 'error', message: classified.message });
        throw classified;
      }
    });
  }
  private validateInput(input: TokenizedInput): void {
    if (!input || !Array.isArray(input.ids) || !Array.isArray(input.attentionMask) ||
        !Array.isArray(input.offsets) || !Array.isArray(input.specialTokensMask)) {
      throw new PiiError('INVALID_INPUT', 'Expected aligned token arrays');
    }
    const length = input?.ids?.length;
    if (!length || length > MODEL_CONFIG.maxSequenceLength ||
        input.attentionMask.length !== length || input.offsets.length !== length || input.specialTokensMask.length !== length) {
      throw new PiiError('INVALID_INPUT', 'Invalid aligned token input or sequence length');
    }
    for (let i = 0; i < length; i++) {
      const id = input.ids[i];
      const offset = input.offsets[i];
      const attention = input.attentionMask[i];
      const special = input.specialTokensMask[i];
      if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= 50000 ||
          (attention !== 0 && attention !== 1) || (special !== 0 && special !== 1) ||
          !Array.isArray(offset) || offset.length !== 2 || !Number.isSafeInteger(offset[0]) ||
          !Number.isSafeInteger(offset[1]) || offset[0] < 0 || offset[1] < offset[0]) {
        throw new PiiError('INVALID_INPUT', 'Invalid token ID, mask or UTF-16 offset');
      }
    }
  }
  private async run(input: TokenizedInput): Promise<ModelOutput> {
    const ort = this.ort!;
    const shape: [number, number] = [1, input.ids.length];
    const ids = new ort.Tensor('int64', BigInt64Array.from(input.ids, BigInt), shape);
    const attention = new ort.Tensor('int64', BigInt64Array.from(input.attentionMask, BigInt), shape);
    let outputs: Record<string, Ort.Tensor> | undefined;
    try {
      outputs = await this.session!.run({ input_ids: ids, attention_mask: attention });
      const logits = outputs.logits;
      if (!logits || logits.dims.length !== 3 || logits.dims[0] !== 1 ||
          logits.dims[1] !== shape[1] || logits.dims[2] !== MODEL_CONFIG.labelCount) {
        throw new Error('Invalid ONNX logits tensor');
      }
      const data = logits.location && logits.location !== 'cpu' ? await logits.getData() : logits.data;
      if (!ArrayBuffer.isView(data) || !('length' in data) || data.length !== shape[1] * MODEL_CONFIG.labelCount) {
        throw new Error('Invalid ONNX logits storage length');
      }
      let values: Float32Array;
      if (logits.type === 'float32' && data instanceof Float32Array) values = Float32Array.from(data);
      else if (logits.type === 'float16' && (data instanceof Uint16Array || Object.prototype.toString.call(data) === '[object Float16Array]')) {
        // ORT 1.30 exposes binary16 as Uint16Array, or native Float16Array on
        // newer engines. Interpret bits, not Uint16 numeric values.
        const view = data as Uint16Array;
        const bits = new Uint16Array(view.buffer, view.byteOffset, view.byteLength / 2);
        values = new Float32Array(bits.length);
        for (let i = 0; i < bits.length; i++) {
          const bitPattern = bits[i]!; // Dense typed array, bounded by its length.
          const sign = bitPattern & 0x8000 ? -1 : 1;
          const exponent = (bitPattern >>> 10) & 31;
          const fraction = bitPattern & 1023;
          values[i] = exponent === 0 ? sign * fraction * 2 ** -24 :
            exponent === 31 ? (fraction ? NaN : sign * Infinity) : sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
        }
      } else throw new Error('Unsupported ONNX logits storage');
      if (values.length !== shape[1] * MODEL_CONFIG.labelCount || values.some(value => !Number.isFinite(value))) throw new Error('Invalid ONNX logits values');
      return { logits: values, dims: [...logits.dims] };
    } finally {
      ids.dispose(); attention.dispose();
      if (outputs) for (const tensor of Object.values(outputs)) tensor.dispose();
    }
  }
  dispose(): Promise<void> {
    return this.serialized(async () => {
      await this.releaseSession();
      this.tokenizerInstance = undefined;
      this.labelMap = undefined;
      this.selectedBackend = 'wasm';
      this.emit({ state: 'idle' });
    });
  }
}
