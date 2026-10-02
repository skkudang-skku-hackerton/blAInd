import sansRegular from './fonts/IBMPlexSansKR-Regular.woff2?inline';
import sansMedium from './fonts/IBMPlexSansKR-Medium.woff2?inline';
import sansBold from './fonts/IBMPlexSansKR-Bold.woff2?inline';
import monoMedium from './fonts/IBMPlexMono-Medium.woff2?inline';
import monoBold from './fonts/IBMPlexMono-Bold.woff2?inline';

const registeredDocuments = new WeakSet<Document>();

/** Register bundled binary fonts for both document and Shadow DOM alerts. */
export function ensureAlertFonts(document: Document): void {
  const Font = document.defaultView?.FontFace;
  if (!Font || !document.fonts || registeredDocuments.has(document)) return;
  registeredDocuments.add(document);

  const decode = (url: string) => {
    const encoded = url.slice(url.indexOf(',') + 1);
    const bytes = document.defaultView!.atob(encoded);
    return Uint8Array.from(bytes, char => char.charCodeAt(0));
  };
  const faces = [
    ['IBM Plex Sans KR', '400', sansRegular],
    ['IBM Plex Sans KR', '500', sansMedium],
    ['IBM Plex Sans KR', '700', sansBold],
    ['IBM Plex Mono', '500', monoMedium],
    ['IBM Plex Mono', '700', monoBold],
  ] as const;
  for (const [family, weight, url] of faces) {
    const bytes = decode(url);
    const font = new Font(family, bytes, { weight, style: 'normal', display: 'swap' });
    document.fonts.add(font);
    void font.load().catch(() => { /* Keep the CSS fallback if font decoding fails. */ });
    if (family === 'IBM Plex Mono') {
      // Use Mono for digits even within otherwise Korean body text.
      const weights = weight === '500' ? ['400', '500'] : ['700'];
      for (const numericWeight of weights) {
        const numerals = new Font('blAInd Numerals', bytes, {
          weight: numericWeight, style: 'normal', display: 'swap', unicodeRange: 'U+0030-0039',
        });
        document.fonts.add(numerals);
        void numerals.load().catch(() => {});
      }
    }
  }
}
