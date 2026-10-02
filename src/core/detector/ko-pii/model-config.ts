/** Values copied from artifact-manifest.json at this immutable revision. */
export const MODEL_CONFIG = {
  repo: 'tasoo/ko-pii-detector-ax-tokenclf-onnx',
  revision: 'cd7e8ba4dd24dc59cf443316c712f68f2d60b3dc',
  maxSequenceLength: 2048,
  labelCount: 37,
  artifacts: {
    'config.json': { bytes: 3595, sha256: '83a34dbaf0480bafddb0c8b0c9b75faee000807caeccdadc3d6cce86e3f610aa' },
    'tokenizer.json': { bytes: 1087192, sha256: 'ebc27e68d09321174cd4a829ae1389ebfb498c171068af6755ae80341376f5f2' },
    'tokenizer_config.json': { bytes: 442, sha256: '585b5691b279bd4de970b3c7d224bacca74e6112de7436795799241f8db1ac56' },
    'model_int8.onnx': { bytes: 482978775, sha256: '62dd9d03b1ab0e9d9d38ae28f88fb5a9ab14b3de93ab7a6e2380344712e85b73' },
    'model_fp16.onnx': { bytes: 299405752, sha256: 'a9eeb594726e7899453d111c7496cf90c9315616c5599966ce972d246bfb6328' },
  },
} as const;
export type ArtifactName = keyof typeof MODEL_CONFIG.artifacts;
export const MODEL_BASE_URL = `https://huggingface.co/${MODEL_CONFIG.repo}/resolve/${MODEL_CONFIG.revision}/`;

export function validateLabels(config: unknown): Readonly<Record<string, string>> {
  const value = config as { id2label?: Record<string, string>; label2id?: Record<string, number> };
  const labels = value?.id2label;
  if (!labels || Object.keys(labels).length !== MODEL_CONFIG.labelCount || labels['0'] !== 'O') {
    throw new Error('Invalid model label configuration');
  }
  for (let id = 0; id < MODEL_CONFIG.labelCount; id++) {
    const label = labels[String(id)];
    if (typeof label !== 'string' || (id > 0 && !/^[BI]-[A-Z_]+$/.test(label)) || value.label2id?.[label] !== id) {
      throw new Error('Inconsistent model label configuration');
    }
    const previous = labels[String(id - 1)];
    if (id > 0 && (id % 2 === 1 ? !label.startsWith('B-') : !previous || label !== `I-${previous.slice(2)}`)) {
      throw new Error('Invalid BIO label pairing');
    }
  }
  return Object.freeze({ ...labels });
}
