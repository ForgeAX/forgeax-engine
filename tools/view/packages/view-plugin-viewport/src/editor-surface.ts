/** Fit the borrowed Editor container without a transformed or cross-tree overlay. */
export function fitEditorSurface(surface: HTMLElement) {
  const previous = surface.getAttribute?.('style');
  Object.assign(surface.style, {
    width: '100%', height: '100%', maxWidth: '100%', maxHeight: '100%',
    position: 'relative', transform: 'none', overflow: 'hidden',
  });
  return () => {
    if (previous == null) surface.removeAttribute?.('style');
    else surface.setAttribute?.('style', previous);
  };
}
