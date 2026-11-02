import { err, ok, type Result } from '@forgeax/engine-types';
import { cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { textRegion } from './text';
import { coverage } from './texture';
import type { TrimAnalyticSource, TrimSignature, TrimTiling } from './trim';

/**
 * Analytic stamps: detail modules written as signed-distance shapes with
 * height profiles, rasterized straight into a trim region (no high poly, no rays). Each
 * returns the module fields (`size`, optional `tiling` / `period`, `source`, `signature`) to
 * spread into a `TrimModule` with an id: `{ id: 'bolt', ...stamp.boltHex({ ... }) }`.
 *
 * Normals are exact per sample: the surface a sample lands on (top, chamfer, dome, plate)
 * gives its normal, as a ray bake sees it; vertical walls are never seen.
 */

/** Module fields a stamp produces. */
export interface Stamp {
  readonly size: readonly [number, number];
  readonly tiling?: TrimTiling;
  readonly period?: number;
  readonly source: TrimAnalyticSource;
  readonly signature: TrimSignature;
}

type V2 = readonly [number, number];

/** Signed distance in the module plane (negative inside) and its unit gradient. */
type Shape = (s: number, t: number) => { readonly d: number; readonly g: V2 };

/** Height and its derivative along the outward distance. */
type Profile = (d: number) => { readonly h: number; readonly slope: number };

interface Layer {
  readonly shape: Shape;
  readonly profile: Profile;
  /** 'raise' keeps the higher surface; 'cut' lowers inside the shape to the profile. */
  readonly op: 'raise' | 'cut';
  readonly material?: string;
}

/** A stamp surface: the plane z = 0 raised and cut by layers in order. */
function surface(layers: readonly Layer[], base: string) {
  const at = (s: number, t: number) => {
    let h = 0;
    let n: [number, number] = [0, 0];
    let material = base;
    for (const layer of layers) {
      const { d, g } = layer.shape(s, t);
      if (layer.op === 'cut' && d >= 0) continue;
      const { h: lh, slope } = layer.profile(d);
      if (layer.op === 'raise' ? lh > h : lh < h) {
        h = lh;
        n = [-slope * g[0], -slope * g[1]];
        if (layer.material !== undefined) material = layer.material;
      }
    }
    return { h, n, material };
  };
  return {
    height: (s: number, t: number) => at(s, t).h,
    normal: (s: number, t: number): readonly [number, number, number] => {
      const { n } = at(s, t);
      return [n[0], n[1], 1];
    },
    material: (s: number, t: number) => at(s, t).material,
  };
}

// ---- shapes ----------------------------------------------------------------------------

function circle(cx: number, cy: number, r: number): Shape {
  return (s, t) => {
    const x = s - cx;
    const y = t - cy;
    const len = Math.sqrt(x * x + y * y);
    return { d: len - r, g: len > 0 ? [x / len, y / len] : [1, 0] };
  };
}

/** Convex polygon as the max of its edge planes: exact on chamfer faces (one plane per edge). */
function planes(cx: number, cy: number, normals: readonly V2[], apothem: number): Shape {
  return (s, t) => {
    const x = s - cx;
    const y = t - cy;
    let best = -Infinity;
    let g: V2 = [1, 0];
    for (const n of normals) {
      const d = x * n[0] + y * n[1] - apothem;
      if (d > best) {
        best = d;
        g = n;
      }
    }
    return { d: best, g };
  };
}

/** A capsule: distance to the segment a-b minus r. */
function capsule(a: V2, b: V2, r: number): Shape {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const ll = ex * ex + ey * ey;
  return (s, t) => {
    const px = s - a[0];
    const py = t - a[1];
    const k = ll > 0 ? Math.max(0, Math.min(1, (px * ex + py * ey) / ll)) : 0;
    const x = px - ex * k;
    const y = py - ey * k;
    const len = Math.sqrt(x * x + y * y);
    return { d: len - r, g: len > 0 ? [x / len, y / len] : [0, 1] };
  };
}

/** Distance across a line t = t0 (a groove or bead running along s). */
function band(t0: number, halfWidth: number): Shape {
  return (_s, t) => ({ d: Math.abs(t - t0) - halfWidth, g: [0, t >= t0 ? 1 : -1] });
}

// ---- profiles --------------------------------------------------------------------------

/** A flat top at `height` with a 45 degree chamfer `chamfer` wide at its rim; 0 outside. */
function flatTop(height: number, chamfer: number): Profile {
  return (d) => {
    if (d > 0) return { h: 0, slope: 0 };
    if (-d >= chamfer) return { h: height, slope: 0 };
    return { h: height - chamfer - d, slope: -1 };
  };
}

/** A spherical cap of base radius `radius` and `height` over the outward distance from its rim. */
function dome(height: number, radius: number): Profile {
  const R = (radius * radius + height * height) / (2 * height);
  return (d) => {
    const r = d + radius;
    if (d > 0) return { h: 0, slope: 0 };
    const root = Math.sqrt(Math.max(0, R * R - r * r));
    return { h: root - (R - height), slope: root > 0 ? -r / root : -1e6 };
  };
}

/** A floor `depth` below the plane with 45 degree walls `chamfer` wide (cut layers). */
function floor(depth: number, chamfer: number): Profile {
  return (d) => {
    if (chamfer > 0 && -d < chamfer) return { h: d, slope: 1 };
    return { h: -depth, slope: 0 };
  };
}

/** A V (or flat-bottomed U) groove profile across a band. */
function grooveProfile(depth: number, halfWidth: number, shape: 'v' | 'u'): Profile {
  if (shape === 'u') return floor(depth, 0);
  return (d) => {
    const k = depth / halfWidth;
    return { h: -depth - k * d, slope: -k };
  };
}

// ---- checks ----------------------------------------------------------------------------

function positive(name: string, v: unknown): Result<number, ModelingError> {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    return err(
      modelingError('model-invalid-argument', `${name} is a positive length in meters`, {
        [name]: v,
      }),
    );
  }
  return ok(v);
}

function check(values: Record<string, unknown>): Result<void, ModelingError> {
  for (const [name, v] of Object.entries(values)) {
    const r = positive(name, v);
    if (!r.ok) return r;
  }
  return ok(undefined);
}

function signature(
  id: string,
  params: Record<string, number | string | boolean | undefined>,
): TrimSignature {
  const clean: Record<string, number | string | boolean> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined) clean[k] = v;
  return { id: `stamp.${id}`, params: clean };
}

const BASE = 'trim-base';

// ---- stamps ----------------------------------------------------------------------------

export interface BoltHexOptions {
  /** Width across flats in meters (ISO `s`: M12 is 0.018). */
  readonly across: number;
  /** Head height (ISO `k`). */
  readonly height: number;
  /** 45 degree rim chamfer width (default 0.05 x across, as `recipes.hexBolt`). */
  readonly chamfer?: number;
  /** Turn of the hexagon in degrees (default 0: flats face +-s). */
  readonly rotation?: number;
  /** A washer under the head: outer diameter and thickness. */
  readonly washer?: { readonly diameter: number; readonly height: number };
  /** Clear border around the head as a fraction of its corner diameter (default 0.15). */
  readonly margin?: number;
  readonly material?: string;
}

/** ISO 4014-style hex head seen from above (the `recipes.hexBolt` head on a plate). */
export function boltHex(options: BoltHexOptions): Result<Stamp, ModelingError> {
  const chamfer = options.chamfer ?? 0.05 * options.across;
  const c = check({ across: options.across, height: options.height });
  if (!c.ok) return c;
  if (!(Number.isFinite(chamfer) && chamfer >= 0 && chamfer < options.height)) {
    return err(
      modelingError('model-invalid-argument', 'chamfer is a length in [0, height)', { chamfer }),
    );
  }
  const corner = options.across / Math.sqrt(3);
  const outer = Math.max(corner, (options.washer?.diameter ?? 0) / 2);
  const margin = options.margin ?? 0.15;
  const side = 2 * outer * (1 + margin);
  const center = side / 2;
  const turn = ((options.rotation ?? 0) * Math.PI) / 180;
  const normals: V2[] = [];
  for (let i = 0; i < 6; i++)
    normals.push([cos(turn + (i * Math.PI) / 3), sin(turn + (i * Math.PI) / 3)]);
  const layers: Layer[] = [];
  let base = 0;
  if (options.washer !== undefined) {
    const w = check({
      washerDiameter: options.washer.diameter,
      washerHeight: options.washer.height,
    });
    if (!w.ok) return w;
    base = options.washer.height;
    layers.push({
      shape: circle(center, center, options.washer.diameter / 2),
      profile: flatTop(base, 0),
      op: 'raise',
    });
  }
  const head = flatTop(options.height, chamfer);
  layers.push({
    shape: planes(center, center, normals, options.across / 2),
    profile: (d) => {
      const p = head(d);
      return d > 0 ? p : { h: p.h + base, slope: p.slope };
    },
    op: 'raise',
    ...(options.material === undefined ? {} : { material: options.material }),
  });
  return ok({
    size: [side, side],
    source: { kind: 'analytic', ...surface(layers, BASE) },
    signature: signature('boltHex', {
      across: options.across,
      height: options.height,
      chamfer,
      rotation: options.rotation ?? 0,
      washerDiameter: options.washer?.diameter,
      washerHeight: options.washer?.height,
      margin,
      material: options.material,
    }),
  });
}

export interface RivetOptions {
  /** Head diameter in meters. */
  readonly diameter: number;
  /** Dome height (default 0.4 x diameter, a round head). */
  readonly height?: number;
  readonly margin?: number;
  readonly material?: string;
}

/** A round (dome) rivet or button head: a spherical cap. */
export function rivet(options: RivetOptions): Result<Stamp, ModelingError> {
  const height = options.height ?? 0.4 * options.diameter;
  const c = check({ diameter: options.diameter, height });
  if (!c.ok) return c;
  const margin = options.margin ?? 0.15;
  const side = options.diameter * (1 + 2 * margin);
  const layers: Layer[] = [
    {
      shape: circle(side / 2, side / 2, options.diameter / 2),
      profile: dome(height, options.diameter / 2),
      op: 'raise',
      ...(options.material === undefined ? {} : { material: options.material }),
    },
  ];
  return ok({
    size: [side, side],
    source: { kind: 'analytic', ...surface(layers, BASE) },
    signature: signature('rivet', {
      diameter: options.diameter,
      height,
      margin,
      material: options.material,
    }),
  });
}

export interface HoleOptions {
  readonly diameter: number;
  readonly depth: number;
  /** 45 degree countersink width at the rim (default 0). */
  readonly chamfer?: number;
  readonly margin?: number;
  /** Slot of the hole floor (default 'hole', so a material can darken it). */
  readonly material?: string;
}

/** A round hole (blind, or dark-floored through-hole) with an optional countersink. */
export function hole(options: HoleOptions): Result<Stamp, ModelingError> {
  const c = check({ diameter: options.diameter, depth: options.depth });
  if (!c.ok) return c;
  const chamfer = options.chamfer ?? 0;
  const margin = options.margin ?? 0.15;
  const side = (options.diameter + 2 * chamfer) * (1 + 2 * margin);
  const layers: Layer[] = [
    {
      shape: circle(side / 2, side / 2, options.diameter / 2 + chamfer),
      profile: floor(options.depth, chamfer),
      op: 'cut',
      material: options.material ?? 'hole',
    },
  ];
  return ok({
    size: [side, side],
    source: { kind: 'analytic', ...surface(layers, BASE) },
    signature: signature('hole', {
      diameter: options.diameter,
      depth: options.depth,
      chamfer,
      margin,
      material: options.material,
    }),
  });
}

export interface SlotOptions {
  /** Overall length (end to end) and width of the stadium. */
  readonly length: number;
  readonly width: number;
  readonly depth: number;
  readonly chamfer?: number;
  readonly margin?: number;
  readonly material?: string;
}

/** A stadium slot (a long hole with round ends) along s. */
export function slot(options: SlotOptions): Result<Stamp, ModelingError> {
  const c = check({ length: options.length, width: options.width, depth: options.depth });
  if (!c.ok) return c;
  if (options.width > options.length) {
    return err(
      modelingError('model-invalid-argument', 'a slot is at least as long as it is wide', {
        length: options.length,
        width: options.width,
      }),
    );
  }
  const chamfer = options.chamfer ?? 0;
  const margin = options.margin ?? 0.15;
  const pad = (options.width + 2 * chamfer) * margin;
  const size: [number, number] = [
    options.length + 2 * chamfer + 2 * pad,
    options.width + 2 * chamfer + 2 * pad,
  ];
  const r = options.width / 2;
  const cy = size[1] / 2;
  const layers: Layer[] = [
    {
      shape: capsule([pad + chamfer + r, cy], [size[0] - pad - chamfer - r, cy], r + chamfer),
      profile: floor(options.depth, chamfer),
      op: 'cut',
      material: options.material ?? 'hole',
    },
  ];
  return ok({
    size,
    source: { kind: 'analytic', ...surface(layers, BASE) },
    signature: signature('slot', {
      length: options.length,
      width: options.width,
      depth: options.depth,
      chamfer,
      margin,
      material: options.material,
    }),
  });
}

/** Strip fields shared by the tileable stamps: length is a whole number of periods. */
interface StripOptions {
  /** Strip length in meters (default 8 periods); the sheet width holds it. */
  readonly length?: number;
}

function stripLength(options: StripOptions, period: number): Result<number, ModelingError> {
  const length = options.length ?? 8 * period;
  const c = positive('length', length);
  if (!c.ok) return c;
  return ok(length);
}

export interface GrooveOptions extends StripOptions {
  readonly width: number;
  readonly depth: number;
  /** 'v' (default) or 'u' (flat bottom). */
  readonly profile?: 'v' | 'u';
  /** Strip height across the groove (default 3 x width). */
  readonly band?: number;
  readonly material?: string;
}

/** A panel groove running along u: a tileable strip (`tiling: 'u'`). */
export function groove(options: GrooveOptions): Result<Stamp, ModelingError> {
  const c = check({ width: options.width, depth: options.depth });
  if (!c.ok) return c;
  const profile = options.profile ?? 'v';
  if (profile !== 'v' && profile !== 'u') {
    return err(modelingError('model-invalid-argument', "profile is 'v' or 'u'", { profile }));
  }
  const band0 = options.band ?? 3 * options.width;
  const period = options.width;
  const length = stripLength(options, period);
  if (!length.ok) return length;
  const layers: Layer[] = [
    {
      shape: band(band0 / 2, options.width / 2),
      profile: grooveProfile(options.depth, options.width / 2, profile),
      op: 'cut',
      ...(options.material === undefined ? {} : { material: options.material }),
    },
  ];
  return ok({
    size: [length.value, band0],
    tiling: 'u',
    period,
    source: { kind: 'analytic', ...surface(layers, BASE) },
    signature: signature('groove', {
      width: options.width,
      depth: options.depth,
      profile,
      band: band0,
      length: length.value,
      material: options.material,
    }),
  });
}

/** Coordinates folded into one period cell [0, p) x [0, q). */
function cell(s: number, t: number, p: number, q: number): [number, number] {
  return [s - p * Math.floor(s / p), t - q * Math.floor(t / q)];
}

export interface PerforationOptions extends StripOptions {
  readonly diameter: number;
  /** Center spacing along both axes. */
  readonly pitch: number;
  readonly depth: number;
  /** 'square' (default) or 'staggered' (every other row shifted half a pitch). */
  readonly pattern?: 'square' | 'staggered';
  /** Rows across the strip (default 4). */
  readonly rows?: number;
  readonly material?: string;
}

/** A perforated sheet: a hole grid, tileable along u. */
export function perforation(options: PerforationOptions): Result<Stamp, ModelingError> {
  const c = check({ diameter: options.diameter, pitch: options.pitch, depth: options.depth });
  if (!c.ok) return c;
  if (options.diameter >= options.pitch) {
    return err(
      modelingError('model-invalid-argument', 'holes are narrower than their pitch', {
        diameter: options.diameter,
        pitch: options.pitch,
      }),
    );
  }
  const pattern = options.pattern ?? 'square';
  const rows = options.rows ?? 4;
  if (!(Number.isInteger(rows) && rows >= 1) || (pattern !== 'square' && pattern !== 'staggered')) {
    return err(
      modelingError(
        'model-invalid-argument',
        "rows is a whole count and pattern 'square' or 'staggered'",
        { rows, pattern },
      ),
    );
  }
  const p = options.pitch;
  const length = stripLength(options, p);
  if (!length.ok) return length;
  const r = options.diameter / 2;
  const q = pattern === 'staggered' ? 2 * p : p;
  const holes: V2[] =
    pattern === 'staggered'
      ? [
          [p / 2, p / 2],
          [0, 1.5 * p],
          [p, 1.5 * p],
        ]
      : [[p / 2, p / 2]];
  const shape: Shape = (s, t) => {
    const [x, y] = cell(s, t, p, q);
    let best = { d: Infinity, g: [1, 0] as V2 };
    for (const [hx, hy] of holes) {
      const e = circle(hx, hy, r)(x, y);
      if (e.d < best.d) best = e;
    }
    return best;
  };
  const layers: Layer[] = [
    { shape, profile: floor(options.depth, 0), op: 'cut', material: options.material ?? 'hole' },
  ];
  return ok({
    size: [length.value, rows * p],
    tiling: 'u',
    period: p,
    source: { kind: 'analytic', ...surface(layers, BASE) },
    signature: signature('perforation', {
      diameter: options.diameter,
      pitch: p,
      depth: options.depth,
      pattern,
      rows,
      length: length.value,
      material: options.material,
    }),
  });
}

export interface TreadPlateOptions extends StripOptions {
  /** Lug spacing (a lug pair per pitch x pitch cell). */
  readonly pitch: number;
  /** Lug height (default 0.06 x pitch). */
  readonly height?: number;
  /** Lug length and width (default 0.7 and 0.18 x pitch). */
  readonly lug?: { readonly length: number; readonly width: number };
  /** Rows across the strip (default 4). */
  readonly rows?: number;
  readonly material?: string;
}

/** Diamond (tread) plate: crossed elongated lugs on a pitch grid, tileable along u. */
export function treadPlate(options: TreadPlateOptions): Result<Stamp, ModelingError> {
  const p = options.pitch;
  const height = options.height ?? 0.06 * p;
  const lug = options.lug ?? { length: 0.7 * p, width: 0.18 * p };
  const c = check({ pitch: p, height, lugLength: lug.length, lugWidth: lug.width });
  if (!c.ok) return c;
  const rows = options.rows ?? 4;
  if (!(Number.isInteger(rows) && rows >= 1)) {
    return err(modelingError('model-invalid-argument', 'rows is a whole count', { rows }));
  }
  const length = stripLength(options, p);
  if (!length.ok) return length;
  const h = (lug.length - lug.width) / (2 * Math.SQRT2);
  const lugs: Shape[] = [
    capsule([p / 4 - h, p / 4 - h], [p / 4 + h, p / 4 + h], lug.width / 2),
    capsule([(3 * p) / 4 - h, (3 * p) / 4 + h], [(3 * p) / 4 + h, (3 * p) / 4 - h], lug.width / 2),
  ];
  const shape: Shape = (s, t) => {
    const [x, y] = cell(s, t, p, p);
    let best = { d: Infinity, g: [1, 0] as V2 };
    for (const l of lugs) {
      for (const [ox, oy] of [
        [0, 0],
        [p, 0],
        [-p, 0],
        [0, p],
        [0, -p],
      ] as const) {
        const e = l(x + ox, y + oy);
        if (e.d < best.d) best = e;
      }
    }
    return best;
  };
  const layers: Layer[] = [
    {
      shape,
      profile: dome(height, lug.width / 2),
      op: 'raise',
      ...(options.material === undefined ? {} : { material: options.material }),
    },
  ];
  return ok({
    size: [length.value, rows * p],
    tiling: 'u',
    period: p,
    source: { kind: 'analytic', ...surface(layers, BASE) },
    signature: signature('treadPlate', {
      pitch: p,
      height,
      lugLength: lug.length,
      lugWidth: lug.width,
      rows,
      length: length.value,
      material: options.material,
    }),
  });
}

export interface KnurlOptions extends StripOptions {
  /** Spacing of each groove family, measured across the grooves. */
  readonly pitch: number;
  /** Pyramid height from groove floor to tip. */
  readonly depth: number;
  /** Angle of each family to the strip's u axis in degrees (default 45: square diamonds). */
  readonly angle?: number;
  /** Rows of diamonds across the strip (default 4). */
  readonly rows?: number;
  readonly material?: string;
}

/**
 * Diamond knurl: two families of V grooves crossing at +-angle, leaving flat-sided
 * pyramids; tileable along u with period pitch / sin(angle).
 */
export function knurl(options: KnurlOptions): Result<Stamp, ModelingError> {
  const c = check({ pitch: options.pitch, depth: options.depth });
  if (!c.ok) return c;
  const angle = options.angle ?? 45;
  const rows = options.rows ?? 4;
  if (
    !(Number.isFinite(angle) && angle >= 15 && angle <= 75) ||
    !(Number.isInteger(rows) && rows >= 1)
  ) {
    return err(
      modelingError(
        'model-invalid-argument',
        'angle is in [15, 75] degrees and rows a whole count',
        {
          angle,
          rows,
        },
      ),
    );
  }
  const a = (angle * Math.PI) / 180;
  const [sa, ca] = [sin(a), cos(a)];
  const period = options.pitch / sa;
  const length = stripLength(options, period);
  if (!length.ok) return length;
  const families: V2[] = [
    [sa / options.pitch, ca / options.pitch],
    [sa / options.pitch, -ca / options.pitch],
  ];
  /** Height and gradient: the lower of the two triangle waves (tips at phase 0.5). */
  const field = (s: number, t: number) => {
    let best = { h: Infinity, gs: 0, gt: 0 };
    for (const [ks, kt] of families) {
      const phase = s * ks + t * kt;
      const f = phase - Math.floor(phase);
      const h = options.depth * (1 - 2 * Math.abs(f - 0.5));
      const slope = options.depth * (f < 0.5 ? 2 : -2);
      if (h < best.h) best = { h, gs: slope * ks, gt: slope * kt };
    }
    return best;
  };
  const material = options.material;
  return ok({
    size: [length.value, (rows * options.pitch) / ca],
    tiling: 'u',
    period,
    source: {
      kind: 'analytic',
      height: (s, t) => field(s, t).h,
      normal: (s, t) => {
        const { gs, gt } = field(s, t);
        return [-gs, -gt, 1];
      },
      ...(material === undefined ? {} : { material }),
    },
    signature: signature('knurl', {
      pitch: options.pitch,
      depth: options.depth,
      angle,
      rows,
      length: length.value,
      material,
    }),
  });
}

export interface WeldBeadOptions extends StripOptions {
  readonly width: number;
  /** Bead crown height (default 0.25 x width). */
  readonly height?: number;
  /** Ripple spacing along the bead (default 0.4 x width) and relative depth (default 0.15). */
  readonly ripple?: { readonly pitch: number; readonly depth: number };
  /** Strip height across the bead (default 2 x width). */
  readonly band?: number;
  readonly material?: string;
}

/** A weld bead along u: a round crown with chevron ripples, tileable along u. */
export function weldBead(options: WeldBeadOptions): Result<Stamp, ModelingError> {
  const height = options.height ?? 0.25 * options.width;
  const ripple = options.ripple ?? { pitch: 0.4 * options.width, depth: 0.15 };
  const c = check({ width: options.width, height, ripplePitch: ripple.pitch });
  if (!c.ok) return c;
  if (!(Number.isFinite(ripple.depth) && ripple.depth >= 0 && ripple.depth < 1)) {
    return err(
      modelingError('model-invalid-argument', 'ripple depth is a fraction in [0, 1)', {
        depth: ripple.depth,
      }),
    );
  }
  const length = stripLength(options, ripple.pitch);
  if (!length.ok) return length;
  const bandHeight = options.band ?? 2 * options.width;
  const half = options.width / 2;
  const crown = dome(height, half);
  const t0 = bandHeight / 2;
  const k = (2 * Math.PI) / ripple.pitch;
  const height2 = (s: number, t: number) => {
    const d = Math.abs(t - t0) - half;
    if (d > 0) return { h: 0, ds: 0, dt: 0 };
    const { h, slope } = crown(d);
    const phase = k * (s + 0.5 * Math.abs(t - t0));
    const wave = 1 - ripple.depth * 0.5 * (1 - cos(phase));
    const dWave = -ripple.depth * 0.5 * sin(phase) * k;
    const sign = t >= t0 ? 1 : -1;
    return { h: h * wave, ds: h * dWave, dt: slope * sign * wave + h * dWave * 0.5 * sign };
  };
  const material = options.material ?? 'weld';
  return ok({
    size: [length.value, bandHeight],
    tiling: 'u',
    period: ripple.pitch,
    source: {
      kind: 'analytic',
      height: (s, t) => height2(s, t).h,
      normal: (s, t) => {
        const { ds, dt } = height2(s, t);
        return [-ds, -dt, 1];
      },
      material: (_s, t) => (Math.abs(t - t0) <= half ? material : BASE),
    },
    signature: signature('weldBead', {
      width: options.width,
      height,
      ripplePitch: ripple.pitch,
      rippleDepth: ripple.depth,
      band: bandHeight,
      length: length.value,
      material,
    }),
  });
}

export interface TextStampOptions {
  readonly text: string;
  /** Cap height in meters. */
  readonly height: number;
  /** Positive embosses, negative engraves (meters). */
  readonly depth: number;
  /** Stroke weight as a fraction of the cap height (default 0.12, as `textRegion`). */
  readonly weight?: number;
  readonly tracking?: number;
  /** Border around the text block in cap heights (default 0.25). */
  readonly margin?: number;
  readonly material?: string;
}

/**
 * Engraved or embossed text (`textRegion` outlines rastered by `coverage`): the height
 * is depth x coverage of a raster at 64 samples per cap height, read bilinearly, so the
 * stroke edges get a one-sample slope.
 */
export function text(options: TextStampOptions): Result<Stamp, ModelingError> {
  const c = check({ height: options.height });
  if (!c.ok) return c;
  if (!(Number.isFinite(options.depth) && options.depth !== 0)) {
    return err(
      modelingError('model-invalid-argument', 'depth is a nonzero length (negative engraves)', {
        depth: options.depth,
      }),
    );
  }
  const region = textRegion(options.text, {
    height: options.height,
    ...(options.weight === undefined ? {} : { weight: options.weight }),
    ...(options.tracking === undefined ? {} : { tracking: options.tracking }),
  });
  if (!region.ok) return region;
  const margin = (options.margin ?? 0.25) * options.height;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const shape of region.value.region) {
    for (const [x, y] of shape.outer) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  const size: [number, number] = [x1 - x0 + 2 * margin, y1 - y0 + 2 * margin];
  const per = 64 / options.height;
  const w = Math.max(2, Math.min(4096, Math.ceil(size[0] * per)));
  const h = Math.max(2, Math.min(4096, Math.ceil(size[1] * per)));
  const raster = coverage(region.value.region, w, h, [
    x0 - margin,
    y0 - margin,
    x1 + margin,
    y1 + margin,
  ]);
  const sample = (s: number, t: number) => {
    const fx = Math.max(0, Math.min(w - 1, (s / size[0]) * w - 0.5));
    const fy = Math.max(0, Math.min(h - 1, (t / size[1]) * h - 0.5));
    const ix = Math.min(w - 2, Math.floor(fx));
    const iy = Math.min(h - 2, Math.floor(fy));
    const ax = fx - ix;
    const ay = fy - iy;
    const at = (i: number, j: number) => raster[j * w + i] as number;
    return (
      (at(ix, iy) * (1 - ax) + at(ix + 1, iy) * ax) * (1 - ay) +
      (at(ix, iy + 1) * (1 - ax) + at(ix + 1, iy + 1) * ax) * ay
    );
  };
  const material = options.material;
  return ok({
    size,
    source: {
      kind: 'analytic',
      height: (s, t) => options.depth * sample(s, t),
      material: (s, t) => (material !== undefined && sample(s, t) >= 0.5 ? material : BASE),
    },
    signature: signature('text', {
      text: options.text,
      height: options.height,
      depth: options.depth,
      weight: options.weight,
      tracking: options.tracking,
      margin: options.margin,
      material,
    }),
  });
}

/** The stamp library. */
export const stamp = {
  boltHex,
  rivet,
  hole,
  slot,
  groove,
  perforation,
  treadPlate,
  knurl,
  weldBead,
  text,
} as const;
