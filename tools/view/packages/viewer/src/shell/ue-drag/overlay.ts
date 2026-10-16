import type { DirectorLayout, Point, Rect, UePosition } from './geometry';
import './ue-drag.css';

const SVG_NS = 'http://www.w3.org/2000/svg';
type Direction = Exclude<UePosition, 'center'>;

type OverlayDom = {
  root: HTMLDivElement;
  liveHost: HTMLDivElement;
  preview: HTMLDivElement;
  svg: SVGSVGElement;
  group: SVGGElement;
  zones: Record<Direction, SVGPolygonElement>;
  center: SVGRectElement;
  ghost: HTMLDivElement;
};

let dom: OverlayDom | null = null;

function polygon(points: readonly Point[]) {
  return points.map((point) => `${point.x},${point.y}`).join(' ');
}

function createOverlay(): OverlayDom {
  const root = document.createElement('div');
  root.className = 'fx-ue-overlay';
  root.hidden = true;
  const liveHost = document.createElement('div');
  liveHost.className = 'fx-ue-live-host';
  const preview = document.createElement('div');
  preview.className = 'fx-ue-preview';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('fx-ue-svg');
  const group = document.createElementNS(SVG_NS, 'g');
  const makeZone = (direction: Direction) => {
    const element = document.createElementNS(SVG_NS, 'polygon');
    element.classList.add('fx-ue-zone', `fx-ue-zone--${direction}`);
    group.append(element);
    return element;
  };
  const zones = {
    top: makeZone('top'),
    right: makeZone('right'),
    bottom: makeZone('bottom'),
    left: makeZone('left'),
  };
  const center = document.createElementNS(SVG_NS, 'rect');
  center.classList.add('fx-ue-zone', 'fx-ue-zone--center');
  center.setAttribute('rx', '4');
  group.append(center);
  svg.append(group);
  const ghost = document.createElement('div');
  ghost.className = 'fx-ue-ghost';
  root.append(liveHost, preview, svg, ghost);
  const mount = document.body;
  mount.append(root);
  return { root, liveHost, preview, svg, group, zones, center, ghost };
}

function getDom() {
  if (!dom || !document.body.contains(dom.root)) dom = createOverlay();
  return dom;
}

function place(element: HTMLElement, rect: Rect) {
  element.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

export function updateUeOverlay({
  pointer,
  director,
  active,
  preview,
  previewKind = 'slab',
  title,
}: {
  pointer: Point;
  director: DirectorLayout | null;
  active: UePosition | null;
  preview: Rect | null;
  previewKind?: 'slab' | 'strip';
  title: string;
}) {
  const current = getDom();
  current.root.hidden = false;
  if (preview) {
    current.preview.hidden = false;
    place(current.preview, preview);
    current.preview.classList.toggle('fx-ue-preview--strip', previewKind === 'strip');
  } else {
    current.preview.hidden = true;
  }
  if (!director) {
    current.group.style.display = 'none';
  } else {
    current.group.style.display = '';
  }
  if (director) {
    for (const direction of ['top', 'right', 'bottom', 'left'] as const) {
      current.zones[direction].setAttribute('points', polygon(director[direction]));
      current.zones[direction].classList.toggle('is-active', active === direction);
    }
    current.center.setAttribute('x', String(director.center.x));
    current.center.setAttribute('y', String(director.center.y));
    current.center.setAttribute('width', String(director.center.width));
    current.center.setAttribute('height', String(director.center.height));
    current.center.classList.toggle('is-active', active === 'center');
  }
  if (title) {
    current.ghost.hidden = false;
    current.ghost.textContent = title;
    current.ghost.style.transform = `translate(${pointer.x + 14}px, ${pointer.y + 14}px)`;
  } else {
    current.ghost.hidden = true;
  }
}

export function hideUeOverlay() {
  if (dom) dom.root.hidden = true;
}

export function getUeLivePreviewHost() {
  return getDom().liveHost;
}
