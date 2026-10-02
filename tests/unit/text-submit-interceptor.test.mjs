import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { createTextSubmitInterceptor } from '../../src/modules/text/submit-interceptor.ts';
import { getTextSiteAdapter } from '../../src/modules/sites/text-adapters.ts';

function fixture(markup = '<div id="prompt-textarea" contenteditable="true"><p>안녕하세요</p></div>', siteId = 'chatgpt') {
  const { document, window } = parseHTML(`<html><body>${markup}</body></html>`);
  // LinkeDOM은 capture 순서를 구현하지 않습니다. 여기서는 취소·분기·DOM 탐색을 검증합니다.
  globalThis.HTMLElement = window.HTMLElement;
  const contexts = [];
  const errors = [];
  const interceptor = createTextSubmitInterceptor({
    adapter: getTextSiteAdapter(siteId),
    root: document,
    onIntercept: (context) => contexts.push(context),
    onError: (error) => errors.push(error),
  });
  interceptor.start();

  function dispatch(target, type = 'keydown', overrides = {}) {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, {
      key: 'Enter', keyCode: 13, shiftKey: false, ctrlKey: false,
      altKey: false, metaKey: false, repeat: false, isComposing: false,
      ...overrides,
    });
    target.dispatchEvent(event);
    return event;
  }

  return { document, window, interceptor, contexts, errors, dispatch };
}

test('Enter를 보류하고 원문의 공백·줄바꿈을 유지한 스냅샷을 전달한다', () => {
  const f = fixture('<textarea id="prompt-textarea">  김민수\n010-1234-5678  </textarea>');
  const editor = f.document.querySelector('textarea');
  let laterListenerCalled = false;
  f.document.addEventListener('keydown', () => { laterListenerCalled = true; });

  const event = f.dispatch(editor);

  assert.equal(event.defaultPrevented, true);
  assert.equal(laterListenerCalled, false);
  assert.equal(f.contexts.length, 1);
  assert.equal(f.contexts[0].text, '  김민수\n010-1234-5678  ');
  assert.equal(f.contexts[0].editor, editor);
  assert.equal(f.contexts[0].source, 'enter');
  assert.equal(editor.value, f.contexts[0].text);
});

test('등록된 세 사이트에서 입력창 내부 요소까지 찾는다', () => {
  const cases = [
    ['chatgpt', '<div id="prompt-textarea" contenteditable="true"><p>ChatGPT 입력</p></div>'],
    ['claude', '<div class="ProseMirror" contenteditable="true"><p>Claude 입력</p></div>'],
    ['gemini', '<rich-textarea><div class="ql-editor" contenteditable="true"><p>Gemini 입력</p></div></rich-textarea>'],
  ];
  for (const [siteId, markup] of cases) {
    const f = fixture(markup, siteId);
    assert.equal(f.dispatch(f.document.querySelector('p')).defaultPrevented, true);
    assert.equal(f.contexts[0].siteId, siteId);
    assert.equal(f.contexts[0].text, `${siteId === 'chatgpt' ? 'ChatGPT' : siteId === 'claude' ? 'Claude' : 'Gemini'} 입력`);
  }
});

for (const [name, markup] of [
  ['ID 없이 role="textbox"만 있는 입력창', '<div contenteditable="true" role="textbox"><p>테스트 입력</p></div>'],
  ['대체 textarea', '<textarea name="prompt-textarea">테스트 입력</textarea>'],
  ['ID가 바깥 래퍼에 있는 편집창', '<div id="prompt-textarea"><div contenteditable="true"><p>테스트 입력</p></div></div>'],
  ['빈 contenteditable 속성', '<div id="prompt-textarea" contenteditable><p>테스트 입력</p></div>'],
  ['plaintext-only 편집창', '<div id="prompt-textarea" contenteditable="plaintext-only"><p>테스트 입력</p></div>'],
]) {
  test(`ChatGPT ${name}의 Enter도 보류한다`, () => {
    const f = fixture(markup);
    const target = f.document.querySelector('p, textarea');
    assert.equal(f.dispatch(target).defaultPrevented, true);
    assert.equal(f.contexts[0].text, '테스트 입력');
  });
}

test('ChatGPT 선택자 주변의 편집 불가 요소와 다른 textarea는 차단하지 않는다', () => {
  const f = fixture('<div id="prompt-textarea"><p>설명 문구</p></div><textarea name="search">검색어</textarea><div role="textbox" contenteditable="false"><p>읽기 전용</p></div><div contenteditable="true"><p>다른 편집 영역</p></div>');
  for (const paragraph of f.document.querySelectorAll('p')) {
    assert.equal(f.dispatch(paragraph).defaultPrevented, false);
  }
  assert.equal(f.dispatch(f.document.querySelector('textarea')).defaultPrevented, false);
  assert.equal(f.contexts.length, 0);
});

test('Shift·Ctrl·Alt·Meta+Enter와 일반 키는 통과시킨다', () => {
  const f = fixture();
  const target = f.document.querySelector('p');
  for (const overrides of [
    { shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { key: 'a' },
  ]) {
    assert.equal(f.dispatch(target, 'keydown', overrides).defaultPrevented, false);
  }
  assert.equal(f.contexts.length, 0);
});

test('한글 조합 이벤트·isComposing·IME keyCode 229의 Enter는 통과시킨다', () => {
  const f = fixture();
  const target = f.document.querySelector('p');
  assert.equal(f.dispatch(target, 'keydown', { isComposing: true }).defaultPrevented, false);
  assert.equal(f.dispatch(target, 'keydown', { keyCode: 229 }).defaultPrevented, false);
  f.dispatch(target, 'compositionstart');
  assert.equal(f.dispatch(target).defaultPrevented, false);
  assert.equal(f.contexts.length, 0);
  f.dispatch(target, 'compositionend');
  assert.equal(f.dispatch(target).defaultPrevented, true);
  assert.equal(f.contexts.length, 1);
});

test('채팅창 밖의 Enter와 빈 입력·읽기 전용 입력은 통과시킨다', () => {
  const f = fixture('<textarea id="prompt-textarea"> \n </textarea><input id="other"><button>버튼</button>');
  const editor = f.document.querySelector('textarea');
  for (const target of [editor, f.document.querySelector('input'), f.document.querySelector('button')]) {
    assert.equal(f.dispatch(target).defaultPrevented, false);
  }
  editor.value = '전송할 내용';
  editor.setAttribute('readonly', '');
  assert.equal(f.dispatch(editor).defaultPrevented, false);
  editor.removeAttribute('readonly');
  editor.setAttribute('disabled', '');
  assert.equal(f.dispatch(editor).defaultPrevented, false);
  assert.equal(f.contexts.length, 0);
});

test('자동 반복 Enter는 차단하되 스냅샷 콜백을 반복 호출하지 않는다', () => {
  const f = fixture();
  const target = f.document.querySelector('p');
  f.dispatch(target);
  assert.equal(f.dispatch(target, 'keydown', { repeat: true }).defaultPrevented, true);
  assert.equal(f.contexts.length, 1);
});

test('보류한 Enter의 keypress·keyup도 차단하고 다음 Shift+Enter는 통과시킨다', () => {
  const f = fixture();
  const target = f.document.querySelector('p');
  f.dispatch(target);
  assert.equal(f.dispatch(target, 'keypress').defaultPrevented, true);
  assert.equal(f.dispatch(target, 'keyup').defaultPrevented, true);
  assert.equal(f.contexts.length, 1);
  assert.equal(f.dispatch(target, 'keydown', { shiftKey: true }).defaultPrevented, false);
  assert.equal(f.dispatch(target, 'keyup', { shiftKey: true }).defaultPrevented, false);
});

test('SPA에서 입력창을 교체해도 새 입력창의 Enter를 잡는다', () => {
  const f = fixture();
  f.document.querySelector('#prompt-textarea').remove();
  const editor = f.document.createElement('textarea');
  editor.id = 'prompt-textarea';
  editor.value = '새 대화 입력';
  f.document.body.append(editor);
  assert.equal(f.dispatch(editor).defaultPrevented, true);
  assert.equal(f.contexts[0].text, '새 대화 입력');
});

test('start 중복 호출은 콜백을 늘리지 않고 stop은 리스너를 제거한다', () => {
  const f = fixture();
  const target = f.document.querySelector('p');
  f.interceptor.start();
  f.dispatch(target);
  assert.equal(f.contexts.length, 1);
  f.interceptor.stop();
  assert.equal(f.dispatch(target).defaultPrevented, false);
  assert.equal(f.dispatch(target, 'keyup').defaultPrevented, false);
  f.interceptor.start();
  f.dispatch(target);
  assert.equal(f.contexts.length, 2);
});

test('읽기 또는 후속 콜백 실패 시에도 원래 Enter를 보류한다', () => {
  const f = fixture();
  f.interceptor.stop();
  const adapter = getTextSiteAdapter('chatgpt');
  const failure = new Error('test failure');
  for (const failReading of [true, false]) {
    const errors = [];
    const interceptor = createTextSubmitInterceptor({
      root: f.document,
      adapter: failReading ? { ...adapter, readText() { throw failure; } } : adapter,
      onIntercept() { throw failure; },
      onError: (error) => errors.push(error),
    });
    interceptor.start();
    assert.equal(f.dispatch(f.document.querySelector('p')).defaultPrevented, true);
    assert.deepEqual(errors, [failure]);
    interceptor.stop();
  }
});

for (const [siteId, editorMarkup, buttonMarkup, expectedText] of [
  ['chatgpt', '<textarea id="prompt-textarea">  김민수\n010-1234-5678  </textarea>', '<button data-testid="send-button" type="submit"><svg><path></path></svg></button>', '  김민수\n010-1234-5678  '],
  ['chatgpt', '<div role="textbox" contenteditable="true"><p>김민수</p><p>010-1234-5678</p></div>', '<button id="composer-submit-button"><span>전송</span></button>', '김민수\n010-1234-5678'],
  ['chatgpt', '<div role="textbox" contenteditable="true"><p>김민수</p><p>010-1234-5678</p></div>', '<button type="submit" aria-label="보내기"><svg class="icon-primary-action text-composer-primary"><path></path></svg></button>', '김민수\n010-1234-5678'],
  ['claude', '<div class="ProseMirror" contenteditable="true"><p>김민수</p><p>010-1234-5678</p></div>', '<button aria-label="Send Message"><svg><path></path></svg></button>', '김민수\n010-1234-5678'],
  ['gemini', '<rich-textarea><div class="ql-editor" contenteditable="true"><p>김민수</p><p>010-1234-5678</p></div></rich-textarea>', '<button class="send-button"><span>전송</span></button>', '김민수\n010-1234-5678'],
]) {
  test(`${siteId} 전송 버튼 내부 클릭도 보류하고 원문 스냅샷을 전달한다: ${buttonMarkup}`, () => {
    const f = fixture(`<form>${editorMarkup}${buttonMarkup}</form>`, siteId);
    const target = f.document.querySelector('button path, button span');
    const before = f.document.querySelector('form').innerHTML;
    let laterListenerCalled = false;
    f.document.addEventListener('click', () => { laterListenerCalled = true; });
    const event = f.dispatch(target, 'click');
    assert.equal(event.defaultPrevented, true);
    assert.equal(laterListenerCalled, false);
    assert.equal(f.contexts.length, 1);
    assert.equal(f.contexts[0].source, 'button');
    assert.equal(f.contexts[0].siteId, siteId);
    assert.equal(f.contexts[0].text, expectedText);
    assert.equal(f.document.querySelector('form').innerHTML, before);
  });
}

test('버튼의 키보드 활성화로 생긴 click도 같은 경로로 보류한다', () => {
  const f = fixture('<form><textarea id="prompt-textarea">테스트 입력</textarea><button data-testid="send-button">전송</button></form>');
  const button = f.document.querySelector('button');
  // 버튼의 Enter 기본 동작은 click을 발생시킵니다. 브라우저가 만드는 click을 여기서 재현합니다.
  assert.equal(f.dispatch(button).defaultPrevented, false);
  assert.equal(f.dispatch(button, 'click', { detail: 0 }).defaultPrevented, true);
  assert.equal(f.contexts.length, 1);
  assert.equal(f.contexts[0].source, 'button');
});

test('여러 입력창 중 클릭한 버튼과 같은 form의 원문만 읽는다', () => {
  const f = fixture('<form><textarea id="prompt-textarea">다른 대화</textarea></form><form><div role="textbox" contenteditable="true"><p>선택한 대화</p></div><button data-testid="send-button">전송</button></form>');
  assert.equal(f.dispatch(f.document.querySelector('button'), 'click').defaultPrevented, true);
  assert.equal(f.contexts[0].text, '선택한 대화');
});

test('form 없는 입력 영역은 가장 가까운 공통 부모에서 찾는다', () => {
  const f = fixture('<section><div role="textbox" contenteditable="true">다른 대화</div></section><section><div><div role="textbox" contenteditable="true">선택한 대화</div></div><footer><button aria-label="Send">전송</button></footer></section>');
  assert.equal(f.dispatch(f.document.querySelector('button'), 'click').defaultPrevented, true);
  assert.equal(f.contexts[0].text, '선택한 대화');
});

test('버튼과 연결된 form 밖의 입력창으로 대체하지 않는다', () => {
  const f = fixture('<div role="textbox" contenteditable="true">다른 대화</div><form><button data-testid="send-button">전송</button></form>');
  assert.equal(f.dispatch(f.document.querySelector('button'), 'click').defaultPrevented, true);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.errors.length, 1);
});

test('입력창이 없거나 같은 영역의 입력창이 여러 개면 클릭을 보류한다', () => {
  for (const editors of ['', '<textarea id="prompt-textarea">첫 입력</textarea><div role="textbox" contenteditable="true">둘째 입력</div>']) {
    const f = fixture(`<form>${editors}<button data-testid="send-button">전송</button></form>`);
    assert.equal(f.dispatch(f.document.querySelector('button'), 'click').defaultPrevented, true);
    assert.equal(f.contexts.length, 0);
    assert.equal(f.errors.length, 1);
  }
});

test('숨겨진 보조 입력창을 제외하고 화면의 원문을 선택한다', () => {
  const f = fixture('<form><textarea name="prompt-textarea" hidden>보조 입력</textarea><textarea name="prompt-textarea" id="layout-hidden">숨겨진 입력</textarea><div role="textbox" contenteditable="true">현재 입력</div><button data-testid="send-button">전송</button></form>');
  f.document.querySelector('#layout-hidden').getClientRects = () => [];
  assert.equal(f.dispatch(f.document.querySelector('button'), 'click').defaultPrevented, true);
  assert.equal(f.contexts[0].text, '현재 입력');
});

test('읽기 전용 입력창뿐이면 원문을 전송하지 않고 클릭을 보류한다', () => {
  const f = fixture('<form><textarea id="prompt-textarea" readonly>읽기 전용</textarea><button data-testid="send-button">전송</button></form>');
  assert.equal(f.dispatch(f.document.querySelector('button'), 'click').defaultPrevented, true);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.errors.length, 1);
});

test('파일만 첨부 가능한 빈 입력창의 전송 버튼은 텍스트 흐름에서 통과시킨다', () => {
  const f = fixture('<form><textarea id="prompt-textarea"> \n </textarea><button data-testid="send-button">전송</button></form>');
  assert.equal(f.dispatch(f.document.querySelector('button'), 'click').defaultPrevented, false);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.errors.length, 0);
});

test('첨부·음성·기타 버튼과 비활성 전송 버튼은 통과시킨다', () => {
  const f = fixture('<form><textarea id="prompt-textarea">테스트 입력</textarea><button aria-label="파일 등 추가">첨부</button><button aria-label="음성 입력">음성</button><button aria-label="음성 대화 시작">대화</button><button type="submit">다른 동작</button><button data-testid="send-button" disabled>전송</button><button data-testid="send-button" aria-disabled="true">전송</button></form>');
  for (const button of f.document.querySelectorAll('button')) {
    assert.equal(f.dispatch(button, 'click').defaultPrevented, false);
  }
  assert.equal(f.contexts.length, 0);
  assert.equal(f.errors.length, 0);
});

test('전송 버튼 ID·클래스를 재사용하는 생성 중지 버튼은 통과시킨다', () => {
  const cases = [
    ['chatgpt', '<div role="textbox" contenteditable="true">다음 입력</div>', '<button id="composer-submit-button" data-testid="stop-button">중지</button>'],
    ['chatgpt', '<div role="textbox" contenteditable="true">다음 입력</div>', '<button id="composer-submit-button" aria-label="Stop generating">중지</button>'],
    ['gemini', '<rich-textarea><div class="ql-editor" contenteditable="true">다음 입력</div></rich-textarea>', '<button class="send-button" aria-label="응답 중지">중지</button>'],
    ['gemini', '<rich-textarea><div class="ql-editor" contenteditable="true">다음 입력</div></rich-textarea>', '<button class="send-button stop-button">중지</button>'],
  ];
  for (const [siteId, editorMarkup, buttonMarkup] of cases) {
    const f = fixture(`<form>${editorMarkup}${buttonMarkup}</form>`, siteId);
    assert.equal(f.dispatch(f.document.querySelector('button'), 'click').defaultPrevented, false);
    assert.equal(f.contexts.length, 0);
  }
});

test('SPA에서 입력 영역·버튼을 교체해도 새 원문을 읽는다', () => {
  const f = fixture('<form><textarea id="prompt-textarea">이전 입력</textarea><button data-testid="send-button">전송</button></form>');
  f.document.querySelector('form').remove();
  f.document.body.innerHTML = '<form><div role="textbox" contenteditable="true">새 대화 입력</div><button data-testid="send-button">전송</button></form>';
  assert.equal(f.dispatch(f.document.querySelector('button'), 'click').defaultPrevented, true);
  assert.equal(f.contexts[0].text, '새 대화 입력');
});

test('클릭 리스너도 start 중복 등록과 stop·재시작을 처리한다', () => {
  const f = fixture('<form><textarea id="prompt-textarea">테스트 입력</textarea><button data-testid="send-button">전송</button></form>');
  const button = f.document.querySelector('button');
  f.interceptor.start();
  assert.equal(f.dispatch(button, 'click').defaultPrevented, true);
  assert.equal(f.contexts.length, 1);
  f.interceptor.stop();
  assert.equal(f.dispatch(button, 'click').defaultPrevented, false);
  assert.equal(f.contexts.length, 1);
  f.interceptor.start();
  assert.equal(f.dispatch(button, 'click').defaultPrevented, true);
  assert.equal(f.contexts.length, 2);
});

test('입력창 탐색·읽기·후속 콜백 오류가 나도 클릭 전송을 보류한다', () => {
  const f = fixture('<form><textarea id="prompt-textarea">테스트 입력</textarea><button data-testid="send-button">전송</button></form>');
  f.interceptor.stop();
  const adapter = getTextSiteAdapter('chatgpt');
  const failure = new Error('test failure');
  for (const stage of ['find', 'read', 'callback']) {
    const errors = [];
    const interceptor = createTextSubmitInterceptor({
      root: f.document,
      adapter: {
        ...adapter,
        ...(stage === 'find' ? { findEditorForSendButton() { throw failure; } } : {}),
        ...(stage === 'read' ? { readText() { throw failure; } } : {}),
      },
      onIntercept() { throw failure; },
      onError: (error) => errors.push(error),
    });
    interceptor.start();
    assert.equal(f.dispatch(f.document.querySelector('button'), 'click').defaultPrevented, true);
    assert.deepEqual(errors, [failure]);
    interceptor.stop();
  }
});
