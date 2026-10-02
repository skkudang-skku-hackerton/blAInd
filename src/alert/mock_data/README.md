# 확장 프로그램에서 Alert 테스트

`sample.ts`에는 한국어 원문과 모델 탐지 결과 모양의 목업 데이터가 있습니다.
전화번호·이메일은 처음에 체크되어 있고, 이름·사번은 체크되어 있지 않습니다. 모든 항목을 체크하거나 해제할 수 있습니다.
span은 원문에서 UTF-16 문자열 위치로 계산합니다.

`preview.ts`는 확장 프로그램의 content script에서 호출됩니다.
개발 모드에서 지원 사이트 화면 왼쪽 아래에 테스트 버튼이 나타납니다.
목업 선택 결과는 테스트 패널에 표시됩니다. 실제 입력창에 적용하거나 전송하지 않습니다.
배포용 `npm run build`에서는 테스트 패널이 활성화되지 않습니다.

## 실행

`blAInd` 폴더에서 의존성을 설치한 뒤 개발 확장을 실행합니다.

```powershell
npm ci
npm run dev
```

Chrome에서 `chrome://extensions`의 개발자 모드를 켜고
**압축해제된 확장 프로그램을 로드합니다**로 `.output/chrome-mv3-dev` 폴더를 선택합니다.
개발 서버는 켜 둡니다. 사이트가 이미 열려 있으면 새로고침합니다.

1. 왼쪽 아래 **blAInd · 목업 Alert 열기**를 누릅니다.
2. 이름 또는 사번을 체크하고, 전화번호·이메일은 필요에 따라 체크를 해제한 뒤 **선택 항목 가리고 진행**을 누릅니다.
3. `npm run dev`를 실행한 터미널에서 **최종 선택 결과** JSON을 확인합니다.
4. 다시 열고 **원문으로 진행**을 누르면 전화번호·이메일을 포함한 모든 항목이 `confirm.nonMasking`에 들어갑니다.
5. 취소 버튼, ESC, 확인창 바깥 클릭으로 취소 동작을 확인합니다.

실제 문서 업로드, 모델 추론, GPT 전송을 검증하는 테스트는 아닙니다.

## 터미널에 전달되는 데이터

Alert의 완료 콜백은 `status`, `autoMask`, `confirm.masking`, `confirm.nonMasking`을 반환합니다.
각 항목은 `segmentId`, `type`, `span`, `word`를 포함합니다. 원문 치환은 하지 않습니다.
취소 시에는 `{ "status": "cancelled" }`가 출력됩니다.

전달 경로는 Alert 콜백 → 확장 background 메시지 → WXT 개발 서버 → 터미널입니다.
`terminal-client.ts`와 `terminal-server.ts`는 개발 모드 목업 테스트용 연결입니다.
실제 Text/PDF/Word processor API가 아닙니다.
이 설정을 처음 추가한 뒤에는 실행 중인 개발 서버를 Ctrl+C로 종료하고
`npm run dev`로 다시 실행한 다음 확장과 ChatGPT 페이지를 새로고침합니다.

## 목업 데이터 검증

```powershell
node --experimental-strip-types src/alert/mock_data/mock_data.test.mjs
```
