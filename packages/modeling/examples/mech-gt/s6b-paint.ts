import { fractalNoise, type Model, normalFromHeight, type Point2, proceduralMaterials, region2d, sel, type StandardMaterialOptions, type TextureSink, textStrokes, textureFrom, type Tuple3 } from '@forgeax/engine-modeling';
import { PAINT } from '../body-panels/panels.ts';

/**
 * Case C-100 (code name mech-gt): the one paint scheme of the final model (F1 criterion 12c),
 * shared by the car exterior, the robot form and the detail parts. Six slot families: the
 * main paint (the car's body colour is the robot's armor) and its accent, structural grey,
 * copper and steel hardware, glow, a dark matte primer for rubber, hoses and cavities, and
 * decals; optical glass is the one non-paint exception. Tiling textures sit on uv1 (meters).
 *
 * Weathering is part of the scheme: the paint chips to primer at random spots, the frame
 * grey and the primer carry grime streaks (`gtPaintScheme({ weathered: true })`, the default).
 * Stencils (numbers, warnings, hazard bars) are flat decal plates with their own uv1 cell
 * (`stencilPlate`) and one decal sheet each (`stencilMaterial`), so any owner places them
 * on its own anchor frames.
 */
export const GT_SLOTS = ['gt-paint', 'gt-paint-accent', 'gt-paint-accent-quilt', 'gt-frame', 'gt-metal', 'gt-metal-steel', 'gt-glow', 'gt-glow-white', 'gt-glow-red', 'gt-glow-amber', 'gt-primer', 'gt-decal', 'gt-glass'] as const;
export type GtSlot = (typeof GT_SLOTS)[number];

/** Accent livery colour (linear): warm amber, used sparingly on harness and trims. */
export const ACCENT: readonly [number, number, number] = [0.85, 0.33, 0.04];
/** Primer (linear): the dark matte under the paint, on rubber, hoses and cavities. */
export const PRIMER: readonly [number, number, number] = [0.035, 0.035, 0.04];
/** Stencil ink (linear): off-white. */
export const INK: readonly [number, number, number] = [0.85, 0.83, 0.78];

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};

/** A texture on uv1 tiling every `tile` meters (the shape `proceduralMaterials` produce). */
function onUv1(ref: ReturnType<TextureSink>, tile: number): NonNullable<StandardMaterialOptions['baseColorTexture']> {
  return { texture: ref, coordinates: { set: 1, transform: { scale: [1 / tile, 1 / tile] } } } as unknown as NonNullable<StandardMaterialOptions['baseColorTexture']>;
}

const SIZE = 256;

/**
 * Weathering of a base colour on a `tile`-meter cell: chips (sharp-edged spots where the
 * coating is gone, showing `chip`) and grime (soft dark streaks running down v).
 */
function weathered(texture: TextureSink, key: string, base: readonly [number, number, number], o: { readonly chip?: readonly [number, number, number]; readonly chips: number; readonly grime: number; readonly tile: number; readonly seed: number; readonly mips: boolean }): NonNullable<StandardMaterialOptions['baseColorTexture']> {
  const image = unwrap(
    textureFrom(
      SIZE,
      SIZE,
      (x, y) => {
        const u = x / SIZE;
        const v = y / SIZE;
        // Grime: streaks stretched along v, strongest in low-frequency patches (darken by up to `grime`).
        const streak = fractalNoise(u * 6, v * 0.8, 8, 3, o.seed) * fractalNoise(u, v, 2, 2, o.seed + 3);
        const k = Math.min(1, Math.max(0, (streak - 0.12) / 0.3));
        const dirt = 1 - o.grime * k * k * (3 - 2 * k);
        // Chips: fine spots inside worn patches; `chips` 0.3 leaves about 5 % of the coating chipped.
        const worn = fractalNoise(u, v, 3, 2, o.seed + 5);
        const chip = o.chip !== undefined && worn > 0.75 - o.chips * 0.5 && fractalNoise(u, v, 32, 2, o.seed + 9) > 0.55;
        const c = chip ? (o.chip as readonly [number, number, number]) : base;
        // Linear texels: textureFrom encodes them for the sRGB color space.
        return [c[0] * dirt, c[1] * dirt, c[2] * dirt, 1];
      },
      { colorSpace: 'srgb', ...(o.mips ? {} : { mips: false }) },
    ),
  );
  return onUv1(texture(key, image), o.tile);
}

export interface PaintSchemeOptions {
  /** Chips, grime and streaks on paint, frame and primer (default true). */
  readonly weathered?: boolean;
  /** Packed mip chains on the generated textures (default true; case renderers that JSON-serialize their Pack turn them off). */
  readonly mips?: boolean;
}

/**
 * Quilted insert: puffed diamond cells between stitched seams as a tiling normal map (one
 * 6 cm tile on uv1 in meters); the seams are the low lines of the height field.
 */
function quilt(texture: TextureSink, mips: boolean): NonNullable<StandardMaterialOptions['normalTexture']> {
  const size = 256;
  const height = unwrap(
    normalFromHeight(
      size,
      size,
      (x, y) => {
        const u = (x + y) / size;
        const v = (x - y + size) / size;
        const cell = (t: number) => Math.sin(Math.PI * (t * 2 - Math.floor(t * 2)));
        const seam = Math.min(cell(u), cell(v));
        return Math.sqrt(Math.max(0, seam)) * 3 + fractalNoise(x / size, y / size, 64, 2, 5) * 0.15;
      },
      2,
      mips ? {} : { mips: false },
    ),
  );
  return onUv1(texture('gt-paint-accent-quilt', height), 0.06) as unknown as NonNullable<StandardMaterialOptions['normalTexture']>;
}

export function gtPaintScheme(options: PaintSchemeOptions = {}): Record<GtSlot, (texture: TextureSink) => StandardMaterialOptions> {
  const mips = options.mips !== false;
  const placement = { set: 1, ...(mips ? {} : { mips: false }) } as const;
  const worn = options.weathered ?? true;
  return {
    'gt-paint': (texture) => {
      const m = unwrap(proceduralMaterials.carPaint({ color: PAINT, texture, placement, key: 'gt-paint' }));
      if (!worn) return m;
      // The base colour carries the weathering: white base factor, the paint colour in the texture.
      return { ...m, baseColor: [1, 1, 1, 1], baseColorTexture: weathered(texture, 'gt-paint-worn', PAINT, { chip: PRIMER, chips: 0.3, grime: 0.45, tile: 1.2, seed: 11, mips }) };
    },
    'gt-paint-accent': (texture) => unwrap(proceduralMaterials.carPaint({ color: ACCENT, texture, flake: 0, placement, key: 'gt-paint-accent' })),
    // Quilted seat inserts: the accent with a quilt normal map.
    'gt-paint-accent-quilt': (texture) => ({ ...unwrap(proceduralMaterials.carPaint({ color: ACCENT, texture, flake: 0, placement, key: 'gt-paint-accent' })), normalTexture: quilt(texture, mips), normalScale: [1, 1] }),
    'gt-frame': (texture) => {
      const m = unwrap(proceduralMaterials.metal({ finish: 'brushed', texture, color: [0.26, 0.27, 0.29], placement, key: 'gt-frame' }));
      if (!worn) return m;
      return { ...m, baseColor: [1, 1, 1, 1], baseColorTexture: weathered(texture, 'gt-frame-worn', [0.26, 0.27, 0.29], { chips: 0, grime: 0.75, tile: 0.8, seed: 21, mips }) };
    },
    'gt-metal': (texture) => unwrap(proceduralMaterials.metal({ finish: 'satin', texture, color: [0.66, 0.42, 0.24], placement, key: 'gt-metal' })),
    'gt-metal-steel': (texture) => unwrap(proceduralMaterials.metal({ finish: 'satin', texture, color: [0.62, 0.63, 0.65], placement, key: 'gt-metal-steel' })),
    // Glow: cyan (robot eyes, indicators); white lamps, red tail and amber signal variants.
    'gt-glow': () => unwrap(proceduralMaterials.emissive({ color: [0.3, 0.85, 1], intensity: 8 })),
    // White lamps: LED segments along u (the S6 headlamp recipe).
    'gt-glow-white': (texture) => unwrap(proceduralMaterials.emissive({ color: [1, 0.96, 0.9], intensity: 4, segments: { count: 6, gap: 0.35, texture }, placement: { ...placement, tile: 0.22 }, key: 'gt-glow-white' })),
    'gt-glow-red': () => unwrap(proceduralMaterials.emissive({ color: [1, 0.06, 0.03], intensity: 6 })),
    'gt-glow-amber': () => unwrap(proceduralMaterials.emissive({ color: [1, 0.45, 0.02], intensity: 6 })),
    'gt-primer': (texture) => {
      const m: StandardMaterialOptions = { baseColor: [PRIMER[0], PRIMER[1], PRIMER[2], 1], metallic: 0, roughness: 0.85 };
      if (!worn) return m;
      return { ...m, baseColor: [1, 1, 1, 1], baseColorTexture: weathered(texture, 'gt-primer-worn', [PRIMER[0] * 1.6, PRIMER[1] * 1.6, PRIMER[2] * 1.6], { chips: 0, grime: 0.6, tile: 0.6, seed: 31, mips }) };
    },
    'gt-decal': (texture) => stencilMaterial({ key: 'hazard', size: [1, 1], background: PRIMER, bars: { color: ACCENT, width: 0.125, pitch: 0.25 } })(texture),
    'gt-glass': () => proceduralMaterials.glass({ tint: [0.18, 0.24, 0.28], roughness: 0.04 }),
  };
}

// ---------------------------------------------------------------- stencils

/** A stencil text line: text, cap height and centre in plate meters (x across, y up), ink colour. */
export interface StencilLine {
  readonly text: string;
  readonly height: number;
  readonly at: readonly [number, number];
  readonly color?: readonly [number, number, number];
  /** Stroke weight as a share of the cap height (default 0.16). */
  readonly weight?: number;
}

/**
 * A stencil sheet over a plate of `size` [width, height] meters: a background, diagonal
 * hazard bars, an outline frame and text lines. Its slot is `gt-decal-<key>`.
 */
export interface StencilSpec {
  readonly key: string;
  readonly size: readonly [number, number];
  readonly background: readonly [number, number, number];
  readonly lines?: readonly StencilLine[];
  readonly bars?: { readonly color: readonly [number, number, number]; readonly width: number; readonly pitch: number };
  /** An inset border line: inset and width (meters). */
  readonly frame?: { readonly inset: number; readonly width: number; readonly color?: readonly [number, number, number] };
}

export const stencilSlot = (key: string) => `gt-decal-${key}`;

type DecalLayers = Parameters<typeof proceduralMaterials.decal>[1]['layers'];

/**
 * The decal material of a stencil. The plate's uv1 runs u = x / width over [0, 1] and
 * v = y / width (`stencilPlate`), so the sheet covers the cell [0, 1]^2 in plate-width units.
 */
export function stencilMaterial(spec: StencilSpec): (texture: TextureSink) => StandardMaterialOptions {
  return (texture) => {
    const [w, h] = spec.size;
    const toUv = ([x, y]: readonly [number, number]): Point2 => [0.5 + x / w, 0.5 + y / w];
    const layers: DecalLayers[number][] = [];
    const rgba = (c: readonly [number, number, number]) => [c[0], c[1], c[2], 1] as const;
    if (spec.bars !== undefined) {
      const { width, pitch } = spec.bars;
      for (let k = -Math.ceil((w + h) / pitch); k <= Math.ceil((w + h) / pitch); k++) {
        const x0 = -w / 2 + k * pitch;
        layers.push({ region: [[x0, -h / 2], [x0 + width, -h / 2], [x0 + width + h, h / 2], [x0 + h, h / 2]].map((p) => toUv(p as [number, number])), color: rgba(spec.bars.color) });
      }
    }
    if (spec.frame !== undefined) {
      const { inset, width } = spec.frame;
      const [a, b] = [w / 2 - inset, h / 2 - inset];
      const ring = region2d.stroke([[[-a, -b], [a, -b], [a, b], [-a, b], [-a, -b]].map((p) => toUv(p as [number, number]))], width / w / 2, { join: 'miter' });
      layers.push({ region: unwrap(ring).region, color: rgba(spec.frame.color ?? INK) });
    }
    for (const line of spec.lines ?? []) {
      const strokes = unwrap(textStrokes(line.text, { height: line.height, align: 'center' }));
      const placed = strokes.map((s) => s.map(([x, y]) => toUv([line.at[0] + x, line.at[1] + y - line.height / 2])));
      const region = unwrap(region2d.stroke(placed, ((line.weight ?? 0.16) * line.height) / w / 2, { cap: 'round', join: 'round' }));
      layers.push({ region: region.region, color: rgba(line.color ?? INK) });
    }
    return unwrap(
      proceduralMaterials.decal(
        { baseColor: [1, 1, 1, 1], metallic: 0.15, roughness: 0.4 },
        { width: 256, height: 256, rect: [0, 0, 1, 1], background: rgba(spec.background), layers, texture, key: stencilSlot(spec.key) },
      ),
    );
  };
}

/** A local frame on a surface: origin on the surface, `y` its outward normal, `x` across and `z` along the plate. */
export interface StencilFrame {
  readonly o: Tuple3;
  readonly x: Tuple3;
  readonly y: Tuple3;
  readonly z: Tuple3;
}

/**
 * A flat chamfered stencil plate of `spec.size`, `t` thick, `gap` off the surface at the
 * frame origin, with its own planar uv1 cell, in slot `gt-decal-<key>`. It is built in the
 * frame and moved onto it; tag it as the caller's part. The caller keeps it clear of the
 * surface (a flat plate stands off a curved skin at its corners).
 */
export function stencilPlate(m: Model, spec: StencilSpec, frame: StencilFrame, opts: { readonly t?: number; readonly gap?: number; readonly label?: string } = {}): void {
  const [w, h] = spec.size;
  const t = opts.t ?? 0.003;
  const gap = opts.gap ?? 0.0005;
  const label = opts.label ?? stencilSlot(spec.key);
  const r = Math.min(0.015, w / 6, h / 6);
  const plate = (inset: number, y: number): Tuple3[] => roundedRect(w - 2 * inset, h - 2 * inset, r - inset).map(([x, z]): Tuple3 => [x + w / 2, y, z - w / 2]);
  m.loft({ profiles: [plate(0, gap), plate(0.002, gap + t)], match: 'index', label, material: stencilSlot(spec.key) });
  // Planar along y: u = x / w, v = -z / w; the plate sits in the cell [0, 1]^2 before it is centred.
  m.uv.project({ mode: 'planar', axis: 'y', scale: w, channel: 'uv1', faces: sel.createdBy(label) });
  m.translate(sel.createdBy(label), [-w / 2, 0, w / 2]);
  const e = eulerOf(frame);
  m.rotate(sel.createdBy(label), 'x', e.x);
  m.rotate(sel.createdBy(label), 'y', e.y);
  m.rotate(sel.createdBy(label), 'z', e.z);
  m.translate(sel.createdBy(label), [...frame.o]);
}

/** Euler angles (`Rz * Ry * Rx`, degrees) of the rotation whose columns are the frame axes. */
function eulerOf(f: StencilFrame): { x: number; y: number; z: number } {
  const d = 180 / Math.PI;
  const y = Math.asin(Math.max(-1, Math.min(1, -f.x[2]))) * d;
  // Gimbal lock (x axis vertical): R = Rz Ry with no x turn; the y axis gives the z turn.
  if (Math.abs(f.x[2]) > 1 - 1e-9) return { x: 0, y, z: Math.atan2(-f.y[0], f.y[1]) * d };
  return { x: Math.atan2(f.y[2], f.z[2]) * d, y, z: Math.atan2(f.x[1], f.x[0]) * d };
}

function roundedRect(w: number, d: number, r: number, n = 3): Point2[] {
  const rr = Math.min(r, w / 2 - 1e-4, d / 2 - 1e-4);
  const out: Point2[] = [];
  for (const [cx, cy, a0] of [[w / 2 - rr, d / 2 - rr, 0], [-w / 2 + rr, d / 2 - rr, 90], [-w / 2 + rr, -d / 2 + rr, 180], [w / 2 - rr, -d / 2 + rr, 270]] as const) {
    for (let k = 0; k <= n; k++) {
      const a = ((a0 + (90 * k) / n) * Math.PI) / 180;
      out.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
    }
  }
  return out;
}

/**
 * The shared stencil set of mech-gt: the "07" livery number, a NO STEP walkway mark, a
 * hydraulic pressure plate and a hazard-bar panel. Sizes in meters; owners place them with
 * `stencilPlate` on their anchors and ship `stencilMaterial(spec)` under `stencilSlot(key)`.
 */
export const GT_STENCILS = {
  number: { key: 'number', size: [0.13, 0.1], background: PAINT, lines: [{ text: '07', height: 0.065, at: [0, 0] }] },
  noStep: { key: 'no-step', size: [0.16, 0.05], background: PRIMER, frame: { inset: 0.004, width: 0.003, color: ACCENT }, lines: [{ text: 'NO STEP', height: 0.02, at: [0, 0], color: ACCENT }] },
  hydraulic: { key: 'hyd', size: [0.16, 0.06], background: PRIMER, frame: { inset: 0.003, width: 0.002 }, lines: [{ text: 'HYD 210 BAR', height: 0.011, at: [0, 0.01] }, { text: 'GT-07', height: 0.01, at: [0, -0.012], color: ACCENT }] },
  hazard: { key: 'hazard-panel', size: [0.2, 0.06], background: PRIMER, bars: { color: ACCENT, width: 0.02, pitch: 0.04 } },
} as const satisfies Record<string, StencilSpec>;
