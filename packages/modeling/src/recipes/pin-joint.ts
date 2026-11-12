import { err, ok, type Result } from '@forgeax/engine-types';
import { cos, sin } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import type { DesignedContact } from '../interference';
import { type Model, model } from '../model';
import type { Point2 } from '../primitives';
import { sel } from '../selectors';
import {
  checkAll,
  degrees,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
  revolveCircle,
  vertexRadius,
} from './common';
import { type FitClass, type IsoFit, isoFit } from './fits';

/** Lug proportions (USAF stress manual §9): edge distance and plate thickness. */
export interface LugShape {
  /** Edge distance from the hole centre to the rounded end, as a ratio e/D (default 1.5, at least 1.5). */
  readonly e?: number;
  /** Plate thickness (meters, default d). */
  readonly thickness?: number;
  /** From the pin axis to the plate's square end (meters, default e D + 2 d). */
  readonly length?: number;
}

export interface PinJointOptions extends RecipeNaming {
  /** Nominal pin diameter (meters, 3 mm to 180 mm). */
  readonly d: number;
  /** ISO 286 fit of the pin in every bore (default `'H11/c11'`, loose running). */
  readonly fit?: FitClass;
  /** `double`: a lug in a two-cheek clevis (default); `single`: a lug beside one cheek. */
  readonly shear?: 'double' | 'single';
  readonly lug?: LugShape;
  /** Clevis cheek thickness (meters, default 0.5 d). */
  readonly wall?: number;
  /** Axial gap on each side of the lug (meters, default the larger of 0.2 mm and 0.02 d). */
  readonly gap?: number;
  /** `ring`: a washer and a DIN 471-style retaining ring in a groove (default); `none`: the bare pin end. */
  readonly retainer?: 'ring' | 'none';
  /** Segments around the pin and bores (default the fewest, at least 32, that keep the fit at any rotation). */
  readonly segments?: number;
}

export const PIN_JOINT_RANGES = {
  d: [0.003, 0.18],
  e: [1.5, 4],
  thicknessDiameters: [0.25, 2],
  wallDiameters: [0.25, 1.5],
  gapDiameters: [0, 0.5],
  segments: [12, 512],
} as const satisfies Record<string, Range>;

/**
 * The fewest segments (a multiple of 4, at least `min`) for which a pin of flat radius `r`
 * turned against its bore loses at most half the radial gap `g`: its vertices stand
 * `r (1 / cos(pi / n) - 1)` beyond its flats.
 */
export function fitSegments(r: number, g: number, min = 32): number {
  let n = Math.max(4, Math.ceil(min / 4) * 4);
  while (n < 4096 && r * (1 / cos(Math.PI / n) - 1) > g / 2) n += 4;
  return n;
}

function arc(radius: number, from: number, to: number, steps: number): Point2[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    return [radius * cos(a), radius * sin(a)] as Point2;
  });
}

/**
 * A plate across the +Y pin axis with a bore at the origin, from y = y0 to y0 + t:
 * its rounded end (radius `r`) faces -X when `toward` is +1 (the body runs to +X) and +X
 * when it is -1.
 */
function eyePlate(
  m: Model,
  label: string,
  r: number,
  reach: number,
  toward: 1 | -1,
  bore: number,
  n: number,
  y0: number,
  t: number,
): void {
  const steps = Math.max(8, n / 2);
  const points: Point2[] =
    toward === 1
      ? [[reach, -r], [reach, r], ...arc(r, 90, 270, steps)]
      : [...arc(r, -90, 90, steps), [-reach, r], [-reach, -r]];
  // Built apart, so plates sharing a label (two clevis cheeks) move independently.
  const plate = model();
  plate.extrudePolygon({ points, holes: [revolveCircle(bore, n)], depth: t, label });
  plate.rotate(sel.all(), 'x', -90);
  m.append(plate.snapshot(), { translate: [0, y0, 0] });
}

interface JointShape {
  readonly name: string;
  readonly d: number;
  readonly fit: IsoFit;
  readonly n: number;
  readonly r: number;
  readonly t2: number;
  readonly t1: number;
  readonly gap: number;
  readonly length: number;
  readonly double: boolean;
}

/** Turn of the lug about the pin before its square corners reach the clevis bridge (degrees). */
function swing(length: number, r: number, bridge: number): number {
  const f = (a: number) => length * cos(a) - r * sin(a) + bridge;
  let lo = 0;
  let hi = Math.PI;
  if (f(hi) >= 0) return 180;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) >= 0) lo = mid;
    else hi = mid;
  }
  return degrees(lo);
}

/** Cheeks plus a bridge behind the lug, joined into one closed clevis. */
function clevisBody(s: JointShape, label: string): Result<Uint8Array, ModelingError> {
  const { r, t1, t2, gap, n, d } = s;
  const bore = vertexRadius(s.fit.holeMid / 2, n);
  const rotGap = Math.max(0.25 * d, 0.002);
  const b = Math.max(t1, 0.5 * d);
  const back = r + rotGap + b;
  const inner = t2 / 2 + gap;
  const c = model();
  eyePlate(c, label, r, back, -1, bore, n, -inner - t1, t1);
  if (s.double) eyePlate(c, label, r, back, -1, bore, n, inner, t1);
  const yTop = s.double ? inner + 0.9 * t1 : t2 / 2;
  const yBottom = -inner - 0.9 * t1;
  c.box({
    size: [0.9 * b, yTop - yBottom, 1.8 * r],
    center: [-(r + rotGap) - 0.45 * b, (yTop + yBottom) / 2, 0],
    label: `${label}-bridge`,
  });
  c.union(sel.createdBy(`${label}-bridge`), { label });
  if (c.poisoned !== undefined) return err(c.poisoned);
  return ok(c.snapshot());
}

function shapeOf(name: string, options: PinJointOptions): Result<JointShape, ModelingError> {
  const d = options.d;
  const e = options.lug?.e ?? 1.5;
  const checked = checkAll([() => inRange('d', d, PIN_JOINT_RANGES.d)]);
  if (!checked.ok) return checked;
  if (typeof e !== 'number' || !Number.isFinite(e) || e < 1.5) {
    return err(
      modelingError(
        'model-invalid-argument',
        'a lug edge distance e/D of at least 1.5',
        { e },
        'below e/D = 1.5 shear-out and hoop tension govern the lug (USAF stress manual §9); raise lug.e to 1.5 or more, or use a larger lug',
      ),
    );
  }
  const fit = isoFit(d, options.fit ?? 'H11/c11');
  if (!fit.ok) return fit;
  const t2 = options.lug?.thickness ?? d;
  const t1 = options.wall ?? 0.5 * d;
  const gap = options.gap ?? Math.max(0.0002, 0.02 * d);
  const r = e * d;
  const length = options.lug?.length ?? r + 2 * d;
  const radial = fit.value.clearanceMid / 2;
  const least = fitSegments(fit.value.shaftMid / 2, radial);
  const n = options.segments ?? least;
  const ranges = checkAll([
    () => inRange('lug.e', e, PIN_JOINT_RANGES.e),
    () => inRange('lug.thickness', t2, [0.25 * d, 2 * d]),
    () => inRange('lug.length', length, [r + 0.5 * d, r + 20 * d]),
    () => inRange('wall', t1, [0.25 * d, 1.5 * d]),
    () => inRange('gap', gap, [0, 0.5 * d]),
  ]);
  if (!ranges.ok) return ranges;
  if (!Number.isInteger(n) || n % 4 !== 0 || n < least || n > PIN_JOINT_RANGES.segments[1]) {
    return err(
      modelingError(
        'model-invalid-argument',
        `segments is a multiple of 4 within [${least}, ${PIN_JOINT_RANGES.segments[1]}]`,
        { segments: n, least },
        `fewer than ${least} segments let the faceted pin reach past half the ${(radial * 1e6).toFixed(0)} um radial gap when it turns; use a looser fit or more segments`,
      ),
    );
  }
  return ok({
    name,
    d,
    fit: fit.value,
    n,
    r,
    t2,
    t1,
    gap,
    length,
    double: (options.shear ?? 'double') === 'double',
  });
}

/**
 * Every pair of `labels` as a fit: the recipe's spacing is its design. Pairs in `bands`
 * (keyed `a/b` in label order) carry the distance band they must keep.
 */
function fitsAmong(
  labels: readonly string[],
  bands: ReadonlyMap<string, readonly [number, number]> = new Map(),
): DesignedContact[] {
  const out: DesignedContact[] = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const parts: [string, string] = [labels[i] as string, labels[j] as string];
      const gap = bands.get(parts.join('/'));
      out.push({ parts, kind: 'fit', ...(gap === undefined ? {} : { gap }) });
    }
  }
  return out;
}

/**
 * Pin joint about the +Y axis through the origin: a lug (`<name>-lug`, body along +X) in a
 * clevis (`<name>-clevis`, body along -X; one cheek for `shear: 'single'`), a headed pin
 * (`<name>-pin`, slot `chrome`) and, with the ring retainer, a washer (`<name>-washer`) and a
 * DIN 471-style ring (`<name>-ring`) in a groove of the pin. Every bore takes the ISO 286 hole
 * and the pin the shaft at the middle of their bands, measured across flats, so pin and bore
 * flats stand exactly `radialGap` apart; the segment count keeps the pin inside its bores at
 * any turn. Nothing penetrates: the head, washer and ring sit flush on their faces, the lug
 * clears each cheek by `gap` and the clevis bridge by a quarter diameter. `contacts` declares
 * every pair of the joint's parts a `fit`; bind each label as a rig part of the same name (the
 * lug on the moving joint). Anchors: `axis`, `axisTop`, `axisBottom`, `clevisBase`, `lugEnd`;
 * dimensions include `hole`, `shaft`, `clearance` (diametral, mid band), `radialGap`, `e`,
 * `swing` (degrees the lug turns before its corners reach the bridge) and `segments`.
 */
export function pinJoint(options: PinJointOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'pin-joint';
  const shape = shapeOf(name, options);
  if (!shape.ok) return shape;
  const s = shape.value;
  const { d, n, r, t1, t2, gap, fit } = s;
  const labels = {
    clevis: `${name}-clevis`,
    lug: `${name}-lug`,
    pin: `${name}-pin`,
    washer: `${name}-washer`,
    ring: `${name}-ring`,
  };
  const ring = (options.retainer ?? 'ring') === 'ring';
  if (
    options.retainer !== undefined &&
    options.retainer !== 'ring' &&
    options.retainer !== 'none'
  ) {
    return err(
      modelingError('model-invalid-argument', "retainer 'ring' | 'none'", {
        retainer: options.retainer,
      }),
    );
  }
  const bore = vertexRadius(fit.holeMid / 2, n);
  const pinR = vertexRadius(fit.shaftMid / 2, n);
  const m = model();
  eyePlate(m, labels.lug, r, s.length, 1, bore, n, -t2 / 2, t2);
  const clevis = clevisBody(s, labels.clevis);
  if (!clevis.ok) return clevis;
  m.append(clevis.value);
  const top = s.double ? t2 / 2 + gap + t1 : t2 / 2;
  const bottom = -(t2 / 2 + gap + t1);
  const head = 0.3 * d;
  const headR = vertexRadius(0.8 * d, n);
  const chamfer = 0.05 * d;
  const washerH = 0.15 * d;
  const groove = 0.065 * d;
  const ringT = 0.06 * d;
  const grooveR = vertexRadius((0.95 * fit.shaftMid) / 2, n);
  const seat = ring ? bottom - washerH : bottom;
  const tail = seat - (ring ? groove : 0) - 0.15 * d;
  const pinProfile: Point2[] = [
    [0, tail],
    [pinR - chamfer, tail],
    [pinR, tail + chamfer],
    ...(ring
      ? ([
          [pinR, seat - groove],
          [grooveR, seat - groove],
          [grooveR, seat],
          [pinR, seat],
        ] as Point2[])
      : []),
    [pinR, top],
    [headR, top],
    [headR, top + head - chamfer],
    [headR - chamfer, top + head],
    [0, top + head],
  ];
  m.revolve({ points: pinProfile, segments: n, label: labels.pin });
  if (ring) {
    const ringIn = vertexRadius((0.95 * fit.shaftMid) / 2 + fit.clearanceMid / 2, n);
    const ringOut = vertexRadius(fit.shaftMid / 2 + 0.1 * d, n);
    const washerOut = vertexRadius(0.9 * d, n);
    const annulus = (inner: number, outer: number, y0: number, y1: number): Point2[] => [
      [inner, y0],
      [outer, y0],
      [outer, y1],
      [inner, y1],
      [inner, y0],
    ];
    m.revolve({
      points: annulus(bore, washerOut, seat, bottom),
      segments: n,
      label: labels.washer,
    });
    m.revolve({
      points: annulus(ringIn, ringOut, seat - ringT, seat),
      segments: n,
      label: labels.ring,
    });
  }
  m.assign(sel.all(), 'steel');
  m.assign(sel.createdBy(labels.pin), 'chrome');
  if (m.poisoned !== undefined) return err(m.poisoned);
  const rotGap = Math.max(0.25 * d, 0.002);
  const back = r + rotGap + Math.max(t1, 0.5 * d);
  const parts = ring
    ? [labels.clevis, labels.lug, labels.pin, labels.washer, labels.ring]
    : [labels.clevis, labels.lug, labels.pin];
  const finished = finishPart(
    m,
    name,
    {
      axis: [0, 0, 0],
      axisTop: [0, top + head, 0],
      axisBottom: [0, tail, 0],
      clevisBase: [-back, 0, 0],
      lugEnd: [s.length, 0, 0],
    },
    {
      d,
      hole: fit.holeMid,
      shaft: fit.shaftMid,
      clearance: fit.clearanceMid,
      radialGap: fit.clearanceMid / 2,
      e: r / d,
      edge: r,
      lugThickness: t2,
      wall: t1,
      gap,
      swing: swing(s.length, r, r + rotGap),
      segments: n,
    },
  );
  if (!finished.ok) return finished;
  // Bands: bores take the ISO 286 radial clearance band; the head (double shear: on the
  // clevis, single: on the lug), washer and ring sit flush; the lug clears each cheek by gap.
  const radial = [fit.clearance[0] / 2, fit.clearance[1] / 2] as const;
  const flush = [0, 0] as const;
  const upTo = [0, fit.clearance[1] / 2] as const;
  const join = (x: string, y: string) => `${x}/${y}`;
  const bands = new Map<string, readonly [number, number]>([
    [join(labels.clevis, labels.lug), [gap / 2, 2 * gap]],
    [join(labels.clevis, labels.pin), s.double ? upTo : radial],
    [join(labels.lug, labels.pin), s.double ? radial : upTo],
  ]);
  if (ring) {
    bands.set(join(labels.clevis, labels.washer), flush);
    bands.set(join(labels.pin, labels.washer), radial);
    bands.set(join(labels.pin, labels.ring), flush);
    bands.set(join(labels.washer, labels.ring), flush);
  }
  return ok({ ...finished.value, contacts: fitsAmong(parts, bands) });
}

export interface LugOptions extends RecipeNaming, LugShape {
  /** Nominal pin diameter (meters). */
  readonly d: number;
  /** ISO 286 fit of the bore (default `'H11/c11'`). */
  readonly fit?: FitClass;
  readonly segments?: number;
}

/**
 * A single lug across the +Y pin axis (`<name>`, slot `steel`): plate `thickness` thick,
 * centred on y = 0, rounded at the bore end (edge distance `e` D, at least 1.5 D) with its body
 * along +X, the bore at the ISO 286 hole mid size. Anchors `axis`, `end`; dimensions `hole`,
 * `shaft` (the pin it fits), `radialGap`, `edge`, `thickness`, `segments`.
 */
export function lug(options: LugOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'lug';
  const shape = shapeOf(name, {
    d: options.d,
    ...(options.fit === undefined ? {} : { fit: options.fit }),
    ...(options.segments === undefined ? {} : { segments: options.segments }),
    lug: {
      ...(options.e === undefined ? {} : { e: options.e }),
      ...(options.thickness === undefined ? {} : { thickness: options.thickness }),
      ...(options.length === undefined ? {} : { length: options.length }),
    },
  });
  if (!shape.ok) return shape;
  const { fit, n, r, t2, length } = shape.value;
  const m = model();
  eyePlate(m, name, r, length, 1, vertexRadius(fit.holeMid / 2, n), n, -t2 / 2, t2);
  m.assign(sel.all(), 'steel');
  return finishPart(
    m,
    name,
    { axis: [0, 0, 0], end: [length, 0, 0] },
    {
      hole: fit.holeMid,
      shaft: fit.shaftMid,
      radialGap: fit.clearanceMid / 2,
      edge: r,
      thickness: t2,
      segments: n,
    },
  );
}

export interface ClevisOptions extends RecipeNaming {
  /** Nominal pin diameter (meters). */
  readonly d: number;
  readonly fit?: FitClass;
  /** Edge distance of the cheeks as e/D (default 1.5, at least 1.5). */
  readonly e?: number;
  /** Cheek thickness (default 0.5 d). */
  readonly wall?: number;
  /** Width between the cheeks (default d plus twice the joint's axial gap). */
  readonly slot?: number;
  /** `double` (default): two cheeks; `single`: the -Y cheek only. */
  readonly shear?: 'double' | 'single';
  readonly segments?: number;
}

/**
 * A clevis about the +Y pin axis (`<name>`, slot `steel`): cheeks with bores at the ISO 286
 * hole mid size either side of a `slot` centred on y = 0, rounded at the bore end, joined by a
 * bridge along -X a quarter diameter behind a lug of edge distance `e` D. Anchors `axis`,
 * `base` (the bridge's back); dimensions `hole`, `shaft`, `radialGap`, `slot`, `wall`, `segments`.
 */
export function clevis(options: ClevisOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'clevis';
  const gap = Math.max(0.0002, 0.02 * options.d);
  const slot = options.slot ?? options.d + 2 * gap;
  const shape = shapeOf(name, {
    d: options.d,
    ...(options.fit === undefined ? {} : { fit: options.fit }),
    ...(options.segments === undefined ? {} : { segments: options.segments }),
    ...(options.wall === undefined ? {} : { wall: options.wall }),
    ...(options.shear === undefined ? {} : { shear: options.shear }),
    lug: { ...(options.e === undefined ? {} : { e: options.e }), thickness: slot },
    gap: 0,
  });
  if (!shape.ok) return shape;
  const body = clevisBody(shape.value, name);
  if (!body.ok) return body;
  const m = model();
  m.append(body.value);
  m.assign(sel.all(), 'steel');
  const { d, r, t1, fit } = shape.value;
  return finishPart(
    m,
    name,
    { axis: [0, 0, 0], base: [-(r + Math.max(0.25 * d, 0.002) + Math.max(t1, 0.5 * d)), 0, 0] },
    {
      hole: fit.holeMid,
      shaft: fit.shaftMid,
      radialGap: fit.clearanceMid / 2,
      slot,
      wall: t1,
      segments: shape.value.n,
    },
  );
}
