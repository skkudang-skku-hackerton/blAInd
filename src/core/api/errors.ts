import type { PiiErrorCode } from './types';

export class PiiError extends Error {
  constructor(public readonly code: PiiErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PiiError';
  }
}

export function toPiiError(error: unknown, code: PiiErrorCode): PiiError {
  if (error instanceof PiiError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new PiiError(/out of memory|allocation failed|memory access out of bounds/i.test(message)
    ? 'OUT_OF_MEMORY' : code, message, { cause: error });
}
