# Claude 파일 업로드 처리

`claude.ai`에서 사용자가 파일을 첨부할 때, 원본이 전송되기 전에 붙잡아 **파일 종류를
분류한 뒤 알맞은 문서 모듈(pdf/docx/hwpx)에 넘기고, 돌아온 파일을 첨부**하는 사이트 모듈이다.

## 대상 사이트

- URL: `https://claude.ai/`
- 프레임워크: React(Next.js) 계열 — DOM 이벤트 위임 구조
- 업로드 흐름: `.../conversations/{conv}/wiggle/upload-file` 로의 **단일 multipart POST**.
  HAR로 확인 완료(HAR 확인 섹션 참고).

## 책임 경계

이 모듈은 **코어를 모른다.** 개인정보 검사·승인·수정은 문서 모듈이 코어와 통신해 처리한다.

```
[사이트 모듈]  파일 가로채기 → classifyFile() → DocumentProcessor 호출 → 돌아온 File 첨부
     │                                              ▲
     │                                              │
     └────────────── File / File | null ────────────┘
                       [문서 모듈: pdf / docx / hwpx]
                              │
                              ▼
                         [코어: 검사·마스킹·재생성]
```

- 사이트 모듈이 아는 것: `DocumentKind`, `DocumentProcessor` 시그니처
- 사이트 모듈이 모르는 것: 검사 API, 승인 상태, PII 타입, 마스킹 방식

## 동작 흐름

```
input change / drop / paste (capture)
  → stopImmediatePropagation 으로 페이지 업로드 차단 + input.value 초기화
  → 각 파일 classifyFile() 로 종류 판별
  → 해당 DocumentProcessor(file, signal) 호출
      ├─ File 반환  → 그 파일로 첨부 재주입 (change/drop 재발행)
      └─ null 반환  → 취소/처리 불가/오류 → 묶음 전체 보류(첨부 안 함)
```

## 문서 모듈이 구현할 인터페이스

```ts
export type DocumentProcessor = (file: File, signal: AbortSignal) => Promise<File | null>;

export type DocumentProcessorRegistry = Partial<Record<DocumentKind, DocumentProcessor>>;
```

- 처리 성공: 첨부할 `File` 반환 (수정본 또는 원본 선택 시 원본)
- 사용자 취소 / 처리 불가 / 오류: `null` 반환 → 사이트 모듈은 첨부하지 않는다
- `signal` 이 abort 되면 새 파일 선택으로 무효화된 것이므로 결과를 폐기한다

## 파일 구성

| 파일 | 역할 |
| --- | --- |
| `types.ts` | `DocumentProcessor` 등 문서 모듈과의 경계 타입 (코어 개념 없음) |
| `classify.ts` | MIME/확장자 기반 파일 종류 분류 |
| `event-guard.ts` | 재발행 이벤트를 후킹이 다시 잡지 않게 표시 (무한 루프 방지) |
| `file-injector.ts` | `DataTransfer`로 FileList 교체, change/drop 재발행 |
| `dom-interceptor.ts` | change/drop/paste capture 후킹, 분류·위임·재주입 (1차 방어선) |
| `processing-indicator.ts` | 처리 중 "검사 중" 오버레이 UI (Shadow DOM, 사이트 CSS와 격리) |
| `network-guard.ts` | fetch/XHR 감시, DOM 우회 업로드 탐지 (2차 방어선, 보조) |
| `index.ts` | 공개 API |

## 연결 예 (다른 팀이 조립)

```ts
import { createFileUploadInterceptor } from '@/modules/sites/claude/file-upload';
import { processPdf } from '@/modules/documents/pdf';  // 문서 모듈이 제공
import { processDocx } from '@/modules/documents/docx';

const interceptor = createFileUploadInterceptor({
  processors: {
    pdf: processPdf,
    docx: processDocx,
  },
  unhandled: 'passthrough', // pdf/docx 외 파일 정책 (기본 원본 첨부)
  onError: (error) => console.error('[blAInd] 처리 오류, 업로드 보류', error),
});

interceptor.start();
```

- **change/drop/paste**는 DOM 이벤트이므로 **격리 월드 content script**에서 동작한다.
- **네트워크 안전망**은 `window.fetch` 패치가 필요하므로 **MAIN world**에서 별도 호출한다.

## 처리 중 UI

파일을 문서 모듈이 처리하는 동안 사용자에게 "검사 중"임을 보여주는 오버레이다.
`dom-interceptor`가 자동으로 띄우고 숨긴다.

- **Shadow DOM**으로 렌더링해 Claude CSS와 충돌하지 않는다.
- `pointer-events: none` 이라 페이지 조작을 막지 않는다.
- 처리 완료·취소·오류 시 자동으로 사라진다.
- 즉시 끝나는 passthrough 에서 깜빡이지 않도록 150ms 지연 후 표시한다.

### 문구/동작 커스터마이즈

```ts
import { createProcessingIndicator } from '@/modules/sites/claude/file-upload';

const interceptor = createFileUploadInterceptor({
  processors: { pdf: processPdf },
  indicator: createProcessingIndicator({
    labels: {
      title: '개인정보 검사 중',
      files: (n) => (n > 1 ? `첨부 ${n}개 처리 중` : '첨부 파일 처리 중'),
      hint: '잠시만 기다려 주세요.',
    },
    bottomOffsetPx: 120,
  }),
});
```

- `indicator: false` 로 끌 수 있다.
- `processing-indicator.ts`는 코어의 승인/탐지 결과를 표시하지 않는다. 그건
  `features/review` 의 몫이며, 여기서는 순수하게 "처리 중" 상태만 보여준다.

## 안전 규칙

1. **오류·취소 시 원본을 절대 자동 전송/업로드하지 않는다.**
2. 파일 묶음 중 하나라도 취소/보류면 전체를 첨부하지 않는다(부분 첨부 유출 방지).
3. 처리 중 새 파일이 들어오면 `AbortController`로 이전 처리를 무효화한다.
4. change 시 `input.value`를 즉시 비워 원본이 다른 경로로 새지 않게 한다.
5. 처리 시작 URL·대화 식별 속성·입력 영역을 보관하고, 대화 이동 시 이전 배치를 취소한다.
6. 재첨부 직전에 같은 대화·입력 영역인지 다시 확인한다. 원래 input이 사라지면 문서 전체에서
   다른 input을 찾지 않는다. 대화 ID를 확인할 수 있고 기존 composer가 살아 있는 경우에만
   그 내부의 유일한 호환 input으로 대체한다. composer 전체 교체·모호한 후보는 보류한다.

대화 변경 감시는 공통 `modules/sites/upload-context.ts`가 담당한다. Navigation API,
URL 변경, DOM 제거·대화 식별 속성 변경을 감시하며, stop/abort/완료 시 감시를 해제한다.
새 대화처럼 URL에 대화 ID가 없으면 input 교체 fallback을 사용하지 않는다.

## 검증된 업로드 흐름 (리버싱)

`claude.ai.har`에서 확인한 흐름이다.

```http
POST /api/organizations/{org}/conversations/{conversation}/wiggle/upload-file
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary...
(필드명: file / filename / Content-Type: application/pdf)

→ 200 application/json
{
  "success": true,
  "path": "/mnt/user-data/uploads/NLP_W5_lecture.pdf",
  "sanitized_name": "NLP_W5_lecture.pdf",
  "file_kind": "document",
  "file_uuid": "488fcf0c-ab21-4acb-8665-743013b08d42",
  "file_name": "NLP_W5_lecture.pdf",
  "size_bytes": 1122819,
  "thumbnail_asset": { "url": "/api/{org}/files/{uuid}/thumbnail", ... }
}
```

- 업로드는 **단일 multipart POST** 한 번. 서버가 텍스트 추출·썸네일까지 처리한다.
- 인증은 쿠키 기반이며 `Authorization` 헤더가 없다.
- 핵심 식별자는 `wiggle/upload-file` 경로다. `network-guard.ts` 패턴에 포함돼 있다.
- 이후 `GET /api/{org}/files/{uuid}/thumbnail` 은 업로드가 아니다.

**설계 결론:** 요청이 multipart 라 파일 파트를 식별할 수는 있지만, 서버가 처리하기 전에
**DOM 단계에서 원본을 바꿔치기**해야 한다(1차 방어선).

## 아직 남은 일

- 사이트별 실제 composer 구조에서 안전한 재첨부 범위 확인
- 실제 Claude DOM에서 capture 차단·재주입 동작 E2E 검증
- 문서 모듈과 `DocumentKind`·`DocumentProcessor` 시그니처 최종 합의
