import logoSvg from './assets/blaind-B-light.svg?raw';
import popupThemeStyles from './popup-theme.css?raw';

export { popupThemeStyles };

/** Inline the bundled logo so page image policies cannot hide the brand. */
export function createPopupLogo(page: Document): HTMLSpanElement {
  const logo = page.createElement('span');
  logo.className = 'blaind-popup-logo';
  logo.setAttribute('role', 'img');
  logo.setAttribute('aria-label', '블라인드');
  logo.innerHTML = logoSvg;
  return logo;
}
