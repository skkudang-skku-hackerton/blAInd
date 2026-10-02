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

## 안전 규칙

1. **오류·취소 시 원본을 절대 자동 전송/업로드하지 않는다.**
2. 파일 묶음 중 하나라도 취소/보류면 전체를 첨부하지 않는다(부분 첨부 유출 방지).
3. 처리 중 새 파일이 들어오면 `AbortController`로 이전 처리를 무효화한다.
4. change 시 `input.value`를 즉시 비워 원본이 다른 경로로 새지 않게 한다.

## 아직 남은 일

- `DragEvent` + `dataTransfer` 생성이 막히는 환경의 드롭 fallback
- 실제 ChatGPT DOM에서 capture 차단·재주입 동작 E2E 검증
- 문서 모듈과 `DocumentKind`·`DocumentProcessor` 시그니처 최종 합의
