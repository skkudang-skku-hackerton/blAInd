// URL 등록은 실행 대상만 정합니다. 사이트별 인터셉트는 modules/sites/에서 구현합니다.
export const REGISTERED_SITES = [
  { id: 'chatgpt', name: 'ChatGPT', origin: 'https://chatgpt.com' },
  { id: 'claude', name: 'Claude', origin: 'https://claude.ai' },
  { id: 'gemini', name: 'Gemini', origin: 'https://gemini.google.com' },
] as const;

export type RegisteredSiteId = (typeof REGISTERED_SITES)[number]['id'];

export const REGISTERED_SITE_MATCHES = REGISTERED_SITES.map(
  (site) => `${site.origin}/*`,
);

export function getRegisteredSite(url: URL) {
  return REGISTERED_SITES.find((site) => site.origin === url.origin);
}
