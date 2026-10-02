/** Status panels have no editable controls. Handle their clicks before page capture
 * listeners can dismiss an upload menu; only the optional close button is actionable. */
export function protectStatusUi(host: HTMLElement, closeButton?: HTMLElement, onClose?: () => void): () => void {
  const view = host.ownerDocument.defaultView!;
  const types = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick',
    'touchstart', 'touchend', 'keydown', 'keyup'] as const;
  const intercept = (event: Event) => {
    const path = event.composedPath();
    if (!path.includes(host)) return;
    event.stopImmediatePropagation();
    const keyboard = event as KeyboardEvent;
    // Preserve keyboard traversal, but don't let a pointer interaction blur the
    // site's upload control. The explicitly handled close action needs no default.
    if (event.type !== 'keydown' || keyboard.key !== 'Tab') event.preventDefault();
    if (closeButton && path.includes(closeButton) &&
        (event.type === 'click' || event.type === 'keydown' && !keyboard.repeat &&
          (keyboard.key === 'Enter' || keyboard.key === ' '))) onClose?.();
  };
  for (const type of types) view.addEventListener(type, intercept, { capture: true, passive: false });
  return () => { for (const type of types) view.removeEventListener(type, intercept, true); };
}
