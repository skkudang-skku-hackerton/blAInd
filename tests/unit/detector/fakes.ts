import { vi } from 'vitest';
import type { DetectorTokenizer, InferenceRuntime, ModelOutput, TokenizedInput } from '../../../src/core/detector/types';

export const labels = { '0': 'O', '1': 'B-PERSON', '2': 'I-PERSON', '3': 'B-PHONE', '4': 'I-PHONE' };

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Hold one inference open independently of the caller's cancellation promise. */
export function holdInference(runtime: ReturnType<typeof fakeRuntime>['runtime']) {
  const started = deferred<TokenizedInput>();
  const result = deferred<ModelOutput>();
  runtime.infer.mockImplementationOnce((input) => {
    started.resolve(input);
    return result.promise;
  });
  return { started: started.promise, result };
}

export function logitsFor(classes: number[], values: readonly [number, number] = [-2, 4]): ModelOutput {
  const logits = new Float32Array(classes.length * 5).fill(values[0]);
  classes.forEach((label, i) => { logits[i * 5 + label] = values[1]; });
  return { logits, dims: [1, classes.length, 5] };
}

export function contentInput(text: string): TokenizedInput {
  let offset = 0;
  const offsets: [number, number][] = Array.from(text, (character) => {
    const start = offset;
    offset += character.length;
    return [start, offset];
  });
  return { ids: offsets.map((_, i) => i + 10), offsets,
    attentionMask: offsets.map(() => 1), specialTokensMask: offsets.map(() => 0) };
}

export function fakeRuntime(entities: { start: number; end: number; label?: number }[] = []) {
  const tokenizer: DetectorTokenizer = {
    encode: vi.fn((text: string, special?: boolean) => {
      if (special !== false) throw new Error('Full input must be encoded without special tokens');
      return contentInput(text);
    }),
    prepare: vi.fn((input: TokenizedInput): TokenizedInput => ({
      ids: [1, ...input.ids, 2], attentionMask: [1, ...input.attentionMask, 1],
      offsets: [[0, 0], ...input.offsets, [0, 0]], specialTokensMask: [1, ...input.specialTokensMask, 1],
    })),
  };
  const runtime = {
    initialize: vi.fn(async () => {}),
    backend: () => 'wasm' as const,
    tokenizer: () => tokenizer,
    labels: () => labels,
    infer: vi.fn(async (input: TokenizedInput) => logitsFor(input.offsets.map(([start, end], i) => {
      if (input.specialTokensMask[i]) return 1; // Deliberately predict PII on specials.
      const entity = entities.find((item) => start >= item.start && end <= item.end);
      return entity ? (entity.label ?? 1) + Number(start !== entity.start) : 0;
    }))),
  } satisfies InferenceRuntime;
  return { runtime, tokenizer };
}
