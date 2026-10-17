import type { CanvasInputBoundary } from '@forgeax/engine/input';
import { PAGE_TYPE } from './identity.ts';

/**
 * Engine's browser input backend listens on window. When the Scene page is
 * not the active page tab, drop those samples so a sibling preview cannot
 * drive the viewport camera or game.
 */
export function attachViewportPageInputGate({ element, input, pageType = PAGE_TYPE, document }: { element?: HTMLElement; input?: Pick<CanvasInputBoundary, 'preview'>; pageType?: string; document?: Document } = {}) {
  const preview = input?.preview;
  if (!element || typeof preview?.setInputAllowed !== 'function') return () => {};
  const ownerDocument = document ?? element.ownerDocument ?? globalThis.document;
  const sync = () => {
    const page = typeof element.closest === 'function'
      ? element.closest('[data-forgeax-view-dock-page]')
      : null;
    const pageHidden = page?.getAttribute?.('aria-hidden') === 'true';
    const activePage = ownerDocument?.documentElement?.dataset?.forgeaxViewActivePage;
    const active = !pageHidden && (activePage === undefined || activePage === pageType);
    preview.setInputAllowed?.(active);
  };
  const observer = typeof MutationObserver === 'function'
    ? new MutationObserver(sync)
    : undefined;
  const root = ownerDocument?.documentElement;
  try {
    if (root) observer?.observe(root, {
      attributes: true,
      attributeFilter: ['data-forgeax-view-active-page', 'aria-hidden'],
      subtree: true,
    });
  } catch {
    observer?.disconnect();
  }
  sync();
  return () => {
    observer?.disconnect();
    preview.setInputAllowed?.(true);
  };
}
