/** Shared layout for the three sites' file-processing status cards. */
export const processingIndicatorStyles = `
:host { all: initial; }
.blaind-popup.wrap {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: grid;
  place-items: center;
  width: min(calc(100vw - 40px), 420px);
  height: 240px;
  padding: 32px;
  -webkit-font-smoothing: antialiased;
  opacity: 0;
  transition: opacity 140ms ease;
}
.wrap[data-visible="true"] { opacity: 1; }
.wrap .blaind-popup-logo-loading { width: min(240px, 100%); }
.title {
  position: absolute;
  top: calc(50% + 50px);
  left: 28px;
  right: 28px;
  margin: 0;
  color: var(--blaind-muted);
  font-size: 13px;
  font-weight: 400;
  line-height: 1.6;
  text-align: center;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
@media (max-height: 320px) {
  .blaind-popup.wrap { height: calc(100dvh - 40px); padding: 20px; }
  .wrap .blaind-popup-logo-loading { width: min(180px, 100%); }
  .title { top: calc(50% + 32px); -webkit-line-clamp: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .blaind-popup.wrap { transition: none; }
}
`;
