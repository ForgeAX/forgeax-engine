import { EDGE_STYLES, type EdgeKind, heatColor, valenceColor } from './colors.ts';
import {
  drawText,
  fillRect,
  type Image,
  type RGB,
  setPixel,
  textHeight,
  textWidth,
} from './image.ts';

export interface LegendEntry {
  readonly label: string;
  readonly color: RGB;
  readonly style?: 'line' | 'dash' | 'dot' | 'ring';
}

const TEXT: RGB = [222, 226, 234];
const PANEL: RGB = [14, 16, 21];

function swatch(image: Image, x: number, y: number, h: number, entry: LegendEntry): void {
  const mid = y + Math.floor(h / 2);
  const style = entry.style ?? 'line';
  if (style === 'dot' || style === 'ring') {
    const r = 4;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const d = dx * dx + dy * dy;
        if (style === 'dot' ? d <= r * r : d <= r * r && d >= (r - 2) * (r - 2))
          setPixel(image, x + 8 + dx, mid + dy, entry.color);
      }
    return;
  }
  for (let i = 0; i < 18; i++) {
    if (style === 'dash' && Math.floor(i / 4) % 2 === 1) continue;
    fillRect(image, x + i, mid - 1, 1, 3, entry.color);
  }
}

/** Draws a boxed legend with its top-left corner at (x, y); returns its height. */
export function drawLegend(
  image: Image,
  x: number,
  y: number,
  title: string,
  entries: readonly LegendEntry[],
  scale = 1,
): number {
  const rowH = textHeight(scale) + 5;
  let width = textWidth(title, scale);
  for (const e of entries) width = Math.max(width, 26 + textWidth(e.label, scale));
  const height = 8 + rowH * (entries.length + 1);
  fillRect(image, x, y, width + 12, height, PANEL);
  drawText(image, x + 6, y + 5, title, TEXT, scale);
  entries.forEach((e, i) => {
    const ry = y + 5 + rowH * (i + 1);
    swatch(image, x + 6, ry, textHeight(scale), e);
    drawText(image, x + 6 + 24, ry, e.label, TEXT, scale);
  });
  return height;
}

export function edgeLegend(kinds: readonly EdgeKind[]): LegendEntry[] {
  return kinds.map((k) => {
    const s = EDGE_STYLES[k];
    return { label: s.label, color: s.color, style: s.dash === undefined ? 'line' : 'dash' };
  });
}

export function valenceLegend(valences: readonly number[], featureCorners: boolean): LegendEntry[] {
  const out: LegendEntry[] = valences.map((v) => ({
    label: `valence ${v}`,
    color: valenceColor(v),
    style: 'dot',
  }));
  if (featureCorners) out.push({ label: 'feature corner', color: [235, 235, 240], style: 'ring' });
  return out;
}

/** Horizontal scaled-Jacobian colour bar with 0, 1/3, 2/3, 1 ticks. */
export function drawHeatBar(image: Image, x: number, y: number, scale = 1): void {
  const w = 120;
  const h = 10;
  const label = 'scaled Jacobian';
  fillRect(
    image,
    x,
    y,
    Math.max(w, textWidth(label, scale)) + 12,
    h + textHeight(scale) * 2 + 18,
    PANEL,
  );
  drawText(image, x + 6, y + 4, label, TEXT, scale);
  const by = y + 6 + textHeight(scale);
  for (let i = 0; i < w; i++) fillRect(image, x + 6 + i, by, 1, h, heatColor(i / (w - 1)));
  drawText(image, x + 6, by + h + 3, '0', TEXT, scale);
  drawText(image, x + 6 + w - textWidth('1', scale) + 1, by + h + 3, '1', TEXT, scale);
}
