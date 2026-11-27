/**
 * Runs in the page (serialized by `page.evaluate`, so it references nothing outside
 * its body). Hit-tests a viewport point through open shadow roots and describes the
 * element that would receive a click there when it is neither the game canvas nor a
 * control. Returns `null` for the canvas, for controls (buttons, links, form fields,
 * action targets, ARIA widgets, dialogs) and for points outside the viewport.
 */
export function clickTargetInPage(point: {
  readonly x: number;
  readonly y: number;
}): string | null {
  const CONTROL =
    'button, a[href], input, select, textarea, label, summary, dialog, [tabindex], [data-ui-action], [role], [contenteditable]';
  let hit: Element | null = document.elementFromPoint(point.x, point.y);
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(point.x, point.y);
    if (inner === null || inner === hit) break;
    hit = inner;
  }
  if (hit === null || hit instanceof HTMLCanvasElement) return null;
  let asset: string | undefined;
  for (let node: Element | null = hit; node !== null; ) {
    if (node.matches(CONTROL)) return null;
    const host = node instanceof HTMLElement ? node.dataset : undefined;
    if (asset === undefined && host?.uiAsset !== undefined) asset = host.uiSource ?? host.uiAsset;
    const root: Node | null = node.parentNode;
    node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  const id = hit.id ? `#${hit.id}` : '';
  const classes = [...hit.classList]
    .slice(0, 2)
    .map((name) => `.${name}`)
    .join('');
  const label = `<${hit.tagName.toLowerCase()}${id}${classes}>`;
  return asset === undefined ? label : `${label} in UI ${asset}`;
}

/**
 * Runs in the page (serialized by `page.evaluate`, so it references nothing outside
 * its body). Under pointer lock, delivers one relative mouse move to the locked
 * element: a `pointermove` carrying `movementX`/`movementY`, as the browser sends for
 * a locked mouse. Returns `false` without dispatching when nothing holds the lock.
 */
export function lookInPage(delta: { readonly dx: number; readonly dy: number }): boolean {
  const target = document.pointerLockElement;
  if (target === null) return false;
  const event = new PointerEvent('pointermove', {
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    bubbles: true,
    composed: true,
    movementX: delta.dx,
    movementY: delta.dy,
  });
  // Some engines ignore movement in the init dictionary of a synthetic event.
  if (event.movementX !== delta.dx || event.movementY !== delta.dy)
    Object.defineProperties(event, {
      movementX: { value: delta.dx },
      movementY: { value: delta.dy },
    });
  target.dispatchEvent(event);
  return true;
}

/** One play viewport, CSS pixels. */
export interface PlayViewport {
  readonly width: number;
  readonly height: number;
}

export const DEFAULT_PLAY_VIEWPORTS = '1280x720,1280x600';
const MAX_VIEWPORTS = 4;
const MIN_SIDE = 200;
const MAX_SIDE = 4096;

export function viewportName(viewport: PlayViewport): string {
  return `${viewport.width}x${viewport.height}`;
}

/** Parses `WxH[,WxH...]`; the first viewport runs the script, the rest are checked after it. */
export function parsePlayViewports(
  value: string,
): { ok: true; value: readonly PlayViewport[] } | { ok: false; message: string } {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length > MAX_VIEWPORTS)
    return { ok: false, message: `at most ${MAX_VIEWPORTS} viewports; got ${parts.length}` };
  const viewports: PlayViewport[] = [];
  for (const part of parts) {
    const match = /^(\d+)x(\d+)$/.exec(part);
    const width = Number(match?.[1]);
    const height = Number(match?.[2]);
    if (
      match === null ||
      [width, height].some((side) => side < MIN_SIDE || side > MAX_SIDE) ||
      viewports.some((seen) => seen.width === width && seen.height === height)
    )
      return {
        ok: false,
        message: `viewport ${JSON.stringify(part)} must be a distinct WxH with sides ${MIN_SIDE}-${MAX_SIDE}`,
      };
    viewports.push({ width, height });
  }
  return { ok: true, value: viewports };
}
