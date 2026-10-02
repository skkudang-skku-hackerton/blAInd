/** Shared layout for the three sites' file-processing status cards. */
export const processingIndicatorStyles = `
:host { all: initial; }
.blaind-popup.wrap {
  position: fixed;
  left: 50%;
  bottom: var(--blaind-bottom, 96px);
  transform: translateX(-50%);
  width: min(92vw, 420px);
  max-width: min(92vw, 420px);
  -webkit-font-smoothing: antialiased;
  opacity: 0;
  transition: opacity 140ms ease, transform 140ms ease;
}
.wrap[data-visible="true"] { opacity: 1; }
.processing-message { display: flex; align-items: center; gap: 12px; }
.processing-copy { min-width: 0; }
.title { font-weight: 500; }
.files { color: var(--blaind-ink); font-size: 13px; font-weight: 500; line-height: 1.5; }
.detail { color: var(--blaind-muted); margin-top: 4px; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) {
  .blaind-popup.wrap { transition: none; }
}
`;
