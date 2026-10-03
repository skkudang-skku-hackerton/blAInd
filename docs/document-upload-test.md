# 문서 업로드 직접 테스트

ChatGPT, Claude, Gemini에서 PDF·DOCX 업로드 보호 흐름을 직접 확인하는 절차입니다.

```text
파일 선택·드롭·붙여넣기 차단 → 문서 Worker에서 텍스트 추출 → 페이지·문단별 모델 검사
  → 확인창에서 항목 선택 → 선택 결과 검증 → 마스킹된 새 파일 생성 → 사이트에 대체 첨부
```

문서 Worker는 Chrome에서 offscreen 문서, Firefox·Safari에서 background page에서 실행됩니다.
모든 처리는 확장 내부에서 이루어지며 외부 서버를 사용하지 않습니다.

## 절차

1. `npm run build` 후 `chrome://extensions`에서 `.output/chrome-mv3`를 로드하거나 새로고침합니다.
2. AI 사이트 탭을 새로고침하고 새 대화를 엽니다.
3. 개인정보가 들어 있는 PDF 또는 DOCX를 첨부합니다. 첫 검사는 모델 다운로드 시간이 걸립니다.
4. 처리 중에는 화면 가운데 로고와 파일명이 표시되고, 확인창을 닫기 전까지 사이트에 첨부가 생기지 않아야 합니다.
5. 확인창에서 버튼별 결과를 확인합니다.
   - **선택 항목 가리고 진행**: 체크한 항목만 가린 `masked-document.pdf` / `masked-document.docx`가 첨부됩니다.
     자동 마스킹 항목은 처음부터 체크되어 있습니다.
   - **원문으로 진행**: 아무 항목도 가리지 않지만, 원본이 아니라 메타데이터 등을 정리해 새로 만든 파일이 첨부됩니다.
   - **취소**: 첨부하지 않습니다.
6. 처리 중 다른 대화로 이동하거나 새 파일을 선택하면 이전 처리가 취소되고 첨부되지 않아야 합니다.

실패하면 화면 안내에 원인 종류와 "원본은 첨부되지 않았습니다"가 표시됩니다. Console의
`[blAInd] Document processing failed`에는 `stage`와 `code`만 기록되고 문서 내용은 기록되지 않습니다.

## 지원 범위

- 추출 가능한 가로 방향 텍스트 PDF, DOCX(OOXML)
- 스캔 PDF, 이미지가 포함된 PDF, 일부 텍스트 배치, 구형 `.doc`는 거부하고 첨부하지 않습니다.
- PDF·DOCX 외 파일(이미지, TXT 등)은 현재 검사 없이 그대로 첨부됩니다(`unhandled: 'passthrough'`).

형식별 세부 제한은 [PDF](../src/modules/documents/pdf/README.md),
[DOCX](../src/modules/documents/docx/README.md) 모듈 문서를 참고하세요.

## 개발 모드

`npm run dev`에서도 문서 처리 코드는 확장 내부에 번들링됩니다. 개발 서버에서 Worker를 직접
로드할 때의 출처·CSP 문제를 피하려고 offscreen HTML의 main 스크립트에 `wxt-ignore`를 사용합니다.
`npm run dev`를 재시작한 뒤 `.output/chrome-mv3-dev` 확장과 사이트 탭을 새로고침합니다.

## 자동 테스트

```sh
npm test
npm run build
npx playwright test tests/e2e/document-flow.spec.ts
DOCUMENT_FLOW_DEV=1 npx playwright test tests/e2e/document-flow.spec.ts   # 개발 빌드로 실행
```

통합 테스트는 고정된 탐지 결과와 실제 확장·offscreen·PDF/DOCX Worker를 사용합니다. 실제 모델의
탐지 정확도와 로그인된 사이트 서버 응답은 검증하지 않습니다.
