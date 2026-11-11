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
