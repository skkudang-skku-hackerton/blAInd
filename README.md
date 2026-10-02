# blAInd

AI 웹사이트에 질문을 보내기 전에 개인정보를 감지하고, 사용자 선택에 따라 마스킹하는 크롬 확장 프로그램입니다. 텍스트 검사와 모델 추론은 사용자 기기에서 처리하도록 개발합니다.

## 예정 기술 스택

- 확장 프로그램: WXT, Manifest V3
- 화면: React, TypeScript
- 로컬 추론: ONNX Runtime Web, Web Worker
- 추론 환경: Offscreen Document, WebGPU 또는 WASM
- 설정 저장: `chrome.storage.local`

모델 개발은 별도 레포에서 진행합니다. 이 레포는 전달받은 모델과 토크나이저를 브라우저에서 실행하고, 탐지 결과를 마스킹 및 전송 흐름에 연결합니다. 브라우저 실행 호환성은 실제 모델 연결 단계에서 확인합니다.

모델 라이브러리 API는 `docs/pii-detection-model-api.md`를 참고해주세요. 브라우저 검증 절차와 실행 기록은 `docs/pii-model-verification.md`에 있습니다.

### PII 탐지기 사용

공개 진입점은 `src/core/api/index.ts`입니다. 다른 모듈은 내부 RPC/ONNX 구현을 몰라도 아래처럼 사용합니다.

```ts
import { createPiiDetectorClient, PiiError } from '../../core/api';

const detector = createPiiDetectorClient();
await detector.initialize();

// 짧은 입력
const detections = await detector.scanText(text);

// 문서 모듈이 나눈 세그먼트 (PDF page, DOCX paragraph 등)
const results = await detector.scanSegments(segments);

// 요청별 취소 (전송 흐름에서 전달받은 signal을 그대로 전달)
const controller = new AbortController();
try {
  const cancelled = await detector.scanSegments(segments, { signal: controller.signal });
} catch (error) {
  if (error instanceof PiiError && error.code === 'CANCELLED') {
    // 원본을 전송하지 않고 중단
  } else throw error;
}
```

`initialize()`는 자동으로 호출되므로 먼저 부르지 않아도 됩니다. 모델 다운로드 진행 상태는 `detector.onStatus(listener)`로 구독할 수 있고, `detector.dispose()`는 이 클라이언트의 리스너와 대기 요청만 정리하며 공유 모델은 내려가지 않습니다.

모델은 최초 초기화 시 Hugging Face에서 내려받아 브라우저 Cache Storage에 캐시하고, 이후에는 캐시를 재사용합니다. 사용할 버전과 파일은 `src/core/detector/ko-pii/model-config.ts`에서 커밋으로 고정합니다.

## 실행 및 메시지 통신 확인

Node.js **22.12 이상**과 npm을 사용합니다. `.nvmrc`는 Node.js 22를 지정합니다. WSL에서는 Node.js와 npm을 모두 WSL 환경에 설치해 사용합니다.

```bash
npm ci
npm run typecheck
npm run build
```

1. 크롬 `chrome://extensions`에서 개발자 모드를 켜고, **압축해제된 확장 프로그램을 로드합니다**로 `.output/chrome-mv3`를 선택합니다.
2. 이미 로드했다면 blAInd 카드의 새로고침 버튼을 누릅니다. 새 Background 설정을 반영하려면 확장도 다시 로드해야 합니다.
3. 등록된 AI 페이지의 개발자 도구에서 Console을 열고 페이지를 새로고침합니다.
4. 다음 로그가 표시되는지 확인합니다. 사이트 이름과 버전은 실행 환경에 따라 달라집니다.

```text
[blAInd] Content Script ready: ChatGPT
[blAInd] Background connected: 0.1.0
```

확장 카드의 **서비스 워커** 검사 링크를 열면 Background 콘솔의 `[blAInd] Background ready` 로그도 확인할 수 있습니다. 서비스 워커는 유휴 상태에서 종료될 수 있으며, 메시지를 받으면 다시 실행됩니다.

현재 등록 URL은 `https://chatgpt.com/*`, `https://claude.ai/*`, `https://gemini.google.com/*`이며 `src/sites/registry.ts`에서 관리합니다. URL을 추가하거나 코드를 변경한 뒤에는 다시 빌드하고 확장과 페이지를 새로고침합니다. 개발 모드는 `npm run dev`로 실행합니다.

## 진입점과 메시지 규약

```text
app.content → GET_BACKGROUND_STATUS → background
app.content ← BACKGROUND_STATUS     ← background
```

`shared/messaging/protocol.ts`는 요청·응답 타입과 런타임 검증, `client.ts`는 Content에서 사용할 요청 함수를 담당합니다. Background는 `target: 'background'`와 요청 종류가 일치할 때만 응답하고, 다른 진입점의 메시지는 처리하지 않습니다. Content는 응답을 검증하고 연결 오류를 콘솔에 표시합니다.

이 상태 확인 메시지는 채팅 내용이나 파일을 포함하지 않습니다. `ready`는 Background가 메시지에 응답할 준비가 되었다는 뜻이며 모델의 로딩 상태를 나타내지는 않습니다.

## 사용자 흐름

```text
AI 웹페이지에서 텍스트 입력 → Enter 또는 전송 버튼
  → 원래 전송 보류 → 로컬 개인정보 검사
      ├─ 민감정보 없음 → 원문 전송
      └─ 민감정보 있음 → 사용자 확인
                            ├─ 마스킹 동의 → 내용 교체 후 전송
                            ├─ 원문 전송 선택 → 원문 전송
                            └─ 취소 → 입력 상태로 복귀
```

검사 중 중복 전송, 한글 조합 중 Enter, 줄바꿈, 검사 후 입력 변경을 구분합니다. 검사 오류가 발생하면 전송을 보류하도록 구현합니다.

## 디렉토리

```text
blAInd/
├── src/
│   ├── entrypoints/          # 확장 프로그램 진입점
│   │   ├── background.ts     # 상태 확인 요청 응답
│   │   ├── app.content/      # 웹페이지 감지 및 사이트 연동 시작
│   │   │   └── index.ts      # 사이트 초기화, Background 연결 확인
│   │   ├── offscreen/        # 로컬 추론 Worker 실행 환경
│   │   └── popup/            # 확장 활성화 및 설정 화면
│   ├── sites/
│   │   └── registry.ts       # 진입점 실행 대상 URL 관리
│   ├── core/                 # 사이트·문서 형식에 독립적인 공통 기능
│   │   ├── api/              # 모듈의 검사 요청·응답 규약과 처리
│   │   ├── detector/         # 모델 로딩, 토큰화, 추론 및 개발용 탐지기
│   │   ├── pii/              # 탐지 결과 타입과 공통 텍스트 마스킹
│   │   └── workflow/         # 검사·승인·취소 상태와 전송 허가 관리
│   ├── modules/              # 사이트별·문서 종류별 확장 모듈
│   │   ├── sites/
│   │   │   └── chatgpt/      # 입력·문서 인터셉트, 교체·전송 및 대체 첨부
│   │   └── documents/
│   │       ├── pdf/          # PDF 추출·마스킹·재생성
│   │       ├── docx/         # 추후 Word 문서 처리
│   │       └── hwpx/         # 추후 HWPX 문서 처리
│   ├── features/
│   │   └── review/           # 공통 탐지 결과·사용자 확인 UI
│   └── shared/
│       ├── messaging/        # 확장 내부 메시지 전달
│       │   ├── protocol.ts   # 요청·응답 타입과 런타임 검증
│       │   └── client.ts     # Background 상태 확인 요청
│       └── settings/         # 공통 설정·저장
├── tests/
│   ├── unit/                 # 추후 마스킹·상태 전이 단위 테스트
│   └── e2e/                  # 추후 사이트별 전체 전송 흐름 테스트
├── .gitignore
├── .nvmrc
├── package.json
├── package-lock.json
├── tsconfig.json
├── wxt.config.ts
└── README.md
```

`src/entrypoints/`는 시작과 연결을 담당합니다. 사이트·문서 인터셉트는 `modules/`, 검사는 `core/`, 메시지 전달은 `shared/messaging/`에서 구현합니다. `.wxt/`, `.output/`, `node_modules/`는 자동 생성되며 Git에 포함하지 않습니다.

## 코어와 모듈의 연결

모듈은 **사이트별 모듈**과 **문서 종류별 모듈**로만 구분합니다. 개인정보 탐지기는 코어에 두고 모든 모듈이 재사용합니다.

- 코어: 공통 검사 API, 모델 추론, 탐지 결과, 마스킹, 승인·전송 상태를 담당합니다. 사이트 DOM이나 문서 내부 구조에는 의존하지 않습니다.
- 사이트 모듈: 입력 읽기·교체·전송, 원본 파일 업로드 보류, 처리된 파일 첨부를 담당합니다.
- 문서 모듈: 텍스트 추출, 원본 문서 위치 매핑, 개인정보 제거·치환, 새 파일 생성과 검증을 담당합니다. 사이트에 직접 업로드하지 않습니다.

코어 API는 별도 HTTP 서버가 아니라 **확장 내부 검사 요청·응답 인터페이스**로 구성할 계획입니다. 모듈은 요청 ID와 텍스트 세그먼트를 보내고, 코어는 세그먼트 ID·문자 구간·개인정보 종류를 포함한 탐지 결과를 반환합니다. 문서별 좌표나 요소 정보는 문서 모듈 내부에서 관리합니다.

```text
텍스트: 사이트 모듈 → 코어 검사 → 사용자 승인 → 입력 교체·전송

파일: 사이트 모듈에서 원본 업로드 보류
        → 문서 모듈에서 텍스트 추출 → 코어 검사 → 사용자 승인
        → 문서 모듈에서 새 파일 생성·검증 → 사이트 모듈에서 대체 첨부
```

검사 중 입력이나 첨부 파일이 바뀌면 이전 결과를 폐기하고 재검사합니다. 검사·재생성 오류가 발생해도 원본을 자동 전송하거나 업로드하지 않습니다.

## 팀 작업 경계

| 작업 | 주로 수정할 경로 | 연결할 부분 |
| --- | --- | --- |
| 확장 기반·설정 | `src/shared/`, 실행 환경 구성 시 `src/entrypoints/` | 메시지 전달, 추론 환경 수명 관리 |
| 공통 검사 API | `src/core/api/` | 모듈 요청·응답 규약 |
| 모델 연결·마스킹 | `src/core/detector/`, `src/core/pii/` | 별도 모델 레포의 산출물 |
| 전송 흐름·확인창 | `src/core/workflow/`, `src/features/review/` | 사용자 승인, 결과 유효성, 전송 허가 |
| 사이트 연동 | `src/modules/sites/` | 입력 읽기·교체·전송, 업로드 보류·대체 첨부 |
| 문서 지원 | `src/modules/documents/` | 텍스트 추출, 위치 매핑, 안전한 파일 재생성 |

URL 등록은 확장이 실행될 페이지를 정합니다. 각 사이트의 입력창과 전송 방식 차이는 `modules/sites/`에서 처리하고, 개인정보 검사는 코어 API를 통해 요청합니다. 공통 승인 흐름과 확인 UI를 재사용합니다.

병렬 개발 전에 코어 검사 API, 사이트·문서 모듈 인터페이스, 확장 내부 메시지와 탐지 결과 타입을 함께 정합니다. 탐지 구간은 각 세그먼트의 JavaScript `text.slice(start, end)`와 일치하도록 UTF-16 코드 단위 기준으로 맞춥니다. 모델이 준비되기 전에는 코어에 개발용 가짜 탐지기를 연결해 화면과 전송 흐름을 개발할 수 있습니다.

## 문서 지원 계획

PDF를 첫 문서 모듈로 구현하고 이후 DOCX·HWPX로 확장할 계획입니다. 파일 선택·드롭 단계에서 원본 업로드를 보류하고, 사용자 동의 후 **마스킹된 새 파일을 생성하여 사이트에 첨부**합니다. 메시지 전송만 막거나 이미 업로드된 파일을 삭제하는 것으로는 원본 유출을 방지할 수 없습니다. 실제 사이트에서 업로드 보류와 대체 첨부가 가능한지 먼저 검증합니다.

`modules/documents/`는 추출한 텍스트와 원본 문서 위치의 연결, 내용 제거·치환, 파일 재생성을 담당합니다. 개인정보 탐지는 코어를 재사용하고 재생성 방식은 문서 형식별로 구현합니다.

### PDF 처리 방향

초기에는 텍스트 기반 PDF를 대상으로 다음 방식을 구현할 계획입니다.

1. 페이지별 텍스트·읽기 순서·좌표를 추출하고 코어에 검사를 요청합니다.
2. 페이지를 이미지로 렌더링하고 민감 영역을 이미지 픽셀 자체에서 제거합니다.
3. 마스킹된 이미지와 개인정보를 제거한 비표시 텍스트 레이어로 새 PDF를 생성합니다.
4. 새 PDF의 텍스트를 다시 추출해 검사하고 이미지 마스킹도 별도로 검증합니다.

원본 텍스트 레이어, 메타데이터, 첨부 객체는 새 PDF에 복사하지 않습니다. 텍스트 레이어는 검색·복사·텍스트 기반 분석을 위한 것으로, LLM에 지시하는 숨김 문구를 넣지 않습니다. 읽기 순서, 한글 폰트·Unicode 매핑과 실제 GPT 파일 처리 호환성은 구현 단계에서 검증합니다. 스캔 PDF는 OCR이 필요하므로 초기 지원 범위에서 제외하고, 암호화 등 지원하지 않는 파일은 업로드를 보류한 채 사용자에게 안내합니다.

## 개발 시작 순서

1. 구현된 Content·Background 통신을 확인하고 코어 API와 사이트·문서 인터셉트 모듈 인터페이스를 정합니다.
2. 코어의 개발용 탐지기로 사이트 하나의 전송 보류·확인창·전송 흐름을 완성합니다.
3. 원본 PDF 업로드 보류·대체 첨부를 검증하고 PDF 추출·마스킹·재생성을 연결합니다.
4. 별도 레포의 모델을 연결하고 로컬 추론을 확인합니다.
5. 사이트 모듈과 DOCX·HWPX 문서 모듈을 추가합니다.

`tests/`에는 현재 `.gitkeep`만 있습니다. 테스트 환경을 정한 뒤 동의 전 전송·원본 업로드 방지, 승인된 내용의 한 번만 전송, 입력·첨부 변경 시 재검사, 재생성 파일의 개인정보 잔존 여부 등을 검증합니다.
