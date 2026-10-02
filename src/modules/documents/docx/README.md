# DOCX 문서 모듈

사이트 업로더의 `(file: File, signal: AbortSignal) => Promise<File | null>` 계약을 구현합니다.
Word의 `.docx` 문서용이며, 이전 바이너리 `.doc` 형식은 지원하지 않습니다.

## 연결

```ts
import { createDocxProcessor } from '@/modules/documents/docx';

const processDocx = createDocxProcessor({
  detector, // PiiDetectorApi 공개 클라이언트
  review: (payload, { signal }) => alertClient.review(payload, { signal }),
  onStage: (stage, file) => { /* extracting/scanning/reviewing/rebuilding 표시 */ },
  onError: (error, file) => { /* 처리 보류 안내 */ },
});

// 기존 PDF 처리기와 같은 레지스트리에 나란히 연결합니다.
const processors = { pdf: processPdf, docx: processDocx };
```

`detector`와 `review`는 호출자가 주입해야 합니다. `alertClient`는 연결 예시의 이름이며
제공되는 전역 객체가 아닙니다. `docs/alert-review-api.md`의 다중 세그먼트·세 그룹 계약을
구현한 프론트 호출 함수를 연결해야 합니다. 현재 `mountPrivacyAlert`의 선택된 Confirm 탐지 목록을
결정 데이터로 역추정하거나 자동 승인하지 않습니다. 프론트는 여러 문서 요청을 순서대로
표시하고 각 signal이 취소되면 해당 창·대기 요청을 정리해야 합니다.
entrypoint와 실제 사이트 업로드 연결은 별도입니다.

## API 준수

- 코어 타입은 `src/core/api/`를 사용합니다. `initialize()` 후
  `scanSegments(segments, { signal })`를 호출하며 모델 청킹은 코어 책임입니다.
- DOCX 엔진의 문단별 `TextSegment`를 사용합니다. UTF-16 원문 오프셋을 유지합니다.
- Alert 데이터는 `segments`만 포함합니다. `word`는 해당 원문의 `slice(start, end)`이며
  Detector 원본 결과는 수정하지 않습니다. signal은 별도 호출 컨텍스트입니다.
- 공유 review 검증은 `segmentId + type + span`으로 항목을 연결하고 `autoMask`,
  `confirm.masking`, `confirm.nonMasking`을 모두 검증합니다. `requestId`·`itemId`는 없습니다.
- 자동 마스킹 누락, 중복, 잘못된 그룹, 원문과 다른 word/span은 처리를 보류합니다.
  마스킹과 명시적 원문 유지 구간이 겹쳐도 임의의 우선순위를 적용하지 않고 보류합니다.
- 사용자 취소는 재생성을 호출하지 않습니다. 오류·취소는 `null`이며 원본 파일을 반환하지 않습니다.
- 탐지가 없거나 모두 원문 유지여도 승인이 필요하며 승인 후 재생성합니다.
- 출력 파일명은 `masked-document.docx`, MIME은
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`입니다.

## 지원 범위와 제한

엔진 의존성은 ZIP 처리를 위한 `fflate`와 XML 처리를 위한 `@xmldom/xmldom`입니다.
일반적인 모든 Word 패키지를 지원하는 변환기가 아니라, 엔진이 검증할 수 있는 제한된
텍스트 중심 OOXML 패키지를 처리합니다. 지원하지 않는 패키지 구성·관계·문서 요소는
보류 대상입니다. 이미지의 개인정보에 대한 OCR이나 `.doc` 변환은 제공하지 않습니다.
원본의 모든 서식과 부가 기능 보존을 보장하지 않습니다.

- 본문·표 셀·머리글·바닥글·각주·미주의 문단을 검사합니다. 여러 run으로 분리된
  문자열과 탭·줄바꿈을 하나의 문단 문자열에 매핑합니다.
- 선택된 UTF-16 구간을 `█` 문자로 치환합니다. 이미지나 덮개를 얹는 방식이 아니라
  실제 OOXML 텍스트를 바꾸며, 나머지 문자와 일반적인 run·문단·표 서식은 유지합니다.
- 문서 속성·댓글·책갈피·설정·글꼴 목록 등은 제거하고 관계 파일과 콘텐츠 타입 목록도
  함께 갱신합니다. 사용자 정의 스타일 식별자는 일관된 익명 ID로 바꿉니다.
- 이미지·도형·텍스트 상자·내장 객체·매크로·필드·변경 추적·콘텐츠 컨트롤·수식·외부
  관계(하이퍼링크 포함)·미지원 확장 요소가 있으면 보류합니다.
- UTF-8의 transitional OOXML을 지원합니다. DTD/엔티티 선언, 128단계 초과 XML 중첩,
  ZIP64·분할/암호화 ZIP·중복/비정상 경로·CRC 불일치는 거부합니다.
- 재생성 후 직렬화된 XML을 다시 파싱해 문단 수와 예상 텍스트가 일치하는지 확인합니다.

기본 제한은 입력 25 MiB, 출력 50 MiB, ZIP 항목 2,048개, 비압축 합계 100 MiB,
문단 10,000개, 텍스트 100만 UTF-16 코드 단위입니다. `limits`로 각 값을 조정할 수 있습니다.
`OpenDocx` 세션 인터페이스를 구현한 엔진을 `openDocx` 옵션으로 주입할 수 있으며,
주입 엔진은 동일한 제한과 signal을 준수하고 `close()`로 자원을 해제해야 합니다.

## 실행 환경과 취소

기본 구현은 문서마다 별도 module Worker를 생성합니다. 메시지 리스너 설치 후 엔진을
동적으로 로드하며, 취소 시 해당 DOCX Worker만 종료합니다. 코어의 공유 Worker나
다른 문서 처리는 종료하지 않습니다. 사용자 선택 대기 중에도 signal을 감시하고 늦은
승인 결과는 폐기합니다.

실제 확장에서는 Worker를 실행할 수 있는 확장 페이지/offscreen 환경과 프론트 review
연결 계층이 필요합니다. 사이트 CSP와 격리 월드 제한 때문에 content script에서의 직접
Worker 실행을 가정하지 않습니다. 단계별 UI는 `onStage`에 연결하며 이 모듈은 사이트
DOM을 조작하지 않습니다. 실제 사이트 업로드 검증은 entrypoint·코어·Alert 연결 후 필요합니다.

## 검증

```sh
npx vitest run tests/unit/docx-processor.test.ts tests/unit/pdf-processor.test.ts
npx playwright test tests/e2e/docx-module.spec.ts
```

브라우저 테스트에는 Playwright Chromium 설치가 필요합니다. 실제 DOCX ZIP을 생성해
Worker에서 처리하고, 출력 OOXML의 선택 구간 제거·한글과 서식 보존을 확인합니다.
