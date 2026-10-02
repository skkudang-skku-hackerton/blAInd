import { browser } from 'wxt/browser';
import { normalizeMaskingPreferences, setMaskingPreferences, type MaskingPreferences } from '../core/pii/preferences';

export const MASKING_PREFERENCES_KEY = 'maskingPreferences';

export async function loadMaskingPreferences(): Promise<MaskingPreferences> {
  const stored = await browser.storage.local.get(MASKING_PREFERENCES_KEY);
  return normalizeMaskingPreferences(stored[MASKING_PREFERENCES_KEY]);
}

export async function saveMaskingPreferences(preferences: MaskingPreferences): Promise<void> {
  await browser.storage.local.set({ [MASKING_PREFERENCES_KEY]: normalizeMaskingPreferences(preferences) });
}

/** Subscribe before reading so changes during initialization are not overwritten. */
export function initializeMaskingPreferences() {
  let revision = 0;
  const listener: Parameters<typeof browser.storage.onChanged.addListener>[0] = (changes, area) => {
    if (area !== 'local' || !changes[MASKING_PREFERENCES_KEY]) return;
    revision++;
    setMaskingPreferences(changes[MASKING_PREFERENCES_KEY].newValue);
  };
  browser.storage.onChanged.addListener(listener);
  const ready = loadMaskingPreferences().then(preferences => {
    if (revision === 0) setMaskingPreferences(preferences);
  });
  return { ready, dispose: () => browser.storage.onChanged.removeListener(listener) };
}
