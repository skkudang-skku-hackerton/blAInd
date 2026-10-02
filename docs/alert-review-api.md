# Alert Review 데이터 명세

이 문서는 Detector 결과를 Alert에 표시하고, 사용자가 선택한 Confirm 마스킹 여부를 Text/PDF/Word 처리 모듈에 전달하는 데이터 형식을 정의합니다. 별도 HTTP 서버 API가 아니라 확장 프로그램 내부 모듈 간 데이터 계약입니다.

Detector의 `Detection`, `TextSegment`, `SegmentDetectionResult` 정의는 [`pii-detection-model-api.md`](./pii-detection-model-api.md)를 따릅니다.

## 처리 흐름

```text
Detector 결과 → Alert
  AUTO_MASK: 사용자 선택 없이 항상 마스킹 대상
  CONFIRM: 항목마다 사용자가 마스킹 / 원문 유지 선택
Alert 결정 → Text 또는 PDF/Word processor
  AUTO_MASK 적용 + 사용자가 마스킹을 선택한 CONFIRM 적용
```

Alert는 승인 시 Auto Mask 항목과 Confirm의 마스킹/원문 유지 항목을 세 그룹으로 나눠 모두 전달합니다. 실제 마스킹은 처리 모듈이 합니다. 사용자가 취소하면 처리 모듈을 호출하지 않습니다.

## 정책

| 구분 | PII type |
| --- | --- |
| Auto Mask | `RRN`, `FRN`, `CARD_NUMBER`, `ACCOUNT_NUMBER`, `SECRET`, `PASSPORT`, `DRIVER_LICENSE`, `CVC`, `IPIN`, `PHONE`, `EMAIL` |
| Confirm | `USER_ID`, `PERSON`, `ADDRESS`, `ZIPCODE`, `DATE`, `GENERIC_ID`, `CARD_EXPIRY` |

## Detector가 제공하는 데이터

문자열 탐지 결과는 `Detection[]`입니다. `confidence`와 `span`은 Detector API의 실제 필드입니다.

```json
[
  {
    "type": "PERSON",
    "confidence": 0.98,
    "span": { "start": 0, "end": 3 }
  },
  {
    "type": "EMAIL",
    "confidence": 0.99,
    "span": { "start": 9, "end": 26 }
  }
]
```

- `confidence`: 모델의 탐지 신뢰도(0~1). Detector가 반환합니다. 사용자 결정 데이터에는 필요하지 않습니다.
- `span`: 원문에서 탐지된 구간의 시작/끝 offset입니다. 끝 offset은 미포함이며, JavaScript UTF-16 기준입니다. 처리 모듈이 원문에서 실제 위치를 찾을 때 사용합니다.
- `type`: 탐지된 PII 종류입니다.

## Alert에 전달하는 데이터

Text와 PDF/Word는 같은 형식으로 전달합니다. 공통 구조는 `segments` 배열이며, Text는 segment 하나를 넣고 PDF/Word는 여러 segment를 넣습니다. 탐지 문자열인 `word`는 Detector 응답 필드가 아니라 전달하는 쪽에서 `span`으로 원문을 잘라 추가하는 값입니다.

**Text 예시** — 문자열 전체를 하나의 segment로 전달합니다.

```json
{
  "segments": [
    {
      "id": "text",
      "text": "김민수 이메일은 minsu@example.com입니다.",
      "detections": [
        {
          "type": "PERSON",
          "confidence": 0.98,
          "span": { "start": 0, "end": 3 },
          "word": "김민수"
        },
        {
          "type": "EMAIL",
          "confidence": 0.99,
          "span": { "start": 9, "end": 26 },
          "word": "minsu@example.com"
        }
      ]
    }
  ]
}
```

**PDF/Word 예시** — 같은 구조에 segment를 여러 개 전달합니다.

```json
{
  "segments": [
    {
      "id": "page-1",
      "text": "김민수의 연락처는 010-1234-5678입니다.",
      "detections": [
        {
          "type": "PERSON",
          "confidence": 0.98,
          "span": { "start": 0, "end": 3 },
          "word": "김민수"
        },
        {
          "type": "PHONE",
          "confidence": 0.99,
          "span": { "start": 10, "end": 23 },
          "word": "010-1234-5678"
        }
      ]
    },
    {
      "id": "page-2",
      "text": "다음 페이지 내용입니다.",
      "detections": []
    }
  ]
}
```

Text에서는 `scanText` 결과를 단일 segment에 넣습니다. 문서에서는 `scanSegments`의 `segmentId`에 맞는 원문 segment에 탐지 결과를 넣습니다. 모든 `word`는 그 segment의 `text.slice(start, end)`로 만듭니다. Detector 원본 `Detection`은 수정하지 않습니다.

## Alert가 처리 모듈에 반환하는 데이터

승인 시 처리 대상 전체를 다음 세 그룹으로 나눠 반환합니다.

1. `autoMask`: 정책상 자동으로 마스킹할 항목
2. `confirm.masking`: 사용자가 마스킹을 선택한 Confirm 항목
3. `confirm.nonMasking`: 사용자가 원문 유지를 선택한 Confirm 항목

`status`는 Alert 전체에 대한 사용자의 진행 여부를 나타냅니다. `approved`는 처리를 계속해도 된다는 뜻이고, 실제 항목별 마스킹 여부는 아래 세 그룹으로 구분합니다. 따라서 `status`와 세 그룹은 서로 다른 정보를 전달합니다. 사용자가 취소하면 `status`는 `cancelled`이며 처리 모듈은 호출하지 않습니다.

Text와 PDF/Word 모두 같은 응답 구조를 사용합니다. 각 항목은 원문을 찾을 수 있도록 `segmentId`, `type`, `span`을 포함하고, 읽기 쉬운 `word`도 함께 전달합니다.

```json
{
  "status": "approved",
  "autoMask": [
    {
      "segmentId": "text",
      "type": "EMAIL",
      "span": { "start": 9, "end": 26 },
      "word": "minsu@example.com"
    }
  ],
  "confirm": {
    "masking": [],
    "nonMasking": [
      {
        "segmentId": "text",
        "type": "PERSON",
        "span": { "start": 0, "end": 3 },
        "word": "김민수"
      }
    ]
  }
}
```

Text는 `segmentId: "text"`를 사용합니다. PDF/Word는 원래 segment ID(예: `page-1`)를 사용합니다. Auto Mask는 사용자 선택 없이 항상 `autoMask`에 포함합니다. Confirm 항목은 사용자 선택에 따라 `confirm.masking` 또는 `confirm.nonMasking` 중 하나에만 포함합니다.

취소 응답은 아래와 같습니다. `cancelled`일 때는 항목 그룹을 반환하지 않으며, processor를 호출하지 않습니다.

```json
{ "status": "cancelled" }
```

## 처리 모듈의 적용 규칙

Text/PDF/Word processor는 원문과 Detector 결과를 보유하고 있다가 Alert의 세 그룹을 적용합니다.

1. `autoMask`의 모든 항목을 마스킹합니다.
2. `confirm.masking`의 모든 항목을 마스킹합니다.
3. `confirm.nonMasking`의 항목은 마스킹 대상에 추가하지 않습니다.
4. `segmentId`, `type`, `span`을 함께 사용해 결정을 해당 탐지와 연결합니다. Text도 단일 segment를 사용합니다.
5. 취소 또는 처리 오류 시 원문을 전송하거나 업로드하지 않습니다.
6. 아래 컨벤션에 따라 번호를 부여한 뒤, 원문 offset이 변하지 않도록 뒤쪽 위치부터 치환합니다.

## 마스킹 컨벤션

이 절은 최종 결과의 마스킹 규칙입니다. Alert 화면에서 값을 일부만 가리는 미리보기와 구분합니다. 미리보기에 끝 네 자리 등이 보이더라도 최종 결과에는 마스킹 대상 구간의 원문을 남기지 않습니다.

### 치환 형식과 동일 값

- 마스킹 대상 구간 전체를 `[TYPE_번호]`로 치환합니다. 예: `[PERSON_1]`, `[PHONE_1]`.
- 같은 타입과 같은 원문 문자열은 같은 번호를 재사용합니다. 원문은 `segment.text.slice(start, end)`로 계산하며, `word`로 위치를 다시 검색하지 않습니다.
- 문자열은 정확히 일치할 때만 같은 값으로 봅니다. 공백, 대소문자, 전화번호 구분 기호 등을 정규화하지 않습니다. 같은 문자열이라도 타입이 다르면 별도로 번호를 부여합니다.
- 번호는 타입별로 1부터 시작하며, 마스킹할 값이 처음 등장하는 순서로 부여합니다. 원문 유지 항목은 번호를 소비하지 않습니다.
- 번호와 동일 값 매핑의 범위는 한 번의 Alert 승인에 포함된 처리 대상 전체입니다. `segments` 배열 순서와 각 segment의 원문 위치 순서로 부여하며, PDF/Word의 페이지나 segment가 바뀌어도 같은 매핑을 사용합니다. 다음 전송에서는 초기화하며 이전 전송의 매핑을 재사용하지 않습니다.
- 동일 값의 라벨 재사용은 마스킹 대상으로 선택된 위치에만 적용합니다. 원문 유지로 선택한 다른 위치까지 찾아 치환하지 않습니다.

두 PERSON 항목을 모두 마스킹하기로 선택한 예시입니다.

```text
원문:
김민수에게 연락해줘. 김민수의 번호는 010-1234-5678이야.

결과:
[PERSON_1]에게 연락해줘. [PERSON_1]의 번호는 [PHONE_1]이야.
```

앞의 Alert 응답 예시는 PERSON을 원문 유지로 선택했으므로 결과가 `김민수 이메일은 [EMAIL_1]입니다.`가 됩니다.

### 처리 순서와 문서 적용

1. 원문 기준으로 `autoMask`와 `confirm.masking`의 대상 구간을 모읍니다.
2. 전체 segment를 원문 순서로 순회하며 동일 값 매핑과 번호를 확정합니다.
3. 각 segment의 뒤쪽 구간부터 치환합니다. 이미 치환한 문자열을 기준으로 offset이나 번호를 다시 계산하지 않습니다.

Text/PDF/Word 모두 같은 마스킹 대상·번호 규칙을 적용합니다. 문서에서는 원문 segment의 span을 실제 문서 위치로 연결해야 합니다. PDF/Word 파일에 라벨을 표시하는 구체적인 방법과 레이아웃 처리는 각 processor에서 다루되, 표시만 덮고 마스킹 대상 원문을 파일에 남기는 방식은 이 컨벤션을 충족하지 않습니다.

### 현재 구현과의 차이

이 컨벤션은 합의된 목표 동작입니다. 현재 텍스트 흐름은 모델 결과를 Alert UI에 표시하고, 선택한 Confirm과 모든 Auto Mask 항목을 마스킹해 입력창에 반영한 뒤 실제 전송 버튼을 한 번 호출합니다. `src/alert/masking.ts`의 `applyMasking`은 같은 타입·같은 원문 값의 라벨을 재사용하고 호출마다 번호를 초기화합니다. 여러 segment의 공통 번호 관리는 후속 구현 대상입니다. 현재 `mountPrivacyAlert`는 Auto Mask·Confirm 마스킹·Confirm 원문 유지의 세 그룹을 반환합니다. `createDocumentReview`는 여러 segment를 확인창에 표시하고, 승인 결과를 원래 segment ID와 offset으로 복원해 문서 처리기에 전달합니다. 텍스트 흐름도 같은 세 그룹 응답에서 마스킹 대상을 가져옵니다. 전송 직전 입력과 대화가 유지되는지 확인하며, 교체 또는 전송 버튼 확인이 실패하면 전송을 중단합니다.

## 명세에 없는 값

- `itemId`: Detector의 Detection 필드가 아닙니다. 이 명세에서는 사용하지 않습니다. `segmentId`, `type`, `span`으로 탐지 항목을 다시 연결합니다.
- `requestId`: Detector API에 정의된 값이 아닙니다. 단일 내부 요청/응답 흐름에는 필요하지 않아 이 명세에서는 사용하지 않습니다. 비동기 메시지 왕복에서 요청 식별이 필요해지면 별도 합의 후 추가합니다.
- `confidence`: Detector 응답에는 있지만 사용자의 마스킹 선택을 전달할 때는 불필요하므로 결정 응답에서 제외합니다.
- `word`: Detector 응답 필드가 아닙니다. Alert 표시를 위해 원문과 span에서 계산해 Alert 전달 데이터에 추가합니다.
- `span`: Detector 응답에 있는 실제 원문 위치이며, Confirm 결정을 특정 탐지에 연결하고 processor가 치환 위치를 찾기 위해 사용합니다.
- `segmentId`: 문서는 Detector가 반환한 segment 식별자를 쓰고, Text는 단일 segment의 ID인 `text`를 씁니다.
