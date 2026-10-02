import { KoPiiDetector } from '../../src/core/detector/ko-pii/detector';
import type { InferenceRuntime } from '../../src/core/detector/types';

export async function outcome<T>(promise: Promise<T>) {
  return promise.then(
    value => ({ status: 'fulfilled' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const,
      code: (error as { code?: string })?.code, message: String(error) }),
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function promptly<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Cancellation did not settle within 5 seconds')), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Observe/gate real inference results, without replacing tokenizer or logits. */
export async function cancellationChecks(runtime: InferenceRuntime, longText: string, shortText: string) {
  let calls = 0;
  let gateFirst = false;
  const firstChunk = deferred();
  const releaseChunk = deferred();
  const observed: InferenceRuntime = {
    initialize: () => runtime.initialize(),
    tokenizer: () => runtime.tokenizer(),
    labels: () => runtime.labels(),
    backend: () => runtime.backend(),
    async infer(input) {
      calls++;
      const output = await runtime.infer(input);
      if (gateFirst) {
        gateFirst = false;
        firstChunk.resolve();
        await releaseChunk.promise;
      }
      return output;
    },
  };
  const detector = new KoPiiDetector(observed);
  const pre = new AbortController();
  pre.abort();
  const preText = await outcome(detector.scanText(shortText, { signal: pre.signal }));
  const preSegments = await outcome(detector.scanSegments([{ id: 'pre', text: shortText }], { signal: pre.signal }));
  const preCalls = calls;

  // Hold the first REAL inference result at its return boundary. This provides
  // deterministic active/queued cancellation without relying on CPU timing.
  gateFirst = true;
  const activeController = new AbortController();
  const queuedController = new AbortController();
  const active = outcome(detector.scanSegments([
    { id: 'long', text: longText }, { id: 'never-run', text: shortText },
  ], { signal: activeController.signal }));
  const queued = outcome(detector.scanText(longText, { signal: queuedController.signal }));
  const survivor = outcome(detector.scanText(shortText));
  try {
    await Promise.race([firstChunk.promise, active.then(result => {
      throw new Error(`Active scan settled before producing its first real chunk: ${JSON.stringify(result)}`);
    })]);
    queuedController.abort();
    queuedController.abort();
    const queuedResult = await promptly(queued);
    activeController.abort();
    const activeResult = await promptly(active);
    const callsBeforeRelease = calls;
    releaseChunk.resolve();
    const survivorResult = await survivor;
    // A late/repeated abort cannot change a settled outcome or poison a session.
    activeController.abort();
    const recovery = await outcome(detector.scanText(shortText));
    return { preText, preSegments, preCalls, queuedResult, activeResult,
      callsBeforeRelease, totalCalls: calls, survivorResult, recovery };
  } finally {
    releaseChunk.resolve();
    activeController.abort();
    queuedController.abort();
    await Promise.all([active, queued, survivor]);
  }
}
