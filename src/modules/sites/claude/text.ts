import { createDomTextAdapter } from '../../text/site-adapter.ts';

export const claudeTextAdapter = createDomTextAdapter(
  'claude',
  '.ProseMirror[contenteditable="true"]',
  [
    'button[data-testid="send-button"]',
    'button[aria-label="Send message" i]',
    'button[aria-label="Send" i]',
    'button[aria-label="메시지 보내기"]',
    'button[aria-label="보내기"]',
  ].join(', '),
);
