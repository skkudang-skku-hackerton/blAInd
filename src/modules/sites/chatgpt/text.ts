import { createDomTextAdapter } from '../../text/site-adapter.ts';

// ChatGPT는 입력창에 ID 없이 role="textbox"만 제공하는 화면도 있습니다.
const editorSelector = [
  '#prompt-textarea',
  '#prompt-textarea [contenteditable]',
  'textarea[name="prompt-textarea"]',
  '[role="textbox"][contenteditable]',
].join(', ');

export const chatgptTextAdapter = createDomTextAdapter('chatgpt', editorSelector);
