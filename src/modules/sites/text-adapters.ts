import type { RegisteredSiteId } from '../../sites/registry.ts';
import type { TextSiteAdapter } from '../text/types.ts';
import { chatgptTextAdapter } from './chatgpt/text.ts';
import { claudeTextAdapter } from './claude/text.ts';
import { geminiTextAdapter } from './gemini/text.ts';

const adapters: Record<RegisteredSiteId, TextSiteAdapter> = {
  chatgpt: chatgptTextAdapter,
  claude: claudeTextAdapter,
  gemini: geminiTextAdapter,
};

export function getTextSiteAdapter(siteId: RegisteredSiteId): TextSiteAdapter {
  return adapters[siteId];
}
