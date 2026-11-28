import type { RGB } from './image.ts';

/** B-rep edge classes the kit draws; one colour each, shown in every legend. */
export type EdgeKind = 'convex' | 'concave' | 'smooth' | 'boundary' | 'seam' | 'non-manifold';

export interface EdgeStyle {
  readonly color: RGB;
  readonly width: number;
  readonly dash?: readonly [number, number];
  readonly label: string;
}

export const EDGE_STYLES: Readonly<Record<EdgeKind, EdgeStyle>> = {
  convex: { color: [255, 200, 70], width: 1.8, label: 'sharp convex' },
  concave: { color: [70, 205, 255], width: 1.8, label: 'sharp concave' },
  smooth: { color: [120, 215, 130], width: 1.1, label: 'smooth / tangent' },
  boundary: { color: [255, 80, 80], width: 2.4, label: 'boundary / open' },
  seam: { color: [225, 120, 255], width: 1.2, dash: [5, 4], label: 'seam' },
  'non-manifold': { color: [255, 255, 255], width: 2.4, label: 'non-manifold' },
};

export const EDGE_KINDS: readonly EdgeKind[] = [
  'convex',
  'concave',
  'smooth',
  'boundary',
  'seam',
  'non-manifold',
];

/** Muted surface colours cycled by face index (colorBy 'face'). */
export const FACE_PALETTE: readonly RGB[] = [
  [150, 172, 205],
  [205, 165, 120],
  [130, 190, 150],
  [195, 140, 172],
  [200, 192, 120],
  [120, 182, 192],
  [182, 150, 122],
  [152, 152, 195],
  [172, 202, 130],
  [202, 140, 140],
];

/** Distinct part colours cycled by shape index in an assembly. */
export const PART_PALETTE: readonly RGB[] = [
  [160, 176, 200],
  [210, 160, 110],
  [120, 190, 150],
  [200, 130, 170],
  [200, 195, 110],
  [110, 180, 200],
];

export const NEUTRAL: RGB = [170, 178, 190];

export function paletteAt(palette: readonly RGB[], index: number): RGB {
  return palette[((index % palette.length) + palette.length) % palette.length] as RGB;
}

export function scaleColor(c: RGB, k: number): RGB {
  return [
    Math.min(255, Math.round(c[0] * k)),
    Math.min(255, Math.round(c[1] * k)),
    Math.min(255, Math.round(c[2] * k)),
  ];
}

export function mixColor(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Scaled-Jacobian ramp: dark red at 0 (or inverted), amber at 1/3, green at 2/3, blue at 1. */
const RAMP: readonly { readonly t: number; readonly c: RGB }[] = [
  { t: 0, c: [170, 20, 20] },
  { t: 1 / 3, c: [230, 200, 60] },
  { t: 2 / 3, c: [60, 170, 120] },
  { t: 1, c: [40, 80, 200] },
];

export function heatColor(sJ: number): RGB {
  const t = Math.min(1, Math.max(0, sJ));
  for (let i = 1; i < RAMP.length; i++) {
    const hi = RAMP[i] as (typeof RAMP)[number];
    if (t <= hi.t) {
      const lo = RAMP[i - 1] as (typeof RAMP)[number];
      return mixColor(lo.c, hi.c, (t - lo.t) / (hi.t - lo.t));
    }
  }
  return (RAMP[RAMP.length - 1] as (typeof RAMP)[number]).c;
}

/** Marker colours for quad-mesh vertex valence (4 is regular and unmarked). */
export function valenceColor(valence: number): RGB {
  if (valence === 3) return [255, 150, 40];
  if (valence === 5) return [255, 70, 90];
  if (valence > 5) return [255, 60, 220];
  return [150, 120, 255];
}
