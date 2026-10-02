# PII Detection API

This document defines the public API contract for the local PII detection module used by the browser extension.

The detector is responsible only for identifying **where PII exists in text**.

It does **not** modify, mask, redact, highlight, or rewrite the original content.

---

## 1. Responsibility

The detector answers:

> "Which spans in this text contain personally identifiable information?"

It does not answer:

> "How should this information be masked or rendered?"

Responsibility boundary:

```text
Document module
  └─ knows where text came from

PII detector
  └─ knows which character spans are PII

Caller / UI / document rewrite module
  └─ decides what to do with those spans
```

---

## 2. Public API

The public client exposes three primary operations:

```ts
await detector.initialize();

const detections =
  await detector.scanText(text);

const results =
  await detector.scanSegments(segments);
```

Interface:

```ts
export interface PiiDetectorApi {
  initialize(): Promise<void>;

  scanText(
    text: string,
    options?: ScanOptions
  ): Promise<Detection[]>;

  scanSegments(
    segments: TextSegment[],
    options?: ScanOptions
  ): Promise<SegmentDetectionResult[]>;
}

export interface ScanOptions {
  signal?: AbortSignal;
}
```

---

## 3. Initialization

```ts
await detector.initialize();
```

`initialize()` prepares the local inference runtime.

Implementation details such as:

- model download
- model cache
- tokenizer initialization
- ONNX session creation
- WebGPU / WASM backend selection

are internal and must not be depended on by callers.

### Expected behavior

- Calling `initialize()` more than once should be safe.
- Calls made before initialization may either:
  - await initialization internally, or
  - throw `MODEL_NOT_READY`

The final implementation should use one behavior consistently.

---

## 4. `scanText`

```ts
scanText(
  text: string,
  options?: ScanOptions
): Promise<Detection[]>;
```

Scans one plain text string and returns all detected PII spans.

Example:

```ts
const result = await detector.scanText(
  "김민수의 전화번호는 010-1234-5678입니다."
);
```

Example result:

```ts
[
  {
    type: "PERSON",
    confidence: 0.98,
    span: {
      start: 0,
      end: 3
    }
  },
  {
    type: "PHONE",
    confidence: 0.99,
    span: {
      start: 11,
      end: 24
    }
  }
]
```

### Important

If the input exceeds the model's maximum sequence length, the detector automatically performs internal chunking.

Callers must not manually chunk text for model-length reasons.

---

## 5. `scanSegments`

```ts
scanSegments(
  segments: TextSegment[],
  options?: ScanOptions
): Promise<SegmentDetectionResult[]>;
```

Used when another module has already divided a structured document into logical text units.

Typical use cases:

- PDF pages
- DOCX paragraphs
- HWPX paragraphs
- HTML blocks
- OCR regions

Example:

```ts
const segments = [
  {
    id: "page-1",
    text: "문서 첫 페이지 내용..."
  },
  {
    id: "page-2",
    text: "김민수의 전화번호는 010-1234-5678입니다."
  }
];

const result =
  await detector.scanSegments(segments);
```

Example result:

```ts
[
  {
    segmentId: "page-1",
    detections: []
  },
  {
    segmentId: "page-2",
    detections: [
      {
        type: "PERSON",
        confidence: 0.98,
        span: {
          start: 0,
          end: 3
        }
      },
      {
        type: "PHONE",
        confidence: 0.99,
        span: {
          start: 11,
          end: 24
        }
      }
    ]
  }
]
```

---

## 6. `TextSegment`

```ts
export interface TextSegment {
  id: string;
  text: string;
}
```

### `id`

Opaque identifier assigned by the caller.

The detector does not interpret its contents.

Examples:

```text
page-1
page-2
paragraph-14
section-3-paragraph-7
ocr-block-22
```

The same `id` is returned in `SegmentDetectionResult.segmentId`.

### `text`

Plain text that should be inspected for PII.

The detector is unaware of the original file format.

---

## 7. `Detection`

```ts
export interface DetectionConstituent {
  type: PiiType;

  confidence: number;

  span: {
    start: number;
    end: number;
  };
}

export interface Detection extends DetectionConstituent {
  constituents?: DetectionConstituent[];
}
```

---

## 8. Span semantics

`span.start` and `span.end` refer to character offsets within the exact string passed to the detector.

The interval is:

```text
[start, end)
```

That means:

- `start` is inclusive
- `end` is exclusive

Example:

```ts
const text = "김민수입니다.";

text.slice(0, 3);
// "김민수"
```

Detection:

```ts
{
  type: "PERSON",
  span: {
    start: 0,
    end: 3
  }
}
```

Callers should use:

```ts
text.slice(
  detection.span.start,
  detection.span.end
);
```

to recover the detected substring.

---

## 9. Offset guarantees

The detector guarantees that returned spans are relative to the original `TextSegment.text`, even if internal chunking occurs.

Example:

```text
Original segment
chars 0 ───────────────────────────── 5000
```

Internally:

```text
chunk A: 0..1800
chunk B: 1600..3400
chunk C: 3200..5000
```

If the model finds a PII entity inside chunk B, the detector converts the chunk-local offset back to the original segment-relative offset before returning it.

The caller must never receive chunk-local coordinates.

---

## 10. Document segmentation vs model chunking

These are intentionally separate concepts.

### Document segmentation

Handled by document modules.

Examples:

```text
PDF  -> page
DOCX -> paragraph
HWPX -> paragraph
```

Produces:

```ts
TextSegment[]
```

### Model chunking

Handled internally by the detector.

Purpose:

- respect model token limits
- preserve entity detection near chunk boundaries
- merge duplicate detections from overlapping chunks

Document modules must not implement model-length chunking.

---

## 11. `SegmentDetectionResult`

```ts
export interface SegmentDetectionResult {
  segmentId: string;
  detections: Detection[];
}
```

The caller can use `segmentId` to map detections back to the original document structure.

Example:

```ts
const mapping = {
  "page-1": {
    pageNumber: 1
  },
  "page-2": {
    pageNumber: 2
  }
};
```

The detector itself does not know or require this mapping.

---

## 12. PII types

Initial supported categories:

```ts
export type PiiType =
  | "PERSON"
  | "RRN"
  | "FRN"
  | "CARD_NUMBER"
  | "ACCOUNT_NUMBER"
  | "SECRET"
  | "USER_ID"
  | "EMAIL"
  | "PHONE"
  | "PASSPORT"
  | "DRIVER_LICENSE"
  | "GENERIC_ID"
  | "ADDRESS"
  | "ZIPCODE"
  | "DATE"
  | "CARD_EXPIRY"
  | "CVC"
  | "IPIN";
```

The enum may be extended later.

Callers should avoid exhaustive logic that assumes no future categories will be added.

---

## 13. Confidence

```ts
confidence: number
```

Range:

```text
0.0 <= confidence <= 1.0
```

Interpretation:

- higher values indicate stronger model confidence
- confidence is advisory, not a guarantee of correctness

The exact aggregation method used for multi-token entities is an implementation detail.

Callers should not depend on how the confidence score is calculated internally.

---

## 14. Multiple detections

A single input may return multiple detections.

Example:

```text
김민수
010-1234-5678
minsu@example.com
```

may produce:

```ts
[
  {
    type: "PERSON",
    ...
  },
  {
    type: "PHONE",
    ...
  },
  {
    type: "EMAIL",
    ...
  }
]
```

The detector is designed to detect multiple entity types in one inference workflow.

---

## 15. Overlapping chunk deduplication

The detector may use overlapping chunks internally.

Therefore the same entity may temporarily be detected multiple times.

The detector is responsible for merging or deduplicating such duplicates before returning the final result.

Callers should not need to remove duplicate detections created by internal chunking.

### Non-overlapping regions without losing coverage

`scanText()` and each `scanSegments()` result return regions sorted by start offset.
Top-level spans do not overlap; adjacent spans remain separate. Reconciliation
preserves the union of all detected characters, including the extra boundaries of
near-duplicates. It must not suppress a conflicting prediction and lose its coverage.

Remaining overlapping detections form one region spanning their union. Such a
region includes `constituents`, retaining the reconciled detections' individual
types, confidence scores, and original UTF-16 spans. Constituents can overlap;
they have no nested `constituents`. The outer type/confidence identify a preferred
representative (complete before clipped, then confidence, length, and stable
tie-breakers), rather than classifying every character of the merged region.

For example, PHONE `[0,5)` and PERSON `[3,10)` become one region `[0,10)` with
both detections as constituents. A caller may highlight the outer region, but
must expand constituents before applying type policies or asking for user choices:

```ts
import { expandDetections } from '../src/core/api';

const regions = await detector.scanText(text);
const policyItems = expandDetections(regions);
// Classify/select policyItems first; mask only the union of selected item spans.
```

Masking PHONE automatically must not also mask the PERSON-only suffix `[5,10)`
unless the user selects that PERSON item. Text analysis and document review
expand constituents before making these policy decisions. RPC preserves and
validates the metadata and its union coverage.

---

## 16. What the detector does not provide

The detector does not return:

```text
maskedText
redactedText
replacementText
highlight markup
PDF coordinates
DOCX run indexes
HWPX XML paths
UI components
```

These belong to higher-level modules.

---

## 17. PDF integration example

PDF module:

```ts
const segments: TextSegment[] = [
  {
    id: "page-1",
    text: page1Text
  },
  {
    id: "page-2",
    text: page2Text
  }
];

const results =
  await detector.scanSegments(segments);
```

The PDF module should separately maintain any page/text-item/bounding-box mapping required for visual redaction.

Example responsibility:

```text
PDF.js
  ↓
page text
  ↓
TextSegment
  ↓
PII detector
  ↓
span offsets
  ↓
PDF module maps spans back to page/text items
```

---

## 18. DOCX integration example

DOCX module:

```ts
const segments: TextSegment[] =
  paragraphs.map((text, index) => ({
    id: `paragraph-${index}`,
    text
  }));

const results =
  await detector.scanSegments(segments);
```

The DOCX module is responsible for mapping paragraph-relative character offsets back to OOXML runs if rewriting is required.

---

## 19. HWPX integration example

Same contract:

```ts
const segments: TextSegment[] =
  hwpxParagraphs.map((paragraph, index) => ({
    id: `paragraph-${index}`,
    text: paragraph.text
  }));

const results =
  await detector.scanSegments(segments);
```

HWPX XML mapping remains the responsibility of the HWPX module.

---

## 20. ChatGPT / site integration example

For a plain text composer:

```ts
const text = getComposerText();

const detections =
  await detector.scanText(text);
```

The site module decides whether to:

- show a warning
- highlight detected spans
- prevent submission
- replace text
- allow submission

The detector does not perform these actions.

---

## 21. Error contract

```ts
export type PiiErrorCode =
  | "MODEL_NOT_READY"
  | "MODEL_DOWNLOAD_FAILED"
  | "MODEL_LOAD_FAILED"
  | "INFERENCE_FAILED"
  | "OUT_OF_MEMORY"
  | "INVALID_INPUT"
  | "CANCELLED";
```

Recommended error shape:

```ts
export interface PiiDetectorError {
  code: PiiErrorCode;
  message: string;
  cause?: unknown;
}
```

Callers should branch on `code`, not on raw ONNX/runtime error strings.

Cancellation rejects the affected scan with `code: "CANCELLED"`; it must not return an empty or partial detection result. An empty result means the scan completed without finding PII, not that it was cancelled.

---

## 22. Runtime status

Optional status API:

```ts
export type PiiDetectorStatus =
  | {
      state: "idle";
    }
  | {
      state: "downloading";
      progress: number;
    }
  | {
      state: "loading";
    }
  | {
      state: "ready";
      backend: "webgpu" | "wasm";
    }
  | {
      state: "error";
      message: string;
    };
```

Example:

```ts
detector.onStatus?.((status) => {
  // UI may display download/load state.
});
```

This API is optional and should not affect the core scanning contract.

---

## 23. Backend transparency

Callers must not depend on whether inference runs using:

```text
WebGPU
WASM
ONNX Runtime Web
Transformers.js
```

These are implementation details.

The same public API must work regardless of backend.

---

## 24. Threading / extension architecture

The detector may run inside:

```text
content script
    ↓
extension messaging
    ↓
offscreen document
    ↓
Web Worker
    ↓
ONNX runtime
```

Callers must only use the public client wrapper.

They should not communicate directly with the inference worker.

### Request-scoped cancellation

`scanText` and `scanSegments` accept an optional second argument:

```ts
export interface ScanOptions {
  signal?: AbortSignal;
}
```

Existing calls remain valid without any changes. `initialize()` remains unchanged; cancellation of one scan must not cancel shared initialization or unload the model.

Use a separate `AbortController` for each independently cancellable scan:

```ts
const controller = new AbortController();

const pending = detector.scanSegments(segments, {
  signal: controller.signal
});

// Attach an error handler before cancellation can occur.
const handled = pending.catch((error: PiiDetectorError) => {
  if (error.code === "CANCELLED") return null;
  throw error;
});

controller.abort();
const results = await handled;
```

Document processors can forward the signal already supplied by the file uploader:

```ts
const results = await detector.scanSegments(segments, { signal });
```

They must still check `signal.aborted` before rewriting or returning a file: the request can be cancelled after detection has completed. The processor should translate `CANCELLED` into its existing `null` result rather than uploading the original file.

#### Required behavior

- Each scan invocation has its own internal request ID, even when no signal is provided.
- Aborting a signal cancels only scans associated with that signal. Other requests continue normally. Reusing one signal intentionally cancels all scans using it.
- An already-aborted signal rejects with `CANCELLED` without queuing inference work.
- Cancellation while waiting for shared initialization rejects the scan promptly, but initialization continues for other callers.
- A queued scan is removed or marked cancelled so it is never executed.
- An active scan rejects promptly, skips remaining chunks/segments, and discards late results. The caller must not receive a partially completed result.
- Once a promise has settled, later cancellation does not change its result.
- Abort listeners and per-request state are released on success, failure, or cancellation.

Cancellation does not guarantee immediate interruption of an ONNX operation already running. If the backend cannot interrupt it, that operation may finish, but its result is discarded and no further work for the cancelled request is scheduled. Do not terminate a shared worker or reset a shared session to cancel one request.

#### Extension messaging

`AbortSignal` stays in the public client wrapper; it must not be sent through extension messaging. The wrapper assigns a unique request ID and forwards cancellation using an internal message such as:

```ts
type CancelScanMessage = {
  type: "PII_CANCEL_SCAN";
  requestId: string;
};
```

The transport must correlate scan requests, responses, and cancellation with that same ID, scoped to the originating client. Cancellation may affect only a request owned by that client. Unknown or completed request IDs are safe no-ops. The client must ignore late responses for cancelled requests.

The wrapper registers cancellation before dispatching a scan and rechecks the signal to avoid missing an abort during setup. The transport must preserve scan-before-cancel ordering per request, or retain cancellation state until a racing scan has been rejected; a cancellation message must not be lost merely because the scan has not yet been queued.

The detector runtime and public client implementation exist in this repository (`src/core/detector/ko-pii/` and `src/shared/messaging/pii-client.ts`). These behaviors are implemented and covered by the unit tests and the opt-in browser tests in `tests/`.

Minimum implementation tests:

- Existing one-argument calls still complete normally.
- With two concurrent scans, cancelling one does not cancel the other.
- Already-aborted, queued, initialization-waiting, and active requests reject with `CANCELLED`.
- Cancellation between chunks prevents subsequent chunks from running and never returns partial results.
- Late responses, repeated cancellation, and cancellation after completion are harmless.
- Aborting during request setup cannot leave an uncancelled scan queued.
- Cancellation cannot target another client's request, and listeners/request state are cleaned up.

---

## 25. Recommended caller usage

### Text

```ts
const detector = createPiiDetectorClient();

await detector.initialize();

const detections =
  await detector.scanText(text);
```

### Structured document

```ts
const segments =
  await documentModule.extractSegments(file);

const results =
  await detector.scanSegments(segments);
```

---

## 26. Minimal contract summary

The entire public contract can be summarized as:

```ts
interface PiiDetectorApi {
  initialize(): Promise<void>;

  scanText(
    text: string,
    options?: ScanOptions
  ): Promise<Detection[]>;

  scanSegments(
    segments: TextSegment[],
    options?: ScanOptions
  ): Promise<SegmentDetectionResult[]>;
}

interface ScanOptions {
  signal?: AbortSignal;
}

interface TextSegment {
  id: string;
  text: string;
}

interface DetectionConstituent {
  type: PiiType;
  confidence: number;

  span: {
    start: number;
    end: number;
  };
}

interface Detection extends DetectionConstituent {
  constituents?: DetectionConstituent[];
}

interface SegmentDetectionResult {
  segmentId: string;
  detections: Detection[];
}
```

---

## 27. Team ownership summary

### PII detector team

Owns:

```text
model loading
tokenization
ONNX inference
long-text chunking
BIO decoding
character offset restoration
overlap deduplication
confidence
WebGPU/WASM fallback
request-scoped cancellation and late-result disposal
```

### Document module team

Owns:

```text
PDF/DOCX/HWPX parsing
document segmentation
segment IDs
mapping segment offsets back to source document structure
actual document rewriting/redaction
```

### Frontend / site integration team

Owns:

```text
warnings
highlights
review UI
masking
send / allow / block interaction
```

---

## 28. Design rule

The following rule should remain true throughout development:

```text
Document module:
"Where did this text come from?"

Detector:
"Which spans in this text are PII?"

Caller:
"What should we do with those spans?"
```
