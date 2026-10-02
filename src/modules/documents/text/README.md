# Plain text / Markdown 문서 모듈

`.txt`, `.md`(및 `.markdown`)를 처리하는 모듈입니다. 업로더 계약과 PDF·DOCX 모듈의
Detector/Alert API 계약을 그대로 사용합니다.

```ts
import { createTextDocumentProcessor } from '@/modules/documents/text';

const processText = createTextDocumentProcessor({
  detector,
  review: (payload, { signal }) => alertClient.review(payload, { signal }),
});

const processors = { pdf: processPdf, docx: processDocx, text: processText };
```

`detector`와 `review`는 호출자가 주입합니다. 기존 단일 텍스트 Alert UI가 아니라
`docs/alert-review-api.md`에 정의된 다중 세그먼트·세 그룹 응답을 구현한 review 함수가
필요합니다. 취소·오류 시 `null`이며 원본은 절대 반환되지 않습니다.

텍스트 파일은 UTF-8(선택적 BOM)만 허용합니다. 잘못된 UTF-8, NUL 포함 바이너리,
지원하지 않는 확장자, 기본 10 MiB 입력·12 MiB 출력·500만 UTF-16 코드 단위 초과는
보류합니다. Markdown은 렌더링/HTML 변환하지 않고 소스 텍스트 그대로 검사합니다.
승인된 구간만 `█`로 치환하므로 heading, link, code fence, 줄바꿈, 공백, BOM 등 나머지
내용은 그대로 유지됩니다. 결과 이름은 `masked-document.txt` 또는
`masked-document.md`이며 UTF-8 MIME을 사용합니다.

본문 전체를 단일 `text` segment로 전달합니다. 문자 구간은 Detector API의 UTF-16
`[start,end)` 기준이고, Alert 결정을 공유 validator로 검증한 뒤 끝에서부터 치환합니다.
새 파일 생성·검증에는 사이트 DOM 접근이 없고, `AbortSignal`은 Detector와 review에
각각 전달됩니다.

CSV·JSON·HTML·로그 등 다른 텍스트 확장자를 자동으로 받지 않습니다. 사이트 분류기가
현재 여러 형식을 `text`로 묶고 있으므로, 처리기 레지스트리에 이 모듈을 연결할 때는
`.txt`·`.md`·`.markdown`만 이 처리기로 보내고 나머지는 보류하도록 라우팅해야 합니다.
실제 entrypoint/사이트 등록은 이 모듈에 포함되지 않습니다.
