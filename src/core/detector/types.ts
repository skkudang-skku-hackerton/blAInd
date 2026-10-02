import type { PiiDetectorStatus } from '../api/types';

export interface TokenizedInput {
  ids: number[];
  attentionMask: number[];
  /** Original UTF-16 positions; special tokens use [0, 0]. */
  offsets: [number, number][];
  specialTokensMask: number[];
}
export interface ModelOutput {
  logits: Float32Array;
  dims: readonly number[];
}
export interface DetectorTokenizer {
  encode(text: string, addSpecialTokens?: boolean): TokenizedInput;
  /** Wrap a slice of pre-tokenized content with the model's special tokens. */
  prepare(input: TokenizedInput): TokenizedInput;
}
export interface InferenceRuntime {
  initialize(): Promise<void>;
  infer(input: TokenizedInput): Promise<ModelOutput>;
  backend(): 'webgpu' | 'wasm';
  tokenizer(): DetectorTokenizer;
  labels(): Readonly<Record<string, string>>;
  onStatus?(listener: (status: PiiDetectorStatus) => void): () => void;
  dispose?(): Promise<void>;
}
