export type UePosition = 'top' | 'bottom' | 'left' | 'right' | 'center';
export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type Polygon = readonly Point[];

export type DirectorLayout = {
  cx: number;
  cy: number;
  bounds: Rect;
  center: Rect;
  top: Polygon;
  right: Polygon;
  bottom: Polygon;
  left: Polygon;
};

export const UE_DIRECTOR_MARGIN = 6;
export const UE_DIRECTOR_CENTER_RATIO = 0.46;
export const UE_DIRECTOR_CENTER_MIN_W = 64;
export const UE_DIRECTOR_CENTER_MIN_H = 52;
export const UE_STRIP_SLOT_MIN = 104;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

export function pointInRect(point: Point, rect: Rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height;
}

export function directorLayout(
  content: Rect,
  margin = UE_DIRECTOR_MARGIN,
): DirectorLayout {
  const m = Math.min(margin, content.width / 6, content.height / 6);
  const bounds = {
    x: content.x + m,
    y: content.y + m,
    width: content.width - 2 * m,
    height: content.height - 2 * m,
  };
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const cW = clamp(bounds.width * UE_DIRECTOR_CENTER_RATIO, Math.min(UE_DIRECTOR_CENTER_MIN_W, bounds.width), bounds.width);
  const cH = clamp(bounds.height * UE_DIRECTOR_CENTER_RATIO, Math.min(UE_DIRECTOR_CENTER_MIN_H, bounds.height), bounds.height);
  const cwh = cW / 2;
  const chh = cH / 2;
  const outer = {
    tl: { x: bounds.x, y: bounds.y },
    tr: { x: bounds.x + bounds.width, y: bounds.y },
    br: { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    bl: { x: bounds.x, y: bounds.y + bounds.height },
  };
  const inner = {
    tl: { x: cx - cwh, y: cy - chh },
    tr: { x: cx + cwh, y: cy - chh },
    br: { x: cx + cwh, y: cy + chh },
    bl: { x: cx - cwh, y: cy + chh },
  };
  return {
    cx,
    cy,
    bounds,
    center: { x: cx - cwh, y: cy - chh, width: cW, height: cH },
    top: [outer.tl, outer.tr, inner.tr, inner.tl],
    right: [outer.tr, outer.br, inner.br, inner.tr],
    bottom: [outer.br, outer.bl, inner.bl, inner.br],
    left: [outer.bl, outer.tl, inner.tl, inner.bl],
  };
}

export function hitDirector(layout: DirectorLayout, point: Point): UePosition | null {
  if (pointInRect(point, layout.center)) return 'center';
  if (!pointInRect(point, layout.bounds)) return null;
  const dx = (point.x - layout.cx) / (layout.bounds.width / 2);
  const dy = (point.y - layout.cy) / (layout.bounds.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'top' : 'bottom';
}

export function previewRect(rect: Rect, position: UePosition): Rect {
  const half = (n: number) => n / 2;
  switch (position) {
    case 'top':
      return { x: rect.x, y: rect.y, width: rect.width, height: half(rect.height) };
    case 'bottom':
      return { x: rect.x, y: rect.y + half(rect.height), width: rect.width, height: half(rect.height) };
    case 'left':
      return { x: rect.x, y: rect.y, width: half(rect.width), height: rect.height };
    case 'right':
      return { x: rect.x + half(rect.width), y: rect.y, width: half(rect.width), height: rect.height };
    case 'center':
    default:
      return { ...rect };
  }
}

export function stripInsertion(
  tabs: readonly Rect[],
  strip: Rect,
  point: Point,
  axis: 'x' | 'y',
  minSlot = UE_STRIP_SLOT_MIN,
) {
  const horiz = axis === 'x';
  const start = (r: Rect) => (horiz ? r.x : r.y);
  const span = (r: Rect) => (horiz ? r.width : r.height);
  const cursor = horiz ? point.x : point.y;
  let index = tabs.length;
  for (let i = 0; i < tabs.length; i += 1) {
    if (cursor < start(tabs[i]) + span(tabs[i]) / 2) {
      index = i;
      break;
    }
  }
  const lengths = tabs.map(span).sort((a, b) => a - b);
  const median = lengths.length > 0 ? lengths[Math.floor(lengths.length / 2)] : 0;
  const slotLen = Math.max(minSlot, median);
  const last = tabs[tabs.length - 1];
  const at = index < tabs.length
    ? start(tabs[index])
    : last
      ? start(last) + span(last)
      : start(strip);
  return {
    index,
    slot: horiz
      ? { x: at, y: strip.y, width: slotLen, height: strip.height }
      : { x: strip.x, y: at, width: strip.width, height: slotLen },
  };
}

export function toGridDirection(pos: UePosition) {
  switch (pos) {
    case 'top': return 'above' as const;
    case 'bottom': return 'below' as const;
    case 'left': return 'left' as const;
    case 'right': return 'right' as const;
    case 'center':
    default: return 'within' as const;
  }
}

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}
