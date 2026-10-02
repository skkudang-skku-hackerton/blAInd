# HWPX 문서 모듈 (시연용)

DOCX/PDF 처리기와 같은 `File + AbortSignal → File | null` 계약을 제공합니다.

```ts
import { createHwpxProcessor } from '@/modules/documents/hwpx';

const processHwpx = createHwpxProcessor({
  detector, // PiiDetectorApi
  review: (request, { signal }) => reviewClient.review(request, { signal }),
  onStage: (stage) => console.info('HWPX:', stage),
  onError: (error) => console.error('HWPX 처리 보류', error),
});
```

`review`는 `docs/alert-review-api.md`의 `approved/cancelled`, `autoMask`, `confirm.masking`,
`confirm.nonMasking` 계약을 구현해야 합니다. 반환 파일 이름은 `masked-document.hwpx`, MIME은
`application/hwp+zip`입니다. 취소나 오류에서는 원본을 돌려주지 않고 `null`을 반환합니다.

## 데모 지원 범위

- HWPX ZIP 패키지의 `mimetype`이 `application/hwp+zip`이고, `Contents/sectionN.xml`에
  한컴 2011 paragraph namespace의 `hp:p` / `hp:t`가 있는 텍스트 문서를 대상으로 합니다.
- 문단은 한글 run이 여러 개여도 합쳐서 탐지하고, 승인된 UTF-16 구간의 실제 XML 텍스트를
  `█`로 바꿉니다. 나머지 ZIP 항목과 기본 서식은 보존하고 결과 패키지를 다시 열어 검사합니다.
- 인식하지 못하는 HWPX 세부 구조, 표 밖의 별도 텍스트 파트, 이미지/OCR, 수식·필드의
  시각적 표현을 완전하게 보호한다고 보장하지 않습니다. 해커톤 시연에서는 함께 제공하는
  텍스트 중심 샘플 문서를 사용해주세요. 범위 밖 문서의 안전한 실제 업로드 용도로는 검증되지 않았습니다.
- 사이트 업로드 진입점과 승인 UI는 아직 별도로 연결해야 합니다. 기본 엔진은 문서마다
  Worker를 사용하며 직접 테스트를 위해 `openHwpx` 주입도 허용합니다.

## 검증

```sh
npx vitest run tests/unit/hwpx-processor.test.ts
```
