# 공통 텍스트 전송 인터셉트

`createTextSubmitInterceptor()`는 사이트 어댑터가 인식한 입력창의 Enter와 전송 버튼 클릭을 동기적으로 보류하고, 전송 시점의 원문을 `onIntercept`에 전달합니다. 원문을 수정하거나 모델을 호출하거나 질문을 다시 보내지는 않습니다.

```ts
import { createTextSubmitInterceptor } from './index';
import { getTextSiteAdapter } from '../sites/text-adapters';

const interceptor = createTextSubmitInterceptor({
  adapter: getTextSiteAdapter('chatgpt'),
  onIntercept({ text, editor, siteId, source }) {
    // source는 'enter' 또는 'button'입니다. 이후 처리는 공통으로 연결합니다.
    // text 검사 → 탐지가 없으면 원문 전송, 있으면 항목 선택 후 교체·전송.
    // 검사하는 동안 입력창이 바뀔 수 있으므로 전달된 원문을 기준으로 검사합니다.
  },
  onError(error) {
    // 원래 전송 이벤트는 보류되어 있습니다. 실패했다고 자동 전송하지 않습니다.
  },
});

interceptor.start();
// Content Script 무효화 시:
interceptor.stop();
```

## 파일 역할

| 파일 | 역할 |
| --- | --- |
| `submit-interceptor.ts` | Window capture에서 Enter·클릭 차단, IME·줄바꿈 구분, 반복 입력 처리 |
| `enter-interceptor.ts` | 기존 `createTextEnterInterceptor` import를 위한 별칭 |
| `site-adapter.ts` | 입력창·전송 버튼 탐색, 버튼에 연결된 입력창 선택, 원문 읽기 |
| `types.ts` | 사이트 어댑터와 전송 스냅샷·입력 방식 인터페이스 |
| `index.ts` | 공통 모듈 공개 API |
| `../sites/*/text.ts` | 사이트마다 다른 입력창·전송 버튼 선택자 |
| `../sites/text-adapters.ts` | 등록 사이트와 텍스트 어댑터 연결 |

입력창 DOM을 저장하지 않고 이벤트마다 다시 찾으므로, SPA 페이지에서 입력창이 나중에 생기거나 새 대화로 교체되어도 처리할 수 있습니다.

ChatGPT는 `#prompt-textarea`와 그 안의 편집창, `textarea[name="prompt-textarea"]`, ID 없이 `role="textbox"`와 `contenteditable`만 있는 입력창을 인식합니다. 편집 가능 여부는 `contenteditable` 속성과 브라우저의 `isContentEditable`로 확인하며, `contenteditable="false"` 요소는 제외합니다.

Claude의 선택자는 `.ProseMirror[contenteditable="true"]`, Gemini는 `rich-textarea .ql-editor[contenteditable="true"]`입니다. 실제 로그인한 페이지에서 확인이 필요하며, 사이트가 DOM을 바꾸거나 동일한 선택자를 다른 편집창에 사용하면 해당 사이트 어댑터를 수정합니다.

전송 버튼은 ChatGPT의 `data-testid="send-button"`, `#composer-submit-button`, `aria-label="보내기"` 등의 라벨, Claude의 `aria-label="Send message"` 등의 라벨, Gemini의 `.send-button`, `data-test-id="send-button"` 등의 선택자로 찾습니다. 현재 ChatGPT 화면에서 확인한 `type="submit"`, `aria-label="보내기"` 버튼도 인식합니다. 모든 submit 버튼을 전송 버튼으로 취급하지는 않습니다.

클릭에서는 버튼에 연결된 form 안의 표시된 입력창을 사용합니다. form이 없으면 가장 가까운 공통 부모에서 입력창을 찾습니다. 숨겨진 보조 textarea는 제외하며, 입력창이 없거나 한 영역에 여러 입력창이 있어 모호하면 전송을 보류하고 오류를 알립니다. DOM 참조를 저장하지 않으므로 버튼이 다시 생성되어도 새 버튼을 찾습니다.

## 현재 처리 범위

- 텍스트가 있는 입력창의 일반 Enter와 인식한 전송 버튼 클릭을 보류합니다. 입력 내용은 그대로 유지합니다.
- 버튼 내부의 아이콘 클릭과 키보드 활성화로 발생하는 click도 같은 흐름을 사용합니다. 생성 중지·비활성 버튼은 제외합니다.
- 보류한 Enter의 `keypress`·`keyup`도 차단하고, 키를 길게 눌러 발생하는 반복 입력은 다시 콜백에 전달하지 않습니다.
- Shift+Enter, Ctrl/Alt/Meta+Enter, 한글 조합 중 Enter는 통과시킵니다.
- 빈 입력과 공백만 있는 입력, 채팅 선택자에 해당하지 않는 요소의 Enter는 통과시킵니다. 파일만 첨부된 메시지는 별도 문서 흐름의 대상입니다.
- 읽기 또는 콜백 오류가 발생해도 원문을 자동 전송하지 않습니다.

Content 진입점은 `features/review/text-scan.ts`의 검사 컨트롤러에 전송 시점의 원문을 전달합니다. 컨트롤러는 공개 모델 클라이언트의 `scanText(text, { signal })`을 호출하고 원문과 탐지 구간을 함께 `onResult`로 전달합니다. 완료된 결과는 `scanner.getResult()`로도 얻을 수 있습니다. 원문·URL·입력창·대화 ID가 변경된 결과는 폐기하며, 새 검사나 확장 무효화 시 이전 요청을 취소합니다.

원문은 확장 내부 모델 요청에 사용하며 외부 추론 서버로 전송하지 않습니다. 콘솔에는 사이트명·글자 수·탐지 개수·유형만 기록하고 원문과 탐지된 값은 기록하지 않습니다. 텍스트 모델 준비와 검사는 팝업 없이 진행합니다. 텍스트 검사에 성공하고 탐지가 0개이면 확인창이나 전송 안내 팝업 없이 원문을 바로 전송합니다. 탐지 항목이 있으면 확인창에서 승인 후 전송하며, 오류 시에는 안내를 표시합니다. 항목 선택 취소나 입력·대화 변경에 따른 검사 결과 폐기는 별도 안내 없이 처리합니다. 안내의 닫기 버튼은 안내만 닫습니다.

자동 전송과 승인 후 전송 모두 입력창·원문·대화를 다시 확인하고 전송 버튼을 한 번 호출합니다. 검사 오류나 검사 중 입력·대화 변경 시에는 전송하지 않습니다. Ctrl/Alt/Meta+Enter에 의한 전송은 후속 단계입니다. 사이트가 click 이전의 포인터 이벤트나 별도 경로로 전송하는 경우도 실제 페이지에서 확인해야 합니다.

## 확인

`npm test`는 Vitest 테스트와 함께 이 인터셉터의 Node 테스트(`tests/unit/text-submit-interceptor.test.mjs`)를 실행합니다. 인터셉터 테스트만 실행하려면 `npm run test:node`를 사용합니다.

LinkeDOM은 브라우저의 capture 순서와 기본 form 제출을 구현하지 않으므로 실제 페이지의 전송 차단 여부는 Chrome에서도 확인합니다.

1. `npm run build` 후 확장과 AI 페이지를 새로고침합니다.
2. 채팅 입력창에 테스트 문장을 쓰고 Enter를 누릅니다.
3. 검사 중 질문이 전송되지 않고 원문이 남으며, 팝업 없이 `[blAInd] Enter intercepted: <사이트명>` 로그가 나타나는지 확인합니다. 최초 검사에서는 약 483 MB의 INT8 모델을 다운로드하므로 준비 시간이 필요합니다.
4. `[blAInd] PII scan started` 이후 `PII scan completed`와 탐지 개수·유형을 확인합니다. 예: `김민수의 연락처는 010-1234-5678입니다.` Alert에서 가릴 항목을 선택하고 진행하면 최종 체크된 항목만 마스킹한 텍스트로 입력창을 교체하고 전송 버튼을 한 번 호출합니다. Auto Mask 항목도 처음에 체크된 상태에서 해제할 수 있습니다. 취소하면 전송하지 않습니다. 콘솔의 `[blAInd] Approved text send requested`는 전송 버튼 호출을 의미하며 서버 수신 완료를 보장하지 않습니다.
5. 전송 버튼을 직접 눌러 같은 검사 흐름과 `[blAInd] Send button intercepted: <사이트명>` 로그가 나타나는지 확인합니다. 아이콘을 눌러도 동일해야 합니다.
6. Shift+Enter로 줄바꿈이 되고 한글 조합 확정이 유지되는지 확인합니다. 첨부·음성·생성 중지 버튼도 정상 동작해야 합니다.
7. 검사 중 입력을 수정하거나 다른 대화로 이동하면 결과가 폐기되는지, 새 대화에서 다시 검사할 수 있는지 확인합니다.
8. 탐지 결과가 0개인 문장은 검사부터 전송까지 팝업 없이 원문 그대로 한 번 전송되고 `[blAInd] No-detection text send requested`가 기록되는지 확인합니다. Enter와 전송 버튼 모두 확인합니다.

키보드 조합 여부는 [KeyboardEvent.isComposing](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing), 전파 차단은 [Event.stopImmediatePropagation](https://developer.mozilla.org/en-US/docs/Web/API/Event/stopImmediatePropagation)을 사용합니다.
