import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenizerConfigFixture, tokenizerFixture } from '../tokenizer/fixture';

const mocks = vi.hoisted(() => ({ loadArtifact: vi.fn(), loadMetadata: vi.fn(), create: vi.fn(), run: vi.fn(), release: vi.fn(), env: { wasm: {} as Record<string, unknown> } }));
vi.mock('../../../src/core/detector/ko-pii/model-cache', () => ({ loadArtifact: mocks.loadArtifact, loadMetadata: mocks.loadMetadata }));
const ortFactory = () => ({
  env: mocks.env,
  InferenceSession: { create: mocks.create },
  Tensor: class {
    constructor(public type: string, public data: unknown, public dims: number[]) {}
    dispose() {}
  },
});
vi.mock('onnxruntime-web/wasm', () => ortFactory());
vi.mock('onnxruntime-web/webgpu', () => ortFactory());
import { KoPiiRuntime } from '../../../src/core/detector/ko-pii/runtime';

const types = ['PERSON', 'RRN', 'FRN', 'CARD_NUMBER', 'ACCOUNT_NUMBER', 'SECRET', 'USER_ID', 'EMAIL', 'PHONE', 'PASSPORT', 'DRIVER_LICENSE', 'GENERIC_ID', 'ADDRESS', 'ZIPCODE', 'DATE', 'CARD_EXPIRY', 'CVC', 'IPIN'];
const labels = ['O', ...types.flatMap(type => [`B-${type}`, `I-${type}`])];
const config = { id2label: Object.fromEntries(labels.map((label, id) => [id, label])), label2id: Object.fromEntries(labels.map((label, id) => [label, id])) };
const session = () => ({ inputNames: ['input_ids', 'attention_mask'], outputNames: ['logits'], run: mocks.run, release: mocks.release });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.loadMetadata.mockImplementation(async (name: string) => name === 'config.json' ? config : name === 'tokenizer.json' ? tokenizerFixture : tokenizerConfigFixture);
  mocks.loadArtifact.mockResolvedValue(new Uint8Array([1]));
  mocks.create.mockImplementation(async () => session());
  mocks.release.mockResolvedValue(undefined);
  mocks.run.mockImplementation(async (feeds: { input_ids: { dims: number[] } }) => ({ logits: {
    type: 'float32', data: new Float32Array(feeds.input_ids.dims[1]! * 37), dims: [1, feeds.input_ids.dims[1], 37], dispose: vi.fn(), // Runtime always constructs [1, sequence].
  } }));
  vi.stubGlobal('navigator', {});
});
afterEach(() => vi.unstubAllGlobals());

describe('KoPiiRuntime lifecycle and backend fallback', () => {
  it('shares concurrent initialization, uses local single-thread WASM, and returns float32 logits', async () => {
    const runtime = new KoPiiRuntime({ preferredBackend: 'wasm', wasmPaths: '/ort-wasm/' });
    const statuses: string[] = [];
    runtime.onStatus(status => statuses.push(status.state));
    await Promise.all([runtime.initialize(), runtime.initialize()]);
    await runtime.initialize();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.env.wasm).toEqual({ wasmPaths: '/ort-wasm/', numThreads: 1, proxy: false });
    expect(mocks.loadArtifact.mock.calls.map(call => call[0])).toEqual(['model_int8.onnx']);
    const output = await runtime.infer(runtime.tokenizer().encode('김민수'));
    expect(output.dims).toEqual([1, 5, 37]);
    expect(output.logits).toBeInstanceOf(Float32Array);
    expect(statuses).toEqual(['idle', 'loading', 'ready']);
    await runtime.dispose();
    await runtime.dispose();
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(() => runtime.tokenizer()).toThrow(expect.objectContaining({ code: 'MODEL_NOT_READY' }));
    await runtime.initialize();
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });
  it('does not fetch the GPU model without a shader-f16 adapter', async () => {
    vi.stubGlobal('navigator', { gpu: { requestAdapter: vi.fn().mockResolvedValue({ features: new Set() }) } });
    const runtime = new KoPiiRuntime({ preferredBackend: 'webgpu' });
    await runtime.initialize();
    expect(runtime.backend()).toBe('wasm');
    expect(mocks.loadArtifact.mock.calls.map(call => call[0])).toEqual(['model_int8.onnx']);
  });
  it('falls back after WebGPU session creation fails', async () => {
    vi.stubGlobal('navigator', { gpu: { requestAdapter: vi.fn().mockResolvedValue({ features: new Set(['shader-f16']) }) } });
    mocks.create.mockRejectedValueOnce(new Error('GPU unsupported operator'));
    const runtime = new KoPiiRuntime({ preferredBackend: 'webgpu' });
    await runtime.initialize();
    expect(runtime.backend()).toBe('wasm');
    expect(mocks.loadArtifact.mock.calls.map(call => call[0])).toEqual(['model_fp16.onnx', 'model_int8.onnx']);
  });
  it('retries failed GPU inference on WASM and releases the GPU session', async () => {
    vi.stubGlobal('navigator', { gpu: { requestAdapter: vi.fn().mockResolvedValue({ features: new Set(['shader-f16']) }) } });
    const runtime = new KoPiiRuntime({ preferredBackend: 'webgpu' });
    await runtime.initialize();
    mocks.run.mockRejectedValueOnce(new Error('GPU device lost'));
    const output = await runtime.infer(runtime.tokenizer().encode('김'));
    expect(output.dims).toEqual([1, 3, 37]);
    expect(runtime.backend()).toBe('wasm');
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });
  it('classifies initialization OOM and permits retry after rejection', async () => {
    mocks.create.mockRejectedValueOnce(new Error('allocation failed'));
    const runtime = new KoPiiRuntime();
    await expect(runtime.initialize()).rejects.toMatchObject({ code: 'OUT_OF_MEMORY' });
    await runtime.initialize();
    expect(runtime.backend()).toBe('wasm');
  });
  it('rejects invalid labels before model download', async () => {
    mocks.loadMetadata.mockResolvedValueOnce({ ...config, label2id: {} });
    await expect(new KoPiiRuntime().initialize()).rejects.toMatchObject({ code: 'MODEL_LOAD_FAILED' });
    expect(mocks.loadArtifact).not.toHaveBeenCalled();
  });
  it('rejects invalid input and malformed logits with stable classifications', async () => {
    const runtime = new KoPiiRuntime();
    await expect(runtime.infer({ ids: [-1], offsets: [[0, 1]], attentionMask: [1], specialTokensMask: [0] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(mocks.loadMetadata).not.toHaveBeenCalled();
    await runtime.initialize();
    mocks.run.mockResolvedValueOnce({ logits: { type: 'float32', data: new Float32Array(1), dims: [1, 3, 1], dispose: vi.fn() } });
    await expect(runtime.infer(runtime.tokenizer().encode('김'))).rejects.toMatchObject({ code: 'INFERENCE_FAILED' });
    // Metadata remains usable so a detector that already initialized can retry.
    await expect(runtime.infer(runtime.tokenizer().encode('김'))).resolves.toMatchObject({ dims: [1, 3, 37] });
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });
  it('serializes disposal behind in-flight inference', async () => {
    const runtime = new KoPiiRuntime();
    await runtime.initialize();
    let finish!: (output: unknown) => void;
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    mocks.run.mockImplementationOnce(() => { started(); return new Promise(resolve => { finish = resolve; }); });
    const inference = runtime.infer(runtime.tokenizer().encode('김'));
    await running;
    const disposal = runtime.dispose();
    expect(mocks.release).not.toHaveBeenCalled();
    finish({ logits: { type: 'float32', data: new Float32Array(111), dims: [1, 3, 37], dispose: vi.fn() } });
    await inference;
    await disposal;
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
  it('blocks remote executable asset URLs', async () => {
    vi.stubGlobal('location', { href: 'http://localhost:5173/', origin: 'http://localhost:5173' });
    await expect(new KoPiiRuntime({ wasmPaths: 'https://cdn.example.com/ort/' }).initialize()).rejects.toMatchObject({ code: 'MODEL_LOAD_FAILED' });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('resolves packaged WASM assets from a Firefox moz-extension worker origin', async () => {
    vi.stubGlobal('location', {
      href: 'moz-extension://blaind-id/assets/inference.worker.js',
      protocol: 'moz-extension:', origin: 'moz-extension://blaind-id',
    });
    const runtime = new KoPiiRuntime({ preferredBackend: 'wasm' });
    await runtime.initialize();
    expect(mocks.env.wasm).toEqual({
      wasmPaths: 'moz-extension://blaind-id/ort-wasm/', numThreads: 1, proxy: false,
    });
  });
  it('promotes binary16 logits exactly, including signed zero and subnormals', async () => {
    const runtime = new KoPiiRuntime();
    await runtime.initialize();
    const storage = new Uint16Array(113);
    const bits = new Uint16Array(storage.buffer, 2, 111);
    bits.set([0x0000, 0x8000, 0x0001, 0x03ff, 0x0400, 0x3c00, 0xbc00, 0x3d00, 0x7bff, 0xfbff]);
    const dispose = vi.fn();
    mocks.run.mockResolvedValueOnce({ logits: { type: 'float16', data: bits, dims: [1, 3, 37], dispose } });
    const output = await runtime.infer(runtime.tokenizer().encode('김'));
    expect(Array.from(output.logits.slice(0, 10))).toEqual([0, -0, 2 ** -24, 1023 * 2 ** -24, 2 ** -14, 1, -1, 1.25, 65504, -65504]);
    expect(Object.is(output.logits[1], -0)).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('falls back to WASM on non-finite binary16 GPU logits', async () => {
    vi.stubGlobal('navigator', { gpu: { requestAdapter: vi.fn().mockResolvedValue({ features: new Set(['shader-f16']) }) } });
    const runtime = new KoPiiRuntime({ preferredBackend: 'webgpu' });
    await runtime.initialize();
    const bits = new Uint16Array(111); bits[0] = 0x7c00;
    mocks.run.mockResolvedValueOnce({ logits: { type: 'float16', data: bits, dims: [1, 3, 37], dispose: vi.fn() } });
    await expect(runtime.infer(runtime.tokenizer().encode('김'))).resolves.toMatchObject({ dims: [1, 3, 37] });
    expect(runtime.backend()).toBe('wasm');
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });
  it('accepts native Float16Array storage when the engine provides it', async () => {
    const NativeHalf = (globalThis as unknown as { Float16Array?: new (values: number[]) => Uint16Array }).Float16Array;
    if (!NativeHalf) return;
    const runtime = new KoPiiRuntime();
    await runtime.initialize();
    const values = Array(111).fill(0); values[0] = 1.25;
    mocks.run.mockResolvedValueOnce({ logits: { type: 'float16', data: new NativeHalf(values), dims: [1, 3, 37], dispose: vi.fn() } });
    const output = await runtime.infer(runtime.tokenizer().encode('김'));
    expect(output.logits[0]).toBe(1.25);
  });
});
