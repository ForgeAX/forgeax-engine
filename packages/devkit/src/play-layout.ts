import type { Page } from 'playwright';

/** One play viewport, CSS pixels. */
export interface PlayViewport {
  readonly width: number;
  readonly height: number;
}

/**
 * Text-centric HUD layout defects, chosen for low false-positive risk. Only the
 * visible part of text counts: an ancestor with `overflow` other than `visible`
 * clips it first.
 * - `text-overlap`: text of one element is drawn over text of another.
 * - `text-over-panel`: text overlaps a painted element (an effectively opaque
 *   background, image, SVG or canvas) outside its own component. Design, not
 *   reported: full-viewport backdrops; a panel and text inside one component
 *   under a quarter of the viewport (a health bar fill and its label); and in a
 *   component under 90% of the viewport, a panel that precedes the text in
 *   document order, so it paints behind it (a dialog's portrait or background).
 * - `text-clipped`: text is cut by the viewport edge (fully off-screen text is ignored).
 * - `incomplete`: the check stopped at this viewport (`a` says why: a failed
 *   resize or DOM read, or the element limit), so later warnings may be missing.
 */
export type PlayLayoutIssueKind =
  | 'text-overlap'
  | 'text-over-panel'
  | 'text-clipped'
  | 'incomplete';

export interface PlayLayoutIssue {
  readonly viewport: string;
  readonly kind: PlayLayoutIssueKind;
  /** The text element (a short selector and its leading text), or why the check is incomplete. */
  readonly a: string;
  /** The other text element or the panel; absent for `text-clipped`. */
  readonly b?: string;
}

export interface LayoutRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One visible `#game-ui` element as the in-page collector reports it. */
export interface LayoutNode {
  /** Index of the nearest collected ancestor, or -1 for a child of `#game-ui`. */
  readonly parent: number;
  readonly label: string;
  /** Leading direct text, empty when the element owns no text. */
  readonly text: string;
  /** Visible client rects of the element's direct text, one per line fragment. */
  readonly lines: readonly LayoutRect[];
  readonly box: LayoutRect;
  /** Paints an effectively opaque (alpha times opacity at least 0.5) background, image, SVG or canvas. */
  readonly panel: boolean;
}

export interface LayoutSnapshot {
  readonly viewport: PlayViewport;
  readonly nodes: readonly LayoutNode[];
  /** The walk stopped at its element limit; later elements were not checked. */
  readonly truncated: boolean;
}

export const DEFAULT_PLAY_VIEWPORTS = '1280x720,1280x600';
const MAX_VIEWPORTS = 4;
const MIN_SIDE = 200;
const MAX_SIDE = 4096;
/** Text whose lines overlap by less than this share of the shorter line is a tight line-height, not a defect. */
const OVERLAP_SHARE = 0.35;
const MIN_OVERLAP_PX = 4;
const CLIP_TOLERANCE_PX = 2;
/** A text and panel inside one component smaller than this share of the viewport are that component's design. */
const COMPONENT_SHARE = 0.25;
/** A panel covering this share of the viewport is a backdrop, not a HUD element. */
const BACKDROP_SHARE = 0.9;
export const MAX_LAYOUT_ISSUES = 20;

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

function intersection(a: LayoutRect, b: LayoutRect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/** Overlap tall enough that it is not two tightly stacked lines touching. */
function overlaps(line: LayoutRect, other: LayoutRect, lineHeight: number): boolean {
  const shared = intersection(line, other);
  return (
    shared.width >= MIN_OVERLAP_PX &&
    shared.height >= Math.max(MIN_OVERLAP_PX, OVERLAP_SHARE * lineHeight)
  );
}

/** The on-screen part of a rect; undefined when nothing of it is visible. */
function onScreen(rect: LayoutRect, viewport: PlayViewport): LayoutRect | undefined {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const width = Math.min(viewport.width, rect.x + rect.width) - x;
  const height = Math.min(viewport.height, rect.y + rect.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

function contains(outer: LayoutRect, inner: LayoutRect): boolean {
  const t = CLIP_TOLERANCE_PX;
  return (
    inner.x >= outer.x - t &&
    inner.y >= outer.y - t &&
    inner.x + inner.width <= outer.x + outer.width + t &&
    inner.y + inner.height <= outer.y + outer.height + t
  );
}

function describe(node: LayoutNode): string {
  if (node.text === '') return node.label;
  const text = node.text.length <= 24 ? node.text : `${node.text.slice(0, 23)}…`;
  return `${node.label} "${text}"`;
}

/** Finds text overlap, text crossing a panel edge and viewport clipping in one snapshot. */
export function layoutIssues(snapshot: LayoutSnapshot): PlayLayoutIssue[] {
  const { nodes, viewport } = snapshot;
  const name = viewportName(viewport);
  const ancestors = nodes.map((_node, index) => {
    const chain = new Set<number>();
    for (let at = nodes[index]?.parent ?? -1; at >= 0; at = nodes[at]?.parent ?? -1) chain.add(at);
    return chain;
  });
  const related = (a: number, b: number) =>
    ancestors[a]?.has(b) === true || ancestors[b]?.has(a) === true;
  /** Lowest common collected ancestor, or -1 when only `#game-ui` contains both. */
  const commonAncestor = (a: number, b: number) => {
    for (let at = nodes[a]?.parent ?? -1; at >= 0; at = nodes[at]?.parent ?? -1)
      if (at === b || ancestors[b]?.has(at) === true) return at;
    return -1;
  };
  const area = (box: LayoutRect | undefined) =>
    box === undefined ? Number.POSITIVE_INFINITY : box.width * box.height;
  const componentLimit = COMPONENT_SHARE * viewport.width * viewport.height;
  const backdropLimit = BACKDROP_SHARE * viewport.width * viewport.height;
  const issues: PlayLayoutIssue[] = [];
  const push = (kind: PlayLayoutIssueKind, a: LayoutNode, b?: LayoutNode) => {
    if (issues.length < MAX_LAYOUT_ISSUES)
      issues.push({
        viewport: name,
        kind,
        a: describe(a),
        ...(b === undefined ? {} : { b: describe(b) }),
      });
  };
  // Only what the player can see overlaps; off-screen parts are reported as clipping.
  const visibleLines = nodes.map((node) =>
    node.lines.flatMap((line) => onScreen(line, viewport) ?? []),
  );
  nodes.forEach((node, index) => {
    const lines = visibleLines[index] ?? [];
    if (lines.length === 0) return;
    for (let other = index + 1; other < nodes.length; other += 1) {
      const peer = visibleLines[other] ?? [];
      const height = Math.min(...[...lines, ...peer].map((line) => line.height));
      if (lines.some((line) => peer.some((next) => overlaps(line, next, height))))
        push('text-overlap', node, nodes[other] as LayoutNode);
    }
    nodes.forEach((panel, other) => {
      if (!panel.panel || other === index || related(index, other)) return;
      const component = area(nodes[commonAncestor(index, other)]?.box);
      if (component < componentLimit) return;
      // Inside one bounded component, an earlier panel is painted behind the text.
      if (component < backdropLimit && other < index) return;
      if (area(panel.box) >= backdropLimit) return;
      if (lines.some((line) => overlaps(line, panel.box, line.height)))
        push('text-over-panel', node, panel);
    });
    const screen = { x: 0, y: 0, ...viewport };
    const clipped = node.lines.some((line) => {
      const shared = intersection(line, screen);
      return shared.width > 0 && shared.height > 0 && !contains(screen, line);
    });
    if (clipped) push('text-clipped', node);
  });
  // An incomplete check leads, so no warning budget can hide it.
  if (snapshot.truncated)
    issues.unshift({
      viewport: name,
      kind: 'incomplete',
      a: `stopped after ${nodes.length} elements; later #game-ui elements were not checked`,
    });
  return issues.slice(0, MAX_LAYOUT_ISSUES);
}

/**
 * Runs in the page: collects visible `#game-ui` descendants (light and open
 * shadow trees). A subtree marked `data-forgeax-layout="ignore"` (world-anchored
 * labels, damage numbers) is skipped, as are `display: none` and transparent
 * subtrees; `visibility: hidden` elements contribute neither text nor panels.
 */
function collectLayoutInPage(limit: number): LayoutSnapshot {
  const viewport = { width: innerWidth, height: innerHeight };
  const nodes: LayoutNode[] = [];
  const root = document.querySelector('#game-ui');
  if (root === null) return { viewport, nodes, truncated: false };
  let truncated = false;
  type Rect = { x: number; y: number; width: number; height: number };
  const cut = (a: Rect, b: Rect | null): Rect | null => {
    if (b === null) return a;
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const width = Math.min(a.x + a.width, b.x + b.width) - x;
    const height = Math.min(a.y + a.height, b.y + b.height) - y;
    return width > 0.5 && height > 0.5 ? { x, y, width, height } : null;
  };
  const rect = (value: DOMRect) => ({
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  });
  const colorAlpha = (color: string) => {
    if (color === 'transparent') return 0;
    // `rgba(r, g, b, a)` or a space syntax with `/ a`; no alpha component is opaque.
    const inner = /\(([^)]*)\)/.exec(color)?.[1] ?? '';
    const alpha = (inner.includes('/') ? inner.split('/')[1] : inner.split(',')[3])?.trim();
    if (alpha === undefined) return 1;
    return alpha.endsWith('%') ? Number(alpha.slice(0, -1)) / 100 : Number(alpha);
  };
  const labelOf = (element: Element, scope: string) => {
    const tag = element.tagName.toLowerCase();
    if (element.id !== '') return `#${element.id}`;
    const classes = [...element.classList].slice(0, 2).map((name) => `.${name}`);
    const own = `${tag}${classes.join('')}`;
    return scope === '' ? own : `${scope} ${own}`;
  };
  /** Visible line fragments and leading text of the element's own text nodes. */
  const ownText = (element: Element, clipTo: Rect | null) => {
    const lines: Rect[] = [];
    let text = '';
    for (const child of element.childNodes) {
      const content = child.nodeType === Node.TEXT_NODE ? (child.textContent ?? '').trim() : '';
      if (content === '') continue;
      if (text === '') text = content.replace(/\s+/g, ' ').slice(0, 40);
      const range = document.createRange();
      range.selectNodeContents(child);
      for (const line of range.getClientRects()) {
        const shown = cut(rect(line), clipTo);
        if (shown !== null && lines.length < 64) lines.push(shown);
      }
    }
    return { lines, text };
  };
  const paintAlpha = (element: Element, style: CSSStyleDeclaration) =>
    ['IMG', 'SVG', 'svg', 'CANVAS', 'VIDEO'].includes(element.tagName) ||
    style.backgroundImage !== 'none'
      ? 1
      : colorAlpha(style.backgroundColor);
  /** Effective opacity of a rendered element, or 0 when it or its subtree is skipped. */
  const renderedAlpha = (element: Element, style: CSSStyleDeclaration, opacity: number) =>
    element.getAttribute('data-forgeax-layout') === 'ignore' || style.display === 'none'
      ? 0
      : opacity * Number(style.opacity);
  const walk = (
    element: Element,
    parent: number,
    opacity: number,
    scope: string,
    clip: Rect | null,
  ) => {
    if (nodes.length >= limit) {
      truncated = true;
      return;
    }
    const style = getComputedStyle(element);
    const alpha = renderedAlpha(element, style, opacity);
    if (alpha < 0.05) return;
    const visible = style.visibility === 'visible';
    const bounds = rect(element.getBoundingClientRect());
    const shown = cut(bounds, clip);
    const box = shown ?? { ...bounds, width: 0, height: 0 };
    // The element's own overflow clips its text and descendants.
    const ownClip =
      style.overflowX === 'visible' && style.overflowY === 'visible'
        ? clip
        : (shown ?? { x: 0, y: 0, width: 0, height: 0 });
    const { lines, text } = visible ? ownText(element, ownClip) : { lines: [], text: '' };
    const panel = visible && shown !== null && paintAlpha(element, style) * alpha >= 0.5;
    const index = nodes.length;
    nodes.push({ parent, label: labelOf(element, scope), text, lines, box, panel });
    const childScope = element.id === '' ? scope : `#${element.id}`;
    const children = [...element.children, ...(element.shadowRoot?.children ?? [])];
    for (const child of children) walk(child, index, alpha, childScope, ownClip);
  };
  // `#game-ui` itself spans the viewport; viewport clipping is reported, not hidden.
  for (const child of [...root.children, ...(root.shadowRoot?.children ?? [])])
    walk(child, -1, 1, '', null);
  return { viewport, nodes, truncated };
}

const MAX_LAYOUT_NODES = 600;

/** Collects one snapshot of the page's `#game-ui` layout. */
export async function collectLayout(page: Page): Promise<LayoutSnapshot> {
  return page.evaluate(collectLayoutInPage, MAX_LAYOUT_NODES);
}
