import { createDomTextAdapter } from '../../text/site-adapter.ts';

// ChatGPT는 입력창에 ID 없이 role="textbox"만 제공하는 화면도 있습니다.
const editorSelector = [
  '#prompt-textarea',
  '#prompt-textarea [contenteditable]',
  'textarea[name="prompt-textarea"]',
  '[role="textbox"][contenteditable]',
].join(', ');

const sendButtonSelector = [
  'button[data-testid="send-button"]',
  'button#composer-submit-button',
  'button[aria-label="Send prompt" i]',
  'button[aria-label="Send message" i]',
  'button[aria-label="Send" i]',
  'button[aria-label="프롬프트 보내기"]',
  'button[aria-label="메시지 보내기"]',
  'button[aria-label="보내기"]',
].join(', ');

export const chatgptTextAdapter = createDomTextAdapter('chatgpt', editorSelector, sendButtonSelector);
