# ChatGPT PDF 수동 테스트

## 실행

1. `blAInd` 폴더에서 `npm install`, `npm run build`를 실행합니다.
2. Chrome의 `chrome://extensions`에서 개발자 모드를 켜고 `.output/chrome-mv3`를 로드합니다. 이미 로드했다면 확장 카드의 새로고침을 누릅니다.
3. ChatGPT 탭도 새로고침합니다. 기존 content script가 남아 있으면 새 연결이 실행되지 않습니다.
4. `node scripts/create-pdf-test-file.mjs`로 합성 개인정보만 포함한 `tests/fixtures/pdf-flow-sample.pdf`를 생성합니다.
5. ChatGPT에 해당 PDF를 첨부합니다. 최초 실행은 탐지 모델 다운로드와 초기화 때문에 시간이 걸릴 수 있습니다.
6. 확인 모달에서 페이지별 이름 항목의 마스킹 여부를 선택합니다. 전화번호 등 자동 보호 항목은 항상 가립니다.
7. 승인하면 `masked-document.pdf`가 첨부됩니다. 취소하면 원본과 수정본 모두 첨부되지 않습니다.
8. PDF만 첨부하고 입력창은 비운 상태로 전송해 확인합니다. 기존 텍스트 전송 인터셉터는 아직 텍스트 전송을 보류하므로, 프롬프트까지 입력하는 통합 테스트는 이 변경 범위에 포함하지 않습니다.

PDF 선택·드롭·파일 붙여넣기 이벤트를 먼저 차단하고, 추출 → 실제 모델 탐지 → 확인 → 재생성 후 처리된 File을 재주입합니다. HTTP PDF 서버는 필요하지 않습니다. 최초 모델 다운로드 외에 문서 내용은 로컬에서 처리합니다.

## 지원 범위

- 텍스트 기반 PDF, 25 MiB 이하, 100페이지 이하.
- 스캔, 이미지/로고 포함 PDF, 회전 텍스트 등은 현재 PDF 엔진에서 보류합니다.
- Word 처리기는 구현되어 있지 않아 Word 및 기타 미지원 파일 첨부는 보류합니다.
- ChatGPT 파일 업로드 흐름에 연결했습니다. Claude/Gemini PDF 연결은 포함하지 않습니다.
- 네트워크 API 직접 호출 감시는 별도 모듈이며 이 변경은 파일 선택·드롭·붙여넣기 DOM 경로를 처리합니다.

## 확인할 로그

ChatGPT 개발자 도구 Console에서 다음 순서가 보여야 합니다. 개인정보 원문은 로그에 남기지 않습니다.

```text
[blAInd:pdf] extracting
[blAInd:pdf] scanning
[blAInd:pdf] reviewing
[blAInd:pdf] rebuilding
[blAInd:pdf] Masked PDF attached
```

`scanning`에서 오래 기다리는 경우 모델 다운로드 상태와 확장 Service Worker/offscreen 오류를 확인합니다. `extracting`에서 실패하면 PDF의 이미지 포함 여부와 지원 제한을 먼저 확인합니다.

## 자동 검증

```powershell
npm test
npm run typecheck
npm run build
npx playwright test tests/e2e/pdf-extension.spec.ts --output=test-results/pdf-extension
# 실제 모델까지 검사하려면 (최초 모델 다운로드 필요)
$env:PDF_REAL_MODEL_E2E='1'
npx playwright test tests/e2e/pdf-extension.spec.ts --output=test-results/pdf-real
```

실제 모델 테스트에서도 ChatGPT 서버는 테스트 HTML로 대체합니다. 사용자 계정에 메시지를 전송하지 않습니다. 테스트 페이지가 빌드 폴더에 추가되므로 수동 테스트 전 `npm run build`로 배포용 출력을 다시 생성합니다.
