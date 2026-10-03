# PDF 문서 모듈

사이트 업로더의 `(file: File, signal: AbortSignal) => Promise<File | null>` 계약을 구현합니다.
`src/entrypoints/` 연결은 포함하지 않습니다.

## 연결

```ts
import { createPdfProcessor } from '@/modules/documents/pdf';

const processPdf = createPdfProcessor({
  detector, // PiiDetectorApi 공개 클라이언트
  review: (payload, { signal }) => alertClient.review(payload, { signal }),
  onStage: (stage, file) => { /* extracting/scanning/reviewing/rebuilding 표시 */ },
  onError: (error, file) => { /* 처리 보류 안내 */ },
});

// ChatGPT, Claude, Gemini 모두 동일한 처리기를 주입할 수 있습니다.
const processors = { pdf: processPdf };
```

`alertClient`는 연결 예시의 의존성 이름이지 현재 제공되는 전역 객체가 아닙니다.
`createDocumentReview`가 다중 segment의 탐지 항목을 Alert에 표시하고, 세 그룹의 결정을 원래 segment 좌표로 복원합니다. `app.content`는 ChatGPT·Claude·Gemini 업로드 인터셉터에 이 검토 함수와 PDF 처리기를 연결합니다. 문서 Worker는 Chrome에서 offscreen, Firefox·Safari에서 background page에서 실행됩니다.

## API 준수

Detector/Alert 데이터 타입, 승인 응답 검증, 취소 대기 헬퍼는 `../shared/`에 두고
DOCX 모듈과 동일한 구현을 사용합니다. 기존 PDF 공개 타입과 함수는 유지합니다.

- 코어 타입은 `src/core/api/`에서 가져옵니다. `initialize()` 후
  `scanSegments(segments, { signal })`만 사용합니다. Worker에 직접 추론을 요청하지 않습니다.
- 모델 청킹은 코어 책임입니다. PDF는 페이지별 `TextSegment`만 생성합니다.
- Alert 데이터는 `docs/alert-review-api.md` 그대로 `segments`만 전달합니다.
  `word`는 원문의 `slice(start, end)`로 만들고 Detector 결과를 수정하지 않습니다.
- Alert 응답은 `autoMask`, `confirm.masking`, `confirm.nonMasking`으로 검증합니다.
  항목 연결에는 `segmentId + type + span`을 사용합니다. `requestId`·`itemId`를 추가하지 않습니다.
- `AbortSignal`은 호출 컨텍스트이며 Alert 데이터 필드가 아닙니다.
- 자동 마스킹 항목도 확인창에서 체크를 해제할 수 있으며, 해제한 항목은 `confirm.nonMasking`으로 전달합니다.
  항목 누락, 중복, 잘못된 마스킹 그룹, 원문과 다른 word/span은 처리를 보류합니다.
- 마스킹과 nonMasking 구간이 겹치면 선택한 마스킹이 공유 문자에 우선합니다.
  nonMasking의 단독 영역은 유지하며, 겹침만으로 처리를 보류하지 않습니다.
- `cancelled`이면 재생성 처리를 호출하지 않습니다. 오류·취소 시 `null`이며 원본 반환은 없습니다.
- 탐지가 없거나 모두 원문 유지여도 승인 이후 새 PDF를 생성합니다.

## PDF 처리

MuPDF의 문자별 사각형과 UTF-16 오프셋을 함께 저장합니다. 승인된 문자만 선택하여
페이지 렌더링 결과의 픽셀을 검게 지운 뒤, 새 PDF에 해당 이미지와 남은 문자의
**비표시 텍스트(`ignoreText`, PDF 렌더링 모드 3)**를 넣습니다. 원래 위치를 유지하며,
삭제된 텍스트를 숨김 레이어에 복사하지 않습니다. 치환으로 원문 오프셋을 변경하지 않고
원본 문자 매핑에서 출력 대상을 선택하므로 여러 구간을 처리해도 위치가 밀리지 않습니다.

원본 문서 객체·메타데이터·첨부·주석·폼은 복사하지 않습니다. 주석과 폼은 렌더링에서도
제외됩니다. 파일명은 `masked-document.pdf`로 바꿉니다. CJK 출력 폰트는 엔진에 포함된
폰트를 사용하며 외부 서버에서 문서나 폰트를 다운로드하지 않습니다.

출력 PDF를 다시 열어 페이지 수와 페이지별 남은 텍스트를 검증합니다. 같은 민감 문자열을
다른 위치에서 원문 유지하도록 선택할 수 있으므로 전역 문자열 금지 방식은 쓰지 않습니다.
텍스트 검증은 추출기가 삽입한 공백 차이만 무시합니다. 모델 탐지 누락까지 보장하는 검증은 아닙니다.

### 초기 지원 범위

- 가로 방향의 텍스트 PDF, 한글·영문 등 내장 출력 폰트가 지원하는 문자
- 이미지 포함 페이지·스캔·빈 페이지·세로/회전 텍스트·비정상 인코딩은 보류
- 겹쳐 쓰인 글자 때문에 미선택 내용까지 지워질 수 있는 문서는 보류
- 기본 입력 25 MiB, 출력 50 MiB, 100페이지, 100만 UTF-16 코드 단위
- 기본 2배 렌더링, 페이지당 1,600만 픽셀 제한

이미지에 들어 있는 개인정보를 OCR 없이 검사했다고 간주하지 않기 때문에 로고 등
이미지가 포함된 문서도 현재는 보류됩니다. 벡터로 그린 글자는 텍스트 추출 대상이 아니므로
이미지·벡터 개인정보까지 탐지하려면 후속 OCR 지원이 필요합니다.

## 실행 환경과 취소

기본 구현은 문서마다 별도 module Worker를 생성하여 MuPDF WASM을 실행합니다.
실제 확장 연결 시 WASM을 실행할 수 있는 확장 페이지/offscreen 환경에서 처리기를
실행하고, Alert 호출은 프론트 연결 계층으로 전달해야 합니다. 사이트 페이지 CSP와
격리 월드의 Worker 생성 제한 때문에 content script에서 직접 실행되는 것으로 가정하지 않습니다.

취소 시 해당 PDF Worker만 종료합니다. 코어의 공유 Worker나 다른 문서를 종료하지 않습니다.
사용자 선택 대기 중에도 signal을 감시하며 늦은 승인 결과는 폐기합니다.
사이트 업로더의 인디케이터는 기본적으로 모든 단계에서 계속 표시됩니다. 단계별 문구는
`onStage`와 외부 UI를 연결해야 합니다. 이 모듈은 사이트 DOM을 조작하지 않습니다.

## 의존성과 검증

PDF 엔진은 `mupdf@1.28.1`이며 **AGPL-3.0-or-later** 라이선스입니다.
엔진을 교체하려면 `OpenPdf` 세션 인터페이스를 구현해 `openPdf` 옵션으로 주입할 수 있습니다.

```sh
npx vitest run tests/unit/pdf-processor.test.ts
npx playwright test tests/e2e/pdf-module.spec.ts
```

테스트는 실제 생성한 한글 PDF, 선택 구간 제거·원문 유지, 계약 위반 응답,
취소와 늦은 승인, 파일·페이지 제한을 검증합니다. 브라우저 테스트는 Chromium에서
번들된 Worker·WASM 로딩과 PDF 재생성을 검증하며 Playwright Chromium 설치가 필요합니다.
실제 확장 경유 흐름은 `tests/e2e/document-flow.spec.ts`와
[문서 업로드 테스트](../../../../docs/document-upload-test.md)를 참고하세요.
