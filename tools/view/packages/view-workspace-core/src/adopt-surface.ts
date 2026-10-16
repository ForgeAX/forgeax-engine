/** One attachment owns placement, never the borrowed Engine node or runtime. */
export function borrowSurface(surface: HTMLElement, container: HTMLElement) {
  const parent = surface.parentNode;
  const next = surface.nextSibling;
  const attributes = ['style', 'hidden', 'aria-label', 'data-forgeax-view-target-id',
    'data-forgeax-view-tab-id', 'data-forgeax-view-surface', 'data-forgeax-view-selected']
    .map((name): [string, string | null | undefined] => [name, surface.getAttribute?.(name)]);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    // An external owner may already have reclaimed the node and its styles.
    if (surface.parentNode !== container) return;
    for (const [name, value] of attributes) {
      if (value == null) surface.removeAttribute?.(name);
      else surface.setAttribute?.(name, value);
    }
    if (parent) {
      if (parent.insertBefore) parent.insertBefore(surface, next?.parentNode === parent ? next : null);
      else if ('append' in parent) parent.append(surface);
    } else surface.remove?.();
  };
}

export const SCENE_SHELL_ID = 'app-shell';

export function readSceneShell(document: Document | undefined) {
  return document?.getElementById?.(SCENE_SHELL_ID) ?? null;
}

export function placeSurface(container: HTMLElement | null | undefined, surface: HTMLElement | null | undefined, { replace = false } = {}) {
  if (!container || !surface || surface.parentNode === container) return false;
  // Engine createApp(canvas) requires isConnected. Never pull a live node into
  // a detached View host (Dock/page not mounted yet).
  if (container.isConnected === false) return false;
  if (replace && typeof container.replaceChildren === 'function') {
    container.replaceChildren(surface);
    return true;
  }
  container.append?.(surface);
  return true;
}

/**
 * Keep a live Engine node inside a View container regardless of which DOM
 * appears first. Re-adopts if the node is moved back to body/parking.
 */
export function keepSurfaceInContainer({
  document,
  getContainer,
  getSurface,
  replace = false,
  onPlace,
  poll = false,
}: { document?: Document; getContainer?: () => HTMLElement | null | undefined; getSurface?: () => HTMLElement | null | undefined; replace?: boolean; onPlace?: (surface: HTMLElement, container: HTMLElement) => void; poll?: boolean } = {}) {
  let stopped = false;
  let placement: { container: HTMLElement; surface: HTMLElement; restore: () => void } | undefined;
  const release = () => { placement?.restore(); placement = undefined; };
  const sync = () => {
    if (stopped) return;
    const container = getContainer?.();
    if (!container || container.isConnected === false) { release(); return; }
    const surface = getSurface?.();
    if (!surface) return;
    if (placement && (placement.container !== container || placement.surface !== surface)) release();
    if (surface.parentNode === container) return;
    if (!placement) placement = { container, surface, restore: borrowSurface(surface, container) };
    if (!placeSurface(container, surface, { replace })) return;
    onPlace?.(surface, container);
  };
  sync();
  const root = document?.documentElement ?? document?.body;
  const Observer = document?.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  const win = document?.defaultView ?? globalThis;
  let observer: MutationObserver | undefined;
  let raf = 0;
  if (root && typeof Observer === 'function') {
    observer = new Observer(sync);
    observer.observe(root, { childList: true, subtree: true });
  }
  if (poll && typeof win.requestAnimationFrame === 'function') {
    const tick = () => {
      if (stopped) return;
      sync();
      raf = win.requestAnimationFrame(tick);
    };
    raf = win.requestAnimationFrame(tick);
  }
  return () => {
    stopped = true;
    observer?.disconnect();
    if (raf) win.cancelAnimationFrame?.(raf);
    release();
  };
}

export function watchUntilReady({ document, probe }: { document?: Document; probe?: () => boolean } = {}) {
  let stopped = false;
  const win = document?.defaultView ?? globalThis;
  const Observer = document?.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  let observer: MutationObserver | undefined;
  let raf = 0;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    if (raf) win.cancelAnimationFrame?.(raf);
  };
  const tick = () => {
    if (stopped) return;
    if (probe?.()) stop();
  };
  tick();
  if (stopped) return stop;
  const root = document?.documentElement ?? document?.body;
  if (root && typeof Observer === 'function') {
    observer = new Observer(tick);
    observer.observe(root, { childList: true, subtree: true });
  }
  if (typeof win.requestAnimationFrame === 'function') {
    const loop = () => {
      if (stopped) return;
      tick();
      raf = win.requestAnimationFrame(loop);
    };
    raf = win.requestAnimationFrame(loop);
  }
  return stop;
}
