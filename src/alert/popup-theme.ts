import logoSvg from './assets/blaind-B-light.svg?raw';
import popupThemeStyles from './popup-theme.css?raw';

export { popupThemeStyles };

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Inline the bundled logo so page image policies cannot hide the brand. */
export function createPopupLogo(page: Document): HTMLSpanElement {
  const logo = page.createElement('span');
  logo.className = 'blaind-popup-logo';
  logo.setAttribute('role', 'img');
  logo.setAttribute('aria-label', '블라인드');
  logo.innerHTML = logoSvg;
  return logo;
}

/** The logo as a loading mark: a redaction bar repeatedly covers [AI] while its brackets fade. */
export function createLoadingLogo(page: Document): HTMLSpanElement {
  const logo = createPopupLogo(page);
  logo.classList.add('blaind-popup-logo-loading');
  const glyphs = logo.querySelector('svg g')!;
  for (const bracket of glyphs.querySelectorAll('path[fill-opacity]')) {
    bracket.setAttribute('class', 'blaind-logo-bracket');
  }
  // Covers [AI] from bracket to bracket, like the bar on the title slide.
  const bar = page.createElementNS(SVG_NS, 'rect');
  bar.setAttribute('class', 'blaind-logo-bar');
  bar.setAttribute('x', '68.35');
  bar.setAttribute('y', '-38');
  bar.setAttribute('width', '96.3');
  bar.setAttribute('height', '42');
  bar.setAttribute('fill', '#111111');
  glyphs.append(bar);
  return logo;
}
