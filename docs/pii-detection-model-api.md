# PII 탐지 API

브라우저 안에서 실행되는 개인정보 탐지기의 공개 계약입니다. 탐지기는 **텍스트의 어느 구간이
개인정보인지**만 알려주며, 원문을 마스킹하거나 수정하지 않습니다.

```text
문서 모듈   "이 텍스트는 어디에서 왔는가?"     → 추출, segment 분할, 원본 위치 매핑, 재생성
탐지기      "어느 구간이 개인정보인가?"        → 모델 로딩, 토큰화, 추론, 청킹, 중복 제거, 취소
호출자/UI   "그 구간을 어떻게 처리할 것인가?"  → 확인창, 정책, 마스킹, 전송·차단
```

## 공개 API

진입점은 `src/core/api/index.ts`입니다. 호출자는 이 모듈만 사용하고 Worker나 ONNX 런타임에
직접 접근하지 않습니다.

```ts
import { createPiiDetectorClient, expandDetections, PiiError } from '../../core/api';

const detector = createPiiDetectorClient();

interface PiiDetectorClient {
  initialize(): Promise<void>;
  scanText(text: string, options?: ScanOptions): Promise<Detection[]>;
  scanSegments(segments: TextSegment[], options?: ScanOptions): Promise<SegmentDetectionResult[]>;
  onStatus(listener: (status: PiiDetectorStatus) => void): () => void;  // 구독 해제 함수 반환
  dispose(): void;
}

interface ScanOptions { signal?: AbortSignal }
```

- `initialize()`는 여러 번 호출해도 안전하고, 진행 중인 초기화를 공유합니다. 검사 함수가
  내부에서 자동으로 호출하므로 먼저 부를 필요는 없으며, 미리 호출하면 모델을 사전 로딩합니다.
- `dispose()`는 이 클라이언트의 리스너와 대기 요청만 정리합니다. 공유 모델은 유지됩니다.
  dispose 이후 호출은 `MODEL_NOT_READY`로 거부됩니다.
- 모델 다운로드·캐시, 토크나이저, 백엔드(WASM/WebGPU) 선택은 내부 구현이므로 의존하지 않습니다.

## 데이터 타입

```ts
interface TextSegment {
  id: string;    // 호출자가 정하는 불투명 ID (예: page-1, paragraph-14)
  text: string;
}

interface DetectionConstituent {
  type: PiiType;
  confidence: number;                    // 0~1, 참고값
  span: { start: number; end: number };  // [start, end), UTF-16 오프셋
}

interface Detection extends DetectionConstituent {
  constituents?: DetectionConstituent[]; // 겹친 탐지를 합친 영역일 때만 존재
}

interface SegmentDetectionResult {
  segmentId: string;                     // 입력 TextSegment.id 그대로
  detections: Detection[];
}
```

### `scanText` / `scanSegments`

- `scanText`는 채팅 입력처럼 문자열 하나를 검사합니다.
- `scanSegments`는 문서 모듈이 미리 나눈 단위(PDF 페이지, DOCX·HWPX 문단 등)를 검사하고,
  segment마다 결과를 하나씩 반환합니다. 탐지기는 segment ID의 의미를 해석하지 않습니다.

```ts
await detector.scanText('김민수의 전화번호는 010-1234-5678입니다.');
// [
//   { type: 'PERSON', confidence: 0.98, span: { start: 0, end: 3 } },
//   { type: 'PHONE',  confidence: 0.99, span: { start: 11, end: 24 } },
// ]
```

### 구간 규칙

- `span`은 탐지기에 전달한 **그 문자열** 기준의 반열린 구간 `[start, end)`이며 JavaScript
  UTF-16 코드 단위입니다. `text.slice(span.start, span.end)`가 탐지된 문자열입니다.
- 내부 청킹이 일어나도 반환 구간은 항상 원래 segment 기준입니다. 청크 내부 좌표는 노출되지 않습니다.
- 결과는 시작 위치 순으로 정렬되고, 최상위 구간끼리는 겹치지 않습니다. 맞닿은 구간은 따로 남습니다.
- `confidence`는 참고값이며 여러 토큰을 합치는 계산 방식은 구현 세부사항입니다.

### segment 분할과 모델 청킹

두 개념은 의도적으로 분리되어 있습니다.

| | 담당 | 목적 |
| --- | --- | --- |
| segment 분할 | 문서 모듈 | 문서 구조(페이지, 문단)와 결과 위치를 연결 |
| 모델 청킹 | 탐지기 | 최대 2048 토큰 제한 대응, 경계 근처 탐지 보존, 겹친 청크의 중복 제거 |

문서 모듈은 모델 길이 때문에 텍스트를 직접 나누지 않습니다.

### 겹친 탐지와 `constituents`

서로 겹치는 탐지는 합집합 구간 하나로 합쳐 반환하고, 개별 탐지는 `constituents`에
타입·신뢰도·원래 구간 그대로 보존합니다. 바깥 `type`/`confidence`는 대표값일 뿐 영역의 모든
문자를 분류한 것이 아닙니다.

예를 들어 PHONE `[0,5)`와 PERSON `[3,10)`은 `[0,10)` 영역 하나가 됩니다. 영역을 강조 표시하는
것은 괜찮지만, **정책 적용이나 사용자 선택 전에는 반드시 펼쳐야** 합니다. 그렇지 않으면 PHONE만
자동 마스킹해도 선택하지 않은 PERSON의 `[5,10)`까지 가려집니다.

```ts
const items = expandDetections(await detector.scanText(text));
// items 단위로 정책·선택을 적용하고, 선택된 구간의 합집합만 마스킹합니다.
```

## PII 유형

```ts
type PiiType =
  | 'PERSON' | 'RRN' | 'FRN' | 'CARD_NUMBER' | 'ACCOUNT_NUMBER' | 'SECRET'
  | 'USER_ID' | 'EMAIL' | 'PHONE' | 'PASSPORT' | 'DRIVER_LICENSE' | 'GENERIC_ID'
  | 'ADDRESS' | 'ZIPCODE' | 'DATE' | 'CARD_EXPIRY' | 'CVC' | 'IPIN';
```

정의는 `src/core/pii/types.ts`, 한국어 라벨과 기본 정책은 `src/core/pii/preferences.ts`에 있습니다.
유형은 늘어날 수 있으므로 모든 값을 열거하는 분기를 가정하지 않습니다.

## 오류

```ts
type PiiErrorCode =
  | 'MODEL_NOT_READY' | 'MODEL_DOWNLOAD_FAILED' | 'MODEL_LOAD_FAILED'
  | 'INFERENCE_FAILED' | 'OUT_OF_MEMORY' | 'INVALID_INPUT' | 'CANCELLED';
```

실패는 `PiiError`(`code`, `message`, `cause?`)로 거부됩니다. 런타임 오류 문자열이 아니라
`code`로 분기합니다. 빈 배열은 "검사를 마쳤고 탐지가 없음"을 뜻하며, 취소는 항상 `CANCELLED`
오류로 구분됩니다.

## 상태 구독

```ts
type PiiDetectorStatus =
  | { state: 'idle' }
  | { state: 'downloading'; progress: number }
  | { state: 'loading' }
  | { state: 'ready'; backend: 'webgpu' | 'wasm' }
  | { state: 'error'; message: string };

const unsubscribe = detector.onStatus(status => { /* 다운로드·준비 상태 표시 */ });
```

## 취소

검사마다 `AbortSignal`을 넘길 수 있습니다. signal이 없는 기존 호출도 그대로 동작합니다.

```ts
const controller = new AbortController();
try {
  const results = await detector.scanSegments(segments, { signal: controller.signal });
} catch (error) {
  if (error instanceof PiiError && error.code === 'CANCELLED') return null; // 원본을 보내지 않음
  throw error;
}
```

보장하는 동작:

- 취소는 해당 signal을 쓴 검사에만 영향을 줍니다. 동시에 진행 중인 다른 검사, 공유 초기화,
  로드된 모델은 그대로입니다.
- 이미 abort된 signal은 추론을 대기열에 넣지 않고 바로 거부됩니다.
- 대기 중이거나 초기화를 기다리던 검사는 실행되지 않고, 실행 중인 검사는 남은 청크·segment를
  건너뜁니다. 부분 결과는 절대 반환하지 않습니다.
- 이미 실행 중인 ONNX 연산은 중단되지 않을 수 있지만 그 결과는 폐기됩니다.
- 완료된 뒤의 취소, 반복 취소, 늦게 도착한 응답은 영향이 없습니다.

문서 처리기는 업로더에서 받은 signal을 그대로 전달하고, 탐지가 끝난 뒤에도 재생성·반환 직전에
`signal.aborted`를 다시 확인해 `null`을 반환해야 합니다.

## 실행 구조

```text
Content Script ─ 확장 메시지 ─▶ Background ─▶ 추론 호스트 ─▶ Web Worker ─▶ ONNX Runtime Web
                                             (Chrome: Offscreen Document,
                                              Firefox·Safari: background page)
```

`AbortSignal`은 메시지로 전달되지 않습니다. 클라이언트(`src/shared/messaging/pii-client.ts`)가
요청마다 고유 ID를 부여하고 취소 메시지를 같은 ID로 보내며, 다른 클라이언트의 요청은 취소할 수
없습니다. 탐지기 런타임은 `src/core/detector/ko-pii/`에 있습니다. 이 동작은
`tests/unit/messaging/`, `tests/unit/detector/`와 실제 모델을 쓰는 브라우저 테스트로 검증합니다.
브라우저 테스트는 비용이 커서 환경 변수를 줄 때만 실행됩니다.

```sh
PII_MODEL_E2E=1 npx playwright test tests/e2e/pii-model.spec.ts
npm run build && PII_MODEL_E2E=1 PII_EXTENSION_E2E=1 npx playwright test tests/e2e/pii-extension.spec.ts
```

## 탐지기가 제공하지 않는 것

마스킹된 텍스트, 치환 문자열, 강조 마크업, PDF 좌표, DOCX run 인덱스, HWPX XML 경로, UI.
이것들은 상위 모듈의 책임입니다. 확인창에 전달하는 데이터 형식은
[Alert 검토 데이터 명세](alert-review-api.md)를 참고하세요.
