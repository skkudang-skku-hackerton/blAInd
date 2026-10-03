# Alert 검토 데이터 명세

탐지 결과를 확인창(Alert)에 표시하고, 사용자가 고른 항목별 마스킹 여부를 텍스트·문서 처리 모듈에
전달하는 확장 내부 데이터 계약입니다. HTTP API가 아닙니다. `Detection`, `TextSegment` 등
탐지기 타입은 [PII 탐지 API](pii-detection-model-api.md)를 따릅니다.

```text
탐지 결과 → expandDetections() → Alert 표시 (정책에 따라 초기 체크)
  → 승인: 세 그룹으로 결정 반환 → 처리 모듈이 검증 후 마스킹
  → 취소: { status: 'cancelled' }, 처리 모듈은 아무것도 보내지 않음
```

## 정책

18개 유형마다 `AUTO_MASK`(처음부터 체크) 또는 `CONFIRM`(처음에 해제)을 설정합니다. 정책은
초기 체크 상태만 정하며, 확인창에서는 모든 항목을 체크하거나 해제할 수 있습니다. 확인창에서의
선택은 저장된 설정을 바꾸지 않습니다.

| 구분 | 기본 유형 |
| --- | --- |
| Auto Mask | `RRN`, `FRN`, `CARD_NUMBER`, `ACCOUNT_NUMBER`, `SECRET`, `PASSPORT`, `DRIVER_LICENSE`, `CVC`, `IPIN`, `PHONE`, `EMAIL` |
| Confirm | `USER_ID`, `PERSON`, `ADDRESS`, `ZIPCODE`, `DATE`, `GENERIC_ID`, `CARD_EXPIRY` |

사용자 설정은 확장 팝업·옵션 화면에서 바꾸며 `browser.storage.local`에 저장되고 다음 검사부터
적용됩니다. 문서 요청은 검사 당시 설정의 복사본(`maskingPreferences`)을 함께 담아, 확인 도중
설정이 바뀌어도 분류가 유지됩니다. 이 필드가 없으면 기본값을 사용합니다.

## Alert에 전달하는 데이터

텍스트와 문서 모두 `segments` 배열을 사용합니다. 텍스트는 ID가 `text`인 segment 하나, 문서는
페이지·문단마다 segment 하나입니다. 겹친 영역은 `expandDetections()`로 펼친 개별 탐지를 넣고,
`word`는 전달하는 쪽에서 `text.slice(start, end)`로 계산해 추가합니다. 탐지기 원본 결과는 수정하지 않습니다.

```json
{
  "segments": [
    {
      "id": "text",
      "text": "김민수 이메일은 minsu@example.com입니다.",
      "detections": [
        { "type": "PERSON", "confidence": 0.98, "span": { "start": 0, "end": 3 }, "word": "김민수" },
        { "type": "EMAIL", "confidence": 0.99, "span": { "start": 9, "end": 26 }, "word": "minsu@example.com" }
      ]
    }
  ]
}
```

## Alert가 반환하는 데이터

승인하면 모든 탐지를 다음 세 그룹 중 **정확히 하나**에 넣어 반환합니다.

| 그룹 | 내용 |
| --- | --- |
| `autoMask` | 체크된 Auto Mask 항목 |
| `confirm.masking` | 체크된 Confirm 항목 |
| `confirm.nonMasking` | 체크되지 않은 항목 (해제한 Auto Mask 항목 포함) |

각 항목은 `segmentId`, `type`, `span`, `word`를 가지며 `confidence`는 포함하지 않습니다.

```json
{
  "status": "approved",
  "autoMask": [
    { "segmentId": "text", "type": "EMAIL", "span": { "start": 9, "end": 26 }, "word": "minsu@example.com" }
  ],
  "confirm": {
    "masking": [],
    "nonMasking": [
      { "segmentId": "text", "type": "PERSON", "span": { "start": 0, "end": 3 }, "word": "김민수" }
    ]
  }
}
```

**원문으로 진행**은 모든 항목을 `confirm.nonMasking`에 넣습니다. 취소하면 `{ "status": "cancelled" }`만 반환합니다.

처리 모듈은 `segmentId + type + span`으로 결정을 탐지와 연결하고 다음을 검증합니다. 위반하면
처리를 중단하고 아무것도 보내지 않습니다.

- `autoMask`와 `confirm.masking`의 항목은 검사 당시 정책과 일치해야 합니다.
- 알 수 없는 항목, 중복, 누락, 원문과 다른 `word`·`span`은 거부합니다.
- 별도의 `requestId`·`itemId`는 사용하지 않습니다.

## 마스킹 규칙

- `autoMask`와 `confirm.masking`의 구간만 마스킹합니다. `confirm.nonMasking`은 마스킹 대상에
  추가하지 않을 뿐, 다른 선택과 겹치는 부분까지 보호를 취소하지는 않습니다.
- 선택된 구간끼리 겹치면 **합집합 전체**를 가립니다. 예: RRN `[0,5)`와 PHONE `[3,10)` 선택 → `[0,10)`.
  선택하지 않은 탐지의 단독 영역은 넓히지 않습니다. 맞닿은 구간은 따로 처리합니다.
- 원문 오프셋이 바뀌지 않도록 뒤쪽 구간부터 치환합니다.
- 취소·오류 시에는 원문을 전송하거나 원본을 업로드하지 않습니다.

치환 형식은 대상에 따라 다릅니다.

| 대상 | 치환 | 구현 |
| --- | --- | --- |
| 채팅 텍스트 | `[TYPE_번호]` 라벨 | `src/alert/masking.ts`의 `applyMasking()` |
| DOCX · HWPX · TXT/Markdown | 같은 길이의 `█` | 각 문서 엔진이 실제 텍스트를 치환 |
| PDF | 렌더링 픽셀을 검게 지우고 남은 텍스트만 비표시 레이어로 보존 | `src/modules/documents/pdf/` |

텍스트 라벨 규칙:

- 유형별로 1부터 처음 등장한 순서대로 번호를 붙입니다. 원문 유지 항목은 번호를 쓰지 않습니다.
- 같은 유형·정확히 같은 문자열은 같은 번호를 재사용합니다(공백·기호 정규화 없음).
- 겹쳐 합쳐진 구간은 라벨 하나로 치환하며, 유형은 가장 먼저 시작하는 탐지(같으면 더 긴 구간)를 따릅니다.
- 번호는 전송마다 초기화합니다.

```text
원문: 김민수에게 연락해줘. 김민수의 번호는 010-1234-5678이야.
결과: [PERSON_1]에게 연락해줘. [PERSON_1]의 번호는 [PHONE_1]이야.
```

확인창의 미리보기는 일부 자리(예: 전화번호 끝 네 자리)를 보여줄 수 있지만, 최종 결과에는 마스킹
대상 원문이 남지 않습니다. 문서에서 표시만 덮고 원문을 파일에 남기는 방식은 허용하지 않습니다.
