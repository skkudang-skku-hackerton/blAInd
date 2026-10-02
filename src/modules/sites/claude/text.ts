import { createDomTextAdapter } from '../../text/site-adapter.ts';

export const claudeTextAdapter = createDomTextAdapter(
  'claude',
  '.ProseMirror[contenteditable="true"]',
);
