# Browser PII model verification

## Reproduce

Run from the repository root after the main-owned dependencies are installed:

```sh
npx playwright install chromium
npx playwright test --config playwright.config.ts
PII_MODEL_E2E=1 npx playwright test --config playwright.config.ts tests/e2e/pii-model.spec.ts
```

The default command discovers the tests but skips expensive execution. The opt-in
command downloads the pinned real model (INT8: 482,978,775 bytes, about 461 MiB),
loads ONNX Runtime Web in Chromium, and performs inference. No mocked runtime,
tokenizer, logits, or detections are used. Allow ten minutes per test and sufficient
RAM for model download buffers, hashing, cache copies, and the inference session.
The Vite harness listens on `127.0.0.1:4173`; that port must be free.

To exercise the built extension as well:

```sh
npm run build
PII_MODEL_E2E=1 PII_EXTENSION_E2E=1 npx playwright test --config playwright.config.ts tests/e2e/pii-extension.spec.ts
```

The extension test uses bundled Chromium's recent headless extension support,
a fresh temporary persistent profile, and `.output/chrome-mv3`. It discovers the
extension ID from its actual service-worker URL. There is no demo popup in the
product: at test time the suite bundles `createPiiDetectorClient()` from
`tests/e2e/extension-client.ts` into a throwaway page (`pii-e2e-page.html` /
`pii-e2e-client.js`) inside the copied build output, opens that extension page,
and drives the real public client as `window.piiDetector`. Requests then travel
through the application's background/offscreen/worker implementation. The test
does not replace `chrome.runtime`, inject an RPC server, or call the worker directly.
After a scan, the test closes the offscreen document, disables networking, and
initializes again; a fresh offscreen host, worker, and ONNX session must load
entirely from bundled executable assets and cached model data.

A browser `evaluate()` cannot import the application's original TypeScript from
the packaged extension: WXT bundles those modules and their dependencies. The
suite therefore bundles a separate test-only page into the build output at test
time, keeping the product tree free of demo UI while still using the real client
and the real extension transport end to end.

## Coverage

- Explicit WASM backend selection; successful real ONNX session creation.
- Repeated initialization and empty text.
- Exact `PERSON`, `PHONE`, and `EMAIL` spans in one Korean text prefixed by emoji.
- JavaScript UTF-16 `[start, end)` positions validated by exact substring matches,
  bounds, integer offsets, non-split surrogate pairs, and finite confidence in `[0, 1]`.
- Segment IDs, empty segment, and segment-relative phone positions.
- Text exceeding the model's 2048-token maximum. The real tokenizer places a
  phone across the actual default content-chunk boundary; the suite proves this
  placement and requires exactly one complete phone detection plus a late email
  with original-text offsets. Duplicate identical spans are rejected.
- Cache Storage contains an ONNX artifact. The suite disposes the live model,
  creates a fresh runtime and detector, disables all networking using Playwright,
  and requires successful cached initialization and inference. Already-loaded ORT
  executable code remains in memory. This verifies model-cache reuse in a new
  session, not launching the application or loading WASM from a cold offline tab.
- Optional actual MV3 RPC initialization, text scan, and segment scan.
- Cancellation rejects with `CANCELLED`, never an empty or partial result:
  pre-aborted `scanText` and `scanSegments` perform zero inference calls; queued
  cancellation settles promptly; active cancellation after the first real chunk
  skips later chunks/segments while a concurrent uncancelled scan succeeds. A
  subsequent recovery scan proves the shared session remains usable.
- The deterministic active probe delegates all work to the real runtime, but
  holds the first completed inference result just before returning it to the
  detector. It aborts while that result is held, requires rejection within five
  seconds, releases the result, and counts exactly three inference calls: one
  cancelled chunk, one survivor, one recovery. No token IDs or logits are replaced.
- RPC pre-aborted scans, a long segment scan cancelled after dispatch, a concurrent
  survivor, repeated abort, and a recovery segment scan. The RPC test permits
  queued or active cancellation; its 100 ms dispatch window does not establish
  which worker chunk is running. Exact between-chunk scheduling is asserted by
  the deterministic Vite probe, not claimed for the RPC timing check.

Artifacts are written outside the shared worktree to
`/tmp/opencode/pii-playwright-results`. Successful browser execution attaches
`real-model-results` (detections, chunk-boundary fixture, cache URLs), and successful
extension execution attaches `extension-rpc-results`. Cancellation probes attach
`real-model-cancellation` and `extension-rpc-cancellation`, including outcomes,
inference counts, and RPC cancellation latency.

## Integration requirements

- Runtime exports `KoPiiRuntime` and accepts `preferredBackend: 'wasm'` and
  `wasmPaths`. Vite serves ORT assets from `/node_modules/onnxruntime-web/dist/`.
- Runtime exposes `tokenizer()`, `backend()`, and `dispose()`; detector accepts the
  runtime through its constructor. Cache keys must be discoverable via Cache Storage.
- Chromium must be installed through Playwright; system Chrome is not assumed.
- The main-owned TypeScript configuration should include Playwright tests and
  browser harness files; unit-test discovery should exclude `tests/e2e`.
- Extension build must package the required WASM/module assets and permit real
  remote model fetches under its CSP. The browser suite adds its own test-only page
  to the build output at test time; no product UI is required or shipped.

## Execution record

On 2026-10-02, after rebasing onto `origin/main` and installing the tooling:

| Check | Actual result |
| --- | --- |
| `npm run typecheck` (`wxt prepare && tsc --noEmit`) | Pass; no diagnostics |
| `npm test` (Vitest + Node interceptor suites) | Pass; 127 Vitest tests across 17 files plus 35 Node tests |
| `npm run build` | Pass; Chrome MV3 bundle plus local `ort-wasm/` assets |
| `PII_MODEL_E2E=1 npm run test:e2e -- tests/e2e/pii-model.spec.ts` | Pass; real INT8 ONNX inference in Chromium WASM |
| Real spans, segments, chunk boundary, cache-backed offline session | Pass; exact `PERSON`/`PHONE`/`EMAIL` spans, boundary phone, offline cache reuse |
| `PII_MODEL_E2E=1 PII_EXTENSION_E2E=1 npm run test:e2e -- tests/e2e/pii-extension.spec.ts` | Pass; test extension page → background → offscreen → worker → real model |
| Extension RPC cancellation and cold offscreen restart offline | Pass; cancellation isolation, recovery, and offline re-initialization |

The runtime and detector contracts match the harness (`preferredBackend`,
`wasmPaths`, `tokenizer()`, `backend()`, `dispose()`). The model cache and ORT
assets are produced entirely by the build; the extension test verifies persistence
under the `ko-pii-<revision>` Cache Storage and re-initializes from cache with the
offscreen document closed and networking disabled.

WebGPU execution, mobile/browser portability, document parsing, masking, and
production performance benchmarking are outside this suite's verified coverage.

### Audit cleanup verification (2026-10-03)

After updating the audit branch to the latest `main` and installing dependencies
with `npm ci`:

| Check | Actual result |
| --- | --- |
| `npm run typecheck` | Pass; no diagnostics with alert types imported from the shared detector API |
| `npm test` (Vitest + Node interceptor suites) | Pass; 246 Vitest tests across 23 files plus 35 Node tests |
| `npm run build` | Pass; Chrome MV3 bundle plus local `ort-wasm/` assets |

The `test` script now runs both unit suites; `test:node` runs the interceptor suite
independently. Browser-model results above remain the 2026-10-02 execution record.
