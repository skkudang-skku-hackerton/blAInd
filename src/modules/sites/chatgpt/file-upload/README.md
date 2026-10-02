# ChatGPT 파일 업로드 처리

`chatgpt.com`에서 사용자가 파일을 첨부할 때, 원본이 전송되기 전에 붙잡아 **파일 종류를
분류한 뒤 알맞은 문서 모듈(pdf/docx/hwpx)에 넘기고, 돌아온 파일을 첨부**하는 사이트 모듈이다.

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
import { createFileUploadInterceptor } from '@/modules/sites/chatgpt/file-upload';
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

- **Shadow DOM**으로 렌더링해 ChatGPT CSS와 충돌하지 않는다.
- `pointer-events: none` 이라 페이지 조작을 막지 않는다.
- 처리 완료·취소·오류 시 자동으로 사라진다.
- 즉시 끝나는 passthrough 에서 깜빡이지 않도록 150ms 지연 후 표시한다.

### 문구/동작 커스터마이즈

```ts
import { createProcessingIndicator } from '@/modules/sites/chatgpt/file-upload';

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

## 검증된 업로드 흐름 (리버싱)

`chatgpt.com` 번들(`legacy-image-upload-*.js`, `a-Cn0LrOds.js`)을 분석해 확인한 흐름이다.
인증/비인증에 따라 경로 접두사만 `backend-api` / `backend-anon` 으로 갈린다.

```
1) POST /backend-(api|anon)/files
     body(JSON): { file_name, file_size, mime_type, client_resolved_mime_type,
                   use_case: "multimodal", selection_method, entry_surface,
                   reset_rate_limits, timezone_offset_min, ... }
     resp(JSON): { file_id, status, upload_url, upload_headers?, ... }

2) 파일 전송 (upload_url 기준으로 분기)
     ├─ upload_url 경로가 /estuary/upload_content_bytes
     │    → POST  (FormData: file, upload_url)  (credentials: include)
     └─ 그 외
          → PUT   upload_url + upload_headers (예: *.oaiusercontent.com)

3) POST /backend-(api|anon)/files/process_upload_stream
     body(JSON): { file_id, file_name, use_case: "multimodal",
                   entry_surface: "chat_composer", index_for_retrieval }
```

- 번들 내 경로 검증기가 허용 경로를 정확히 열거한다:
  `/backend-api/files[/process_upload_stream]`, `/backend-anon/...`,
  `/(api|backend-api|backend-anon)/estuary/upload_content_bytes`
- 허용 오리진: `https://chatgpt.com`, `https://chatgpt-staging.com`
- `network-guard.ts`의 URL 패턴은 위 경로를 기준으로 맞춰 두었다.

### 인증 데스크톱 · 문서(PDF) 업로드 — 완전한 흐름 (HAR 확인)

`chatgpt.com_2.har`에서 PDF 1건의 전체 흐름이 확인됐다. 신형 "업로드 예약(reservation)" 방식이다.

```jsonc
// 1) POST /backend-api/files/upload_reservations    (application/json)
//    body
{
  "intended_use_case": "my_files",
  "entry_surface": "chat_composer",
  "requires_gizmo_id": false,
  "store_in_library": true,
  "library_persistence_mode": "opportunistic"
}
//    resp
{ "eligible": true,
  "reservation_id": "file_0000000024048206b09f19d14823200b",
  "upload_url": "https://<region>.oaiusercontent.com/files/<id>/raw?<SAS 토큰>",
  "upload_url_expires_at": "...", "reservation_expires_at": "..." }

// 2) PUT {upload_url}   (원본 바이트, cross-site, Azure Blob)
//    upload_url = https://<region>.oaiusercontent.com/files/<id>/raw?se=..&sp=w&sv=..&sr=b&sig=..
//    headers: content-type: application/pdf
//             x-ms-blob-type: BlockBlob
//             x-ms-blob-content-type: application/pdf
//             x-ms-version: 2020-04-08
//    → 201. SAS 쿼리로 인증하며 Authorization 헤더는 없다.

// 3) POST /backend-api/files/upload_reservations/{reservation_id}/claim_and_finish
{
  "file_name": "NLP_W5_lecture-1.pdf",
  "file_size": 1122819,
  "use_case": "my_files",
  "index_for_retrieval": true,
  "store_in_library": true,
  "library_persistence_mode": "opportunistic",
  "mime_type": "application/pdf",
  "entry_surface": "chat_composer",
  "metadata": { "store_in_library": true, "is_project_thread": false }
}
//    resp: text/event-stream (NDJSON)
//      file.processing.started → file.processing.file_ready
//      → file.indexing.completed → file.processing.completed
```

이후 `POST /backend-api/file_upload_action_suggestions`(UI 제안)가 이어진다(업로드와 무관).

- 다른 HAR에서는 대체 경로 `POST /backend-api/files/process_upload_stream`(본문에 `file_id` 포함)도
  관찰됐다. 계정·기능 플래그·진입점에 따라 둘 중 하나가 쓰이는 것으로 보인다.
- **이미지**: `use_case: "multimodal"`, **문서**: `use_case: "my_files"` + `index_for_retrieval: true`
- 인증은 (HTTP-only) 쿠키 + `chatgpt-account-id`/`oai-did` 헤더. `Authorization` 헤더는 없다.
- `network-guard.ts` 패턴은 `upload_reservations`, `claim_and_finish`, `process_upload_stream`,
  `oaiusercontent.com` 을 모두 커버한다(정규식 검증 완료).

**설계 결론:** 2단계 파일 전송은 `oaiusercontent.com` 으로의 **불투명한 raw PUT**(BlockBlob)이라,
이 층에서는 파일 내용을 읽거나 마스킹할 수 없다. 따라서 개인정보 차단은 반드시 **DOM 입력 단계**에서
원본 `File` 을 바꿔치기해야 한다(이 모듈의 1차 방어선). 네트워크 가드는 미처리 업로드 감지/차단용이다.

> 두 HAR 모두 `originator: Codex Browser`, `x-openai-web-frontend: codex_webview` 로 캡처된
> **Codex 브라우저 세션**이다. 엔드포인트·본문은 실제와 일치하지만 `x-openai-*` 계열 헤더는
> 일반 웹 세션과 다를 수 있다.

## 아직 남은 일

- `DragEvent` + `dataTransfer` 생성이 막히는 환경의 드롭 fallback
- 실제 ChatGPT DOM에서 capture 차단·재주입 동작 E2E 검증
- 문서 모듈과 `DocumentKind`·`DocumentProcessor` 시그니처 최종 합의
