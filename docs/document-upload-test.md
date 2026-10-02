# ChatGPT PDF / DOCX 직접 테스트

파일 인터셉터와 문서 처리기는 `app.content/index.ts`에서 연결됩니다.
처리 순서는 파일 선택/드롭/붙여넣기 차단 → offscreen 문서 Worker에서 추출 →
기존 PII 모델로 페이지/문단 검사 → 확인 모달 → 선택 결과 검증 →
문서 Worker에서 마스킹 파일 생성 → ChatGPT 첨부 이벤트 재발행입니다.
이 흐름의 문서 endpoint는 확장 내부 함수와 runtime 메시지이며 외부 HTTP 서버는 필요하지 않습니다.

1. `npm run build`를 실행합니다.
2. Chrome의 `chrome://extensions`에서 개발자 모드를 켜고 `.output/chrome-mv3`를
   압축 해제된 확장 프로그램으로 로드합니다. 이미 등록했다면 확장 새로고침을 누릅니다.
3. ChatGPT 탭도 새로고침하고 새 대화를 엽니다.
4. 직접 준비한 PDF 또는 DOCX를 첨부합니다. 첫 검사에는 모델 다운로드 시간이 필요합니다.
5. 확인 모달을 닫기 전에는 ChatGPT 첨부가 생기지 않아야 합니다.
6. 모델이 이름을 탐지했다면 체크 후 **선택 항목 가리고 진행**을 누릅니다.
   첨부 파일명은 `masked-document.pdf` 또는 `masked-document.docx`입니다.
7. **선택 없이 진행**은 확인 대상인 이름 등을 유지합니다. 전화번호/이메일 등의
   자동 보호 대상은 이 경우에도 마스킹됩니다. **취소**는 첨부를 중단합니다.
8. 이번 파일 흐름 테스트에서는 텍스트 입력창을 비운 상태로 전송 버튼을 누릅니다.
   기존 텍스트 전송 기능은 탐지 후 전송을 보류하는 상태이며, 텍스트의 승인·전송 재개는
   이번 문서 연결 변경의 범위에 포함하지 않았습니다.

지원 범위: 추출 가능한 수평 텍스트 PDF와 DOCX. 기존 PDF 모듈은 OCR이 필요한
스캔 PDF, 이미지가 포함된 PDF, 일부 텍스트 배치를 거부합니다. 구형 `.doc`는
DOCX 처리기에서 거부됩니다. 실패하거나 대화가 바뀌면 원본 대신 첨부하지 않습니다.
다른 파일 형식에는 기존 인터셉터의 passthrough 정책이 적용됩니다.

자동 검증: `npm test`, `npx tsc --noEmit`, `npm run build`,
`npx playwright test tests/e2e/document-flow.spec.ts`.
문서 통합 테스트는 고정 탐지 결과와 실제 Chrome 확장/offscreen/PDF/DOCX Worker를
사용하므로, 실제 모델의 탐지 정확도나 로그인된 ChatGPT 서버 응답까지 검증하지는 않습니다.
