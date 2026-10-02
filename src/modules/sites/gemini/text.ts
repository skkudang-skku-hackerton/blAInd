import { createDomTextAdapter } from '../../text/site-adapter.ts';

export const geminiTextAdapter = createDomTextAdapter(
  'gemini',
  'rich-textarea .ql-editor[contenteditable="true"]',
);
