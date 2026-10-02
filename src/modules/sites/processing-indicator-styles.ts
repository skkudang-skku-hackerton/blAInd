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
.spinner {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--blaind-border);
  border-top-color: var(--blaind-ink);
  animation: blaind-spin 0.8s linear infinite;
}
.title { font-weight: 500; }
.files { color: var(--blaind-ink); font-size: 13px; font-weight: 500; line-height: 1.5; }
.detail { color: var(--blaind-muted); margin-top: 4px; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
@keyframes blaind-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .spinner { animation-duration: 2s; }
  .blaind-popup.wrap { transition: none; }
}
`;
