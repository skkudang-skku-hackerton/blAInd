import { createDomTextAdapter } from '../../text/site-adapter.ts';

export const geminiTextAdapter = createDomTextAdapter(
  'gemini',
  'rich-textarea .ql-editor[contenteditable="true"]',
  [
    'button.send-button',
    'button[data-test-id="send-button"]',
    'button[aria-label="Send message" i]',
    'button[aria-label="Send" i]',
    'button[aria-label="메시지 보내기"]',
    'button[aria-label="보내기"]',
    'button[aria-label="전송"]',
  ].join(', '),
);
