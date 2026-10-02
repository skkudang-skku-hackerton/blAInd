import type { PiiDetectorApi } from '../../api/pii-detector';
import { PiiError, toPiiError } from '../../api/errors';
import type { Detection, PiiDetectorStatus, ScanOptions, SegmentDetectionResult, TextSegment } from '../../api/types';
import type { InferenceRuntime } from '../types';
import { KoPiiRuntime } from './runtime';
import { chunkTokens, validateTokenizedInput } from './chunker';
import { decodeBio, type ChunkDetection } from './postprocess';
import { deduplicateDetections } from './dedup';

interface ScanRequest {
  /** Identity belongs to the invocation, never to its (possibly reused) signal. */
  id: symbol;
  cancelled: boolean;
  cancellation: Promise<void>;
}

interface ScanJob { request: ScanRequest; run(): Promise<void> }

export class KoPiiDetector implements PiiDetectorApi {
  private initialization?: Promise<void>;
  private pending: ScanJob[] = [];
  private running = false;

  constructor(private readonly runtime: InferenceRuntime = new KoPiiRuntime()) {}

  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = Promise.resolve().then(() => this.runtime.initialize()).catch((error: unknown) => {
        this.initialization = undefined;
        throw toPiiError(error, 'MODEL_LOAD_FAILED');
      });
    }
    return this.initialization;
  }

  onStatus(listener: (status: PiiDetectorStatus) => void): () => void {
    return this.runtime.onStatus?.(listener) ?? (() => {});
  }

  scanText(text: string, options?: ScanOptions): Promise<Detection[]> {
    return this.submit(options, (request) => {
      if (typeof text !== 'string') throw new PiiError('INVALID_INPUT', 'Text must be a string');
      return () => this.scan(text, request);
    });
  }

  scanSegments(segments: TextSegment[], options?: ScanOptions): Promise<SegmentDetectionResult[]> {
    return this.submit(options, (request) => {
      if (!Array.isArray(segments)) throw new PiiError('INVALID_INPUT', 'Segments must be an array');
      // Snapshot and validate the entire batch before starting inference.
      const snapshot: TextSegment[] = [];
      for (const segment of segments) {
        this.checkCancellation(request);
        if (!segment || typeof segment.id !== 'string' || typeof segment.text !== 'string') {
          throw new PiiError('INVALID_INPUT', 'Each segment must have string id and text fields');
        }
        snapshot.push({ id: segment.id, text: segment.text });
      }
      return async () => {
        await this.ready(request);
        const results: SegmentDetectionResult[] = [];
        for (const [index, segment] of snapshot.entries()) {
          if (index > 0) await this.yieldForCancellation(request);
          this.checkCancellation(request);
          results.push({ segmentId: segment.id, detections: await this.scan(segment.text, request) });
        }
        return results;
      };
    });
  }

  private submit<T>(options: ScanOptions | undefined, prepare: (request: ScanRequest) => () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let notifyCancellation!: () => void;
      const request: ScanRequest = {
        id: Symbol('PII scan'), cancelled: false,
        cancellation: new Promise<void>((notify) => { notifyCancellation = notify; }),
      };
      const signal = options?.signal;
      let settled = false;
      let listening = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        if (listening) signal?.removeEventListener('abort', abort);
        settle();
      };
      const abort = () => {
        if (settled) return;
        request.cancelled = true;
        notifyCancellation();
        // Release queued payloads immediately; active inference retains its slot.
        this.pending = this.pending.filter((item) => item.request.id !== request.id);
        finish(() => reject(new PiiError('CANCELLED', 'Scan was cancelled')));
      };
      if (signal?.aborted) { abort(); return; }
      if (signal) {
        listening = true;
        signal.addEventListener('abort', abort, { once: true });
      }
      // Close the check/listener-registration race before validating or dispatching.
      if (signal?.aborted) abort();
      if (settled) return;
      try {
        const task = prepare(request);
        if (signal?.aborted) abort();
        if (settled) return;
        const job: ScanJob = { request, run: async () => {
          try {
            this.checkCancellation(request);
            const result = await task();
            this.checkCancellation(request);
            finish(() => resolve(result));
          } catch (error) {
            finish(() => reject(error));
          }
        } };
        this.pending.push(job);
        this.startNext();
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  private startNext(): void {
    if (this.running) return;
    const job = this.pending.shift();
    if (!job) return;
    this.running = true;
    void job.run().finally(() => {
      this.running = false;
      this.startNext();
    });
  }

  private checkCancellation(request: ScanRequest): void {
    if (request.cancelled) throw new PiiError('CANCELLED', 'Scan was cancelled');
  }

  private async ready(request: ScanRequest): Promise<void> {
    this.checkCancellation(request);
    // Cancellation ends this wait, not the shared initialization operation.
    await Promise.race([this.initialize(), request.cancellation]);
    this.checkCancellation(request);
  }

  private async yieldForCancellation(request: ScanRequest): Promise<void> {
    this.checkCancellation(request);
    // A microtask-only yield cannot deliver a worker's cancellation message.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    this.checkCancellation(request);
  }

  private async scan(text: string, request: ScanRequest): Promise<Detection[]> {
    await this.ready(request);
    if (text.length === 0) return [];
    try {
      const tokenizer = this.runtime.tokenizer();
      const content = tokenizer.encode(text, false);
      this.checkCancellation(request);
      validateTokenizedInput(content, text);
      const candidates: ChunkDetection[] = [];
      for (const [chunkIndex, chunk] of chunkTokens(content).entries()) {
        if (chunkIndex > 0) await this.yieldForCancellation(request);
        this.checkCancellation(request);
        const input = tokenizer.prepare(chunk.input);
        this.checkCancellation(request);
        validateTokenizedInput(input, text);
        const output = await this.runtime.infer(input);
        // Do not decode late results, including malformed results from cancelled work.
        this.checkCancellation(request);
        candidates.push(...decodeBio(output, input, this.runtime.labels(), text, { chunkIndex,
          hasPrevious: chunk.hasPrevious, hasNext: chunk.hasNext, tokenStart: chunk.tokenStart }));
      }
      this.checkCancellation(request);
      return deduplicateDetections(candidates);
    } catch (error) {
      throw toPiiError(error, 'INFERENCE_FAILED');
    }
  }
}
