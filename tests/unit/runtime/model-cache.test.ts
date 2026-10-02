import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadArtifact, verifyArtifact } from '../../../src/core/detector/ko-pii/model-cache';
import { MODEL_BASE_URL, MODEL_CONFIG } from '../../../src/core/detector/ko-pii/model-config';

afterEach(() => vi.restoreAllMocks());
const name = 'tokenizer_config.json';
const bytes = () => new Uint8Array(MODEL_CONFIG.artifacts[name].bytes);
const verifiedDigest = () => Uint8Array.from(MODEL_CONFIG.artifacts[name].sha256.match(/../g)!, hex => parseInt(hex, 16)).buffer;

describe('pinned artifact integrity and Cache Storage', () => {
  it('rejects real SHA-256 mismatches and wrong lengths', async () => {
    await expect(verifyArtifact(name, bytes())).rejects.toMatchObject({ code: 'MODEL_DOWNLOAD_FAILED', message: expect.stringContaining('SHA-256') });
    await expect(verifyArtifact(name, new Uint8Array(2))).rejects.toMatchObject({ code: 'MODEL_DOWNLOAD_FAILED', message: expect.stringContaining('byte size') });
  });
  it('verifies cache hits without network requests', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(verifiedDigest());
    const fetch = vi.fn();
    const match = vi.fn().mockResolvedValue(new Response(bytes()));
    const cacheStorage = { open: vi.fn().mockResolvedValue({ match }) } as unknown as CacheStorage;
    expect(await loadArtifact(name, { fetch, cacheStorage })).toEqual(bytes());
    expect(digest).toHaveBeenCalledTimes(1);
    expect(match).toHaveBeenCalledWith(MODEL_BASE_URL + name);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('evicts corrupt cache entries and stores only verified streamed downloads', async () => {
    vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(verifiedDigest());
    const cache = { match: vi.fn().mockResolvedValue(new Response(new Uint8Array(1))), delete: vi.fn(), put: vi.fn() };
    const cacheStorage = { open: vi.fn().mockResolvedValue(cache) } as unknown as CacheStorage;
    const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes().slice(0, 100)); controller.enqueue(bytes().slice(100)); controller.close();
    } })));
    const progress: number[] = [];
    await loadArtifact(name, { fetch, cacheStorage, onProgress: value => progress.push(value) });
    expect(cache.delete).toHaveBeenCalledWith(MODEL_BASE_URL + name);
    expect(fetch).toHaveBeenCalledWith(MODEL_BASE_URL + name);
    expect(cache.put).toHaveBeenCalledTimes(1);
    const stored = cache.put.mock.calls[0]![1] as Response; // Call count asserted above.
    expect(stored.headers.get('Content-Length')).toBe('442');
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(bytes());
    expect(progress).toEqual([0, 100 / 442, 1, 1]);
  });
  it('does not cache truncated, oversized or tampered downloads', async () => {
    const cache = { match: vi.fn(), put: vi.fn() };
    const cacheStorage = { open: vi.fn().mockResolvedValue(cache) } as unknown as CacheStorage;
    for (const body of [new Uint8Array(1), new Uint8Array(443), bytes()]) {
      await expect(loadArtifact(name, { cacheStorage, fetch: vi.fn().mockResolvedValue(new Response(body)) })).rejects.toMatchObject({ code: 'MODEL_DOWNLOAD_FAILED' });
    }
    expect(cache.put).not.toHaveBeenCalled();
  });
  it('uses verified downloads when Cache Storage is unavailable or quota is exceeded', async () => {
    vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(verifiedDigest());
    const fetch = vi.fn().mockImplementation(async () => new Response(bytes()));
    const unavailable = { open: vi.fn().mockRejectedValue(new Error('disabled')) } as unknown as CacheStorage;
    expect(await loadArtifact(name, { fetch, cacheStorage: unavailable })).toEqual(bytes());
    const quota = { open: vi.fn().mockResolvedValue({ match: vi.fn(), put: vi.fn().mockRejectedValue(new Error('quota')) }) } as unknown as CacheStorage;
    expect(await loadArtifact(name, { fetch, cacheStorage: quota })).toEqual(bytes());
  });
  it('does not redownload a large cached artifact after a memory failure', async () => {
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('allocation failed'));
    const cache = { match: vi.fn().mockResolvedValue(new Response(bytes())), delete: vi.fn() };
    const cacheStorage = { open: vi.fn().mockResolvedValue(cache) } as unknown as CacheStorage;
    const fetch = vi.fn();
    await expect(loadArtifact(name, { fetch, cacheStorage })).rejects.toMatchObject({ code: 'OUT_OF_MEMORY' });
    expect(cache.delete).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
