# 사이트 모듈

등록된 AI 사이트마다 텍스트 입력과 파일 업로드를 가로채는 모듈입니다. 개인정보 검사·승인·마스킹은
알지 못하며, 원문이나 원본 파일을 넘기고 돌려받은 결과만 사이트에 반영합니다.

| 경로 | 내용 |
| --- | --- |
| `<site>/text.ts` | 입력창·전송 버튼 선택자 (공통 흐름은 [`modules/text`](../text/README.md)) |
| `<site>/file-upload/` | 파일 업로드 인터셉터 |
| `text-adapters.ts` | 사이트 ID와 텍스트 어댑터 연결 |
| `upload-context.ts` | 업로드 중 대화 이동·입력 영역 교체 감시 (공통) |
| `processing-indicator-styles.ts` | 처리 중 안내 공통 스타일 |

사이트별 업로드 분석: [ChatGPT](chatgpt/file-upload/README.md) ·
[Claude](claude/file-upload/README.md) · [Gemini](gemini/file-upload/README.md)

## 파일 업로드 인터셉터

세 사이트의 `file-upload/`는 같은 구조와 API를 갖고, 선택자와 네트워크 패턴만 다릅니다.

```text
input change / drop / paste (capture 단계)
  → 페이지로 전파 차단 + input.value 초기화
  → classifyFile()로 종류 판별 (MIME·확장자)
  → 등록된 DocumentProcessor(file, signal) 호출
      ├─ File 반환 → 그 파일로 change/drop 이벤트를 재발행해 첨부
      └─ null 반환 → 취소·처리 불가·오류 → 묶음 전체를 첨부하지 않음
```

```ts
type DocumentKind = 'pdf' | 'docx' | 'hwpx' | 'text' | 'image' | 'unknown';
type DocumentProcessor = (file: File, signal: AbortSignal) => Promise<File | null>;
```

현재 `app.content`는 세 사이트 모두에 `pdf`와 `docx` 처리기만 연결합니다. 처리기가 없는
종류는 `unhandled` 정책(기본 `'passthrough'`, 원본 첨부)을 따르며, `'hold'`로 바꾸면 첨부하지 않습니다.

```ts
const interceptor = createFileUploadInterceptor({
  processors: {
    pdf: createPdfProcessor({ ...documentOptions, openPdf: openPdfOffscreen }),
    docx: createDocxProcessor({ ...documentOptions, openDocx: openDocxOffscreen }),
  },
  onProcessed() {}, onSkipped() {}, onError(error) {},
});
interceptor.start();
```

| 파일 | 역할 |
| --- | --- |
| `dom-interceptor.ts` | change/drop/paste 후킹, 분류·위임·재주입 |
| `classify.ts` | 파일 종류 분류 |
| `file-injector.ts` | `DataTransfer`로 FileList 교체 후 이벤트 재발행 |
| `event-guard.ts` | 재발행한 이벤트를 다시 가로채지 않도록 표시 |
| `processing-indicator.ts` | 화면 가운데 로고·파일명 처리 안내 (Shadow DOM, 150ms 지연 표시, `indicator: false`로 끔) |
| `network-guard.ts` | fetch/XHR 업로드 감지 `installNetworkGuard()` — **현재 어디에도 설치되지 않음** |
| `types.ts`, `index.ts` | 경계 타입과 공개 API |

`network-guard`는 페이지의 `window.fetch`를 패치해야 하므로 MAIN world 스크립트가 필요하지만,
현재 확장에는 MAIN world 진입점이 없습니다. 실제 보호는 DOM 단계의 파일 교체에만 의존합니다.

## 안전 규칙

1. 오류·취소 시 원본을 자동으로 첨부하지 않습니다.
2. 여러 파일 중 하나라도 취소·보류되면 전체를 첨부하지 않습니다.
3. 처리 중 새 파일이 들어오면 이전 처리를 `AbortController`로 취소합니다.
4. change 시 `input.value`를 즉시 비워 원본이 다른 경로로 새지 않게 합니다.
5. 처리 시작 시점의 URL·대화 식별 속성·입력 영역을 기억하고, 대화를 이동하면 취소합니다.
6. 재첨부 직전에 같은 대화·입력 영역인지 다시 확인합니다. 원래 input이 사라졌다면 대화 ID가
   확인되고 기존 composer가 남아 있을 때만 그 안의 유일한 호환 input을 사용하며, 모호하면 보류합니다.
