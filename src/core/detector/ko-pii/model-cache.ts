import { PiiError, toPiiError } from '../../api/errors';
import { MODEL_BASE_URL, MODEL_CONFIG, type ArtifactName } from './model-config';

export interface ModelCacheOptions {
  fetch?: typeof globalThis.fetch;
  cacheStorage?: CacheStorage;
  onProgress?: (progress: number) => void;
}

export async function verifyArtifact(name: ArtifactName, bytes: Uint8Array): Promise<void> {
  const expected = MODEL_CONFIG.artifacts[name];
  if (bytes.byteLength !== expected.bytes) throw new PiiError('MODEL_DOWNLOAD_FAILED', `Invalid byte size for ${name}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== expected.sha256) throw new PiiError('MODEL_DOWNLOAD_FAILED', `SHA-256 mismatch for ${name}`);
}

async function readArtifact(response: Response, name: ArtifactName, onProgress?: (progress: number) => void): Promise<Uint8Array> {
  const expected = MODEL_CONFIG.artifacts[name].bytes;
  // Bound both cache reads and downloads; never collect/concatenate model chunks.
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== expected) throw new PiiError('MODEL_DOWNLOAD_FAILED', `Invalid artifact size ${name}`);
    return bytes;
  }
  const bytes = new Uint8Array(expected);
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.length > expected) throw new PiiError('MODEL_DOWNLOAD_FAILED', `Oversized artifact ${name}`);
      bytes.set(value, received);
      received += value.length;
      onProgress?.(received / expected);
    }
    if (received !== expected) throw new PiiError('MODEL_DOWNLOAD_FAILED', `Truncated artifact ${name}`);
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}

function artifactResponse(bytes: Uint8Array): Response {
  let offset = 0;
  // Response(Uint8Array) clones the entire ~483 MB input. A pull-based response
  // lets Cache Storage consume small views without another full JS allocation.
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + 1024 * 1024, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  }), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) } });
}

/** Cache failures are non-fatal; integrity failures never reach ONNX Runtime. */
export async function loadArtifact(name: ArtifactName, options: ModelCacheOptions = {}): Promise<Uint8Array> {
  const url = MODEL_BASE_URL + name;
  let cache: Cache | undefined;
  try {
    cache = await (options.cacheStorage ?? globalThis.caches)?.open(`ko-pii-${MODEL_CONFIG.revision}`);
    const cached = await cache?.match(url);
    if (cached) {
      try {
        const bytes = await readArtifact(cached, name);
        await verifyArtifact(name, bytes);
        options.onProgress?.(1);
        return bytes;
      } catch (error) {
        if (!(error instanceof PiiError) || error.code !== 'MODEL_DOWNLOAD_FAILED') throw error;
        await cache?.delete(url);
      }
    }
  } catch (error) {
    const classified = toPiiError(error, 'MODEL_DOWNLOAD_FAILED');
    if (classified.code === 'OUT_OF_MEMORY' || error instanceof RangeError) {
      throw new PiiError('OUT_OF_MEMORY', 'Insufficient memory to read cached model', { cause: error });
    }
    /* Private browsing, quota, or unavailable Cache Storage. */
  }
  try {
    options.onProgress?.(0);
    const response = await (options.fetch ?? globalThis.fetch)(url);
    if (!response.ok) throw new Error(`Download ${name} failed: HTTP ${response.status}`);
    const bytes = await readArtifact(response, name, options.onProgress);
    await verifyArtifact(name, bytes);
    try { if (cache) await cache.put(url, artifactResponse(bytes)); }
    catch { /* A verified model remains usable if persistence fails. */ }
    options.onProgress?.(1);
    return bytes;
  } catch (error) {
    if (error instanceof RangeError) throw new PiiError('OUT_OF_MEMORY', 'Insufficient memory to load model artifact', { cause: error });
    throw toPiiError(error, 'MODEL_DOWNLOAD_FAILED');
  }
}

export async function loadMetadata(name: 'config.json' | 'tokenizer.json' | 'tokenizer_config.json', options?: ModelCacheOptions): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await loadArtifact(name, options)));
}
