# blAInd

AI 채팅 서비스에 질문이나 문서를 보내기 **전에** 개인정보를 찾아내고, 사용자가 고른 항목만
가려서 전송하는 브라우저 확장 프로그램입니다. 개인정보 탐지 모델은 브라우저 안에서 실행되며,
채팅 원문과 첨부 문서를 외부 추론 서버로 보내지 않습니다.

## 주요 기능

- **전송 전 검사**: 등록된 AI 사이트에서 Enter 또는 전송 버튼을 누르면 원래 전송을 보류하고
  입력 내용을 로컬 모델로 검사합니다.
- **항목 선택 마스킹**: 탐지 결과를 확인창에 보여주고, 체크한 항목만 라벨로 치환해 전송합니다.
  탐지된 항목이 없으면 확인창 없이 원문을 그대로 전송합니다.
- **문서 업로드 보호**: PDF와 DOCX 업로드를 가로채 텍스트를 검사하고, 승인한 항목을 제거한
  **새 파일을 대신 첨부**합니다. 원본 파일은 업로드하지 않습니다.
- **유형별 정책**: 18가지 개인정보 유형마다 자동 마스킹 또는 확인 후 마스킹을 설정할 수 있습니다.
- **실패 시 안전**: 검사·재생성 오류, 취소, 검사 중 입력 변경 시에는 원문이나 원본 파일을 전송하지 않습니다.

## 지원 범위

| 구분 | 대상 |
| --- | --- |
| AI 사이트 | ChatGPT (`chatgpt.com`), Claude (`claude.ai`), Gemini (`gemini.google.com`) |
| 브라우저 | Chrome 116+ (MV3), Firefox 140+ (MV2), macOS Safari 16.4+ (MV2) |
| 업로드 문서 | 텍스트 기반 PDF, DOCX (OOXML) |
| 탐지 유형 | 이름, 주민등록번호, 외국인등록번호, 카드번호·유효기간·CVC, 계좌번호, 비밀번호·키, 사용자 ID, 이메일, 전화번호, 여권번호, 운전면허번호, 아이핀, 기타 식별번호, 주소, 우편번호, 날짜·시간 |

스캔 PDF(OCR 필요), 암호화 PDF, 구형 바이너리 `.doc`, iOS/iPadOS Safari는 지원하지 않습니다.
TXT/Markdown과 HWPX 처리 모듈은 구현되어 있지만 아직 사이트 업로드 흐름에 연결되지 않았습니다.

## 동작 방식

```text
텍스트: Enter / 전송 버튼 → 전송 보류 → 로컬 검사
          ├─ 탐지 없음 → 원문 전송
          └─ 탐지 있음 → 확인창에서 항목 선택 → 마스킹 후 전송 (취소 시 입력 상태 유지)

파일:   파일 선택·드롭 → 원본 업로드 보류 → 텍스트 추출 → 로컬 검사 → 항목 선택
          → 마스킹된 새 파일 생성·재검증 → 사이트에 대체 첨부
```

검사 요청은 `Content Script → Background → 추론 호스트 → Worker` 순서로 확장 내부에서만 전달됩니다.
추론 호스트는 Chrome에서 Offscreen Document, Firefox·Safari에서는 persistent background page입니다.

### 로컬 모델

| 구분 | Hugging Face 저장소 |
| --- | --- |
| 원 모델 | [`id4thomas/ko-pii-detector-ax-tokenclf`](https://huggingface.co/id4thomas/ko-pii-detector-ax-tokenclf) (`skt/A.X-Encoder-base` 기반 한국어 PII 토큰 분류) |
| ONNX 양자화 | [`tasoo/ko-pii-detector-ax-tokenclf-onnx`](https://huggingface.co/tasoo/ko-pii-detector-ax-tokenclf-onnx) (`model_int8.onnx`, `model_fp16.onnx`) |

확장은 ONNX 양자화 모델을 ONNX Runtime Web으로 실행합니다. 사용할 커밋과 파일별 SHA-256은
`src/core/detector/ko-pii/model-config.ts`에 고정되어 있습니다. 등록된 AI 페이지를 처음 열 때
Hugging Face에서 모델을 내려받아 검증한 뒤 Cache Storage에 저장하고, 이후에는 캐시를 재사용합니다.
기본 추론은 WASM 백엔드와 INT8 모델을 사용합니다. 런타임 옵션 `preferredBackend: 'webgpu'`를 주면
`shader-f16`을 지원하는 GPU에서 FP16 모델을 사용하고, 실패하면 WASM으로 대체합니다(Chrome 빌드만 해당).

## 시작하기

Node.js **22.12 이상**(`.nvmrc`: 22)과 npm이 필요합니다.

```sh
npm ci              # 의존성 설치 및 WXT 타입 생성
npm run dev         # 개발 모드 (Chrome)
npm run build       # Chrome · Firefox · Safari 번들 생성 (.output/)
```

### Chrome에 설치해 확인하기

1. `chrome://extensions`에서 개발자 모드를 켜고 **압축해제된 확장 프로그램을 로드합니다**로
   `.output/chrome-mv3`를 선택합니다. 코드를 바꾼 뒤에는 다시 빌드하고 확장 카드의 새로고침을 누릅니다.
2. 개인정보가 포함된 문장을 전송하면 `PII scan started` / `PII scan completed` 로그와 확인창이 나타납니다.
   로그에는 글자 수, 탐지 개수와 유형만 기록하고 원문은 기록하지 않습니다.

Background 로그는 확장 카드의 **서비스 워커** 검사 링크에서 볼 수 있습니다.

## 개발

| 명령 | 내용 |
| --- | --- |
| `npm test` | Vitest 단위 테스트 + Node 테스트 러너(LinkeDOM) 전송 인터셉트 테스트 |
| `npm run typecheck` | `wxt prepare` 후 `tsc --noEmit` |
| `npm run test:e2e` | Playwright E2E (`test:e2e:firefox`로 Firefox만 실행) |
| `npm run build:chrome` / `build:firefox` / `build:safari` | 브라우저별 빌드 |
| `npm run build:release` | 타입 검사 → 단위 테스트 → 세 브라우저 빌드 |
| `npm run zip` | 세 브라우저 ZIP과 Firefox 리뷰용 소스 ZIP 생성 |

`npm run build`는 번들만 생성하며 검사나 테스트를 실행하지 않습니다. 실제 사이트의 DOM 선택자,
업로드 대체 첨부, 확장 설치 후 모델 추론은 자동 테스트 범위 밖이므로 브라우저에서 직접 확인합니다.

### 디렉토리 구조

```text
src/
├── entrypoints/        # 확장 진입점
│   ├── app.content/    #   사이트 연동, 전송·업로드 인터셉트, 모델 사전 로딩
│   ├── background.ts   #   메시지 라우팅, Firefox·Safari 추론 호스트
│   ├── offscreen/      #   Chrome 추론·문서 Worker 실행 환경
│   ├── document-review/ #  문서 항목 선택 화면
│   └── popup/, options/ #  마스킹 정책 설정 화면
├── sites/registry.ts   # 확장이 실행될 사이트 URL
├── core/               # 사이트·문서 형식과 무관한 공통 기능
│   ├── api/            #   공개 탐지 API와 타입
│   ├── detector/       #   모델 다운로드·캐시, 토큰화, 추론, 후처리
│   ├── pii/            #   PII 유형, BIO 라벨, 기본 마스킹 정책
│   └── workflow/       #   검사·승인·전송 상태
├── modules/
│   ├── text/           #   공통 Enter·버튼 보류 (IME, 반복 입력, SPA 대응)
│   ├── sites/          #   사이트별 입력창 어댑터와 파일 업로드 인터셉터
│   └── documents/      #   PDF · DOCX · TXT/Markdown · HWPX 추출·마스킹·재생성
├── features/
│   ├── review/         #   텍스트 검사·확인·전송 흐름, 문서 검토
│   └── settings/       #   설정 UI
├── alert/              # 개인정보 확인창 UI와 마스킹 처리
├── platform/           # background page 추론 호스트
└── shared/             # 메시지 프로토콜, 추론 Worker, 설정 저장
tests/
├── unit/               # Vitest, node:test
└── e2e/                # Playwright
```

새 사이트를 추가하려면 `src/sites/registry.ts`에 origin을 등록하고, `src/modules/sites/<site>/`에
입력창 어댑터(`text.ts`)와 업로드 인터셉터(`file-upload/`)를 구현한 뒤 `text-adapters.ts`와
`app.content`에 연결합니다. Manifest의 `web_accessible_resources` 대상도 함께 갱신합니다.

## 문서

- [CI/CD 및 릴리스 가이드](docs/releases.md)
- [PII 탐지 모델 API](docs/pii-detection-model-api.md)
- [Alert 검토 API](docs/alert-review-api.md) · [문서 업로드 테스트](docs/document-upload-test.md)
- [공통 텍스트 모듈](src/modules/text/README.md)
- 문서 모듈: [PDF](src/modules/documents/pdf/README.md) · [DOCX](src/modules/documents/docx/README.md) ·
  [TXT/Markdown](src/modules/documents/text/README.md) · [HWPX](src/modules/documents/hwpx/README.md)
- [사이트 모듈과 업로드 인터셉터](src/modules/sites/README.md): [ChatGPT](src/modules/sites/chatgpt/file-upload/README.md) ·
  [Claude](src/modules/sites/claude/file-upload/README.md) · [Gemini](src/modules/sites/gemini/file-upload/README.md)
- [Firefox 소스 코드 리뷰 안내](SOURCE_CODE_REVIEW.md)
