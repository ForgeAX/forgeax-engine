import type { Result } from '@forgeax/engine-types';
import { cos } from '../dmath';
import type { ModelingError } from '../errors';
import { type Model, model } from '../model';
import type { Point2 } from '../primitives';
import { type FaceSelector, sel } from '../selectors';
import {
  checkAll,
  circle,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
  revolveCircle,
} from './common';

/** ISO metric coarse sizes: thread diameter, pitch, hex across flats, head and nut heights (mm). */
export const METRIC_SIZES = {
  M3: { d: 3, pitch: 0.5, s: 5.5, k: 2, m: 2.4 },
  M4: { d: 4, pitch: 0.7, s: 7, k: 2.8, m: 3.2 },
  M5: { d: 5, pitch: 0.8, s: 8, k: 3.5, m: 4.7 },
  M6: { d: 6, pitch: 1, s: 10, k: 4, m: 5.2 },
  M8: { d: 8, pitch: 1.25, s: 13, k: 5.3, m: 6.8 },
  M10: { d: 10, pitch: 1.5, s: 16, k: 6.4, m: 8.4 },
  M12: { d: 12, pitch: 1.75, s: 18, k: 7.5, m: 10.8 },
  M16: { d: 16, pitch: 2, s: 24, k: 10, m: 14.8 },
  M20: { d: 20, pitch: 2.5, s: 30, k: 12.5, m: 18 },
  M24: { d: 24, pitch: 3, s: 36, k: 15, m: 21.5 },
} as const;

export type MetricSize = keyof typeof METRIC_SIZES;

/** Fastener sizes in meters. */
export function metric(size: MetricSize): {
  readonly d: number;
  readonly pitch: number;
  readonly s: number;
  readonly k: number;
  readonly m: number;
} {
  const row = METRIC_SIZES[size];
  return {
    d: row.d / 1000,
    pitch: row.pitch / 1000,
    s: row.s / 1000,
    k: row.k / 1000,
    m: row.m / 1000,
  };
}

export interface HexBoltOptions extends RecipeNaming {
  readonly size: MetricSize;
  /** Shank length under the head (meters). */
  readonly length: number;
  /** Thread length from the tip (default ISO 4014: 2d + 6 mm, at most the shank). */
  readonly thread?: number;
  /** Segments around the shank (default 24). */
  readonly segments?: number;
}

export const HEX_BOLT_RANGES = {
  lengthDiameters: [1.5, 20],
  segments: [12, 48],
} as const satisfies Record<string, Range>;

/** Radius of a clearance hole that an N-gon of radius `r` passes without touching. */
export function clearanceRadius(r: number, segments: number, clearance = 0.04): number {
  return (r / cos(Math.PI / segments)) * (1 + clearance);
}

function hexagon(acrossFlats: number): Point2[] {
  return circle(acrossFlats / Math.sqrt(3), 6, [0, 0], Math.PI / 6);
}

/** Hex prism with a round hole, stood up along +Y from y = 0 to y = height. */
function hexPrism(
  m: Model,
  s: number,
  hole: number,
  height: number,
  segments: number,
  label: string,
) {
  m.extrudePolygon({
    points: hexagon(s),
    holes: [revolveCircle(hole, segments)],
    depth: height,
    label,
  });
  m.rotate(sel.createdBy(label), 'x', -90);
}

function chamferRim(m: Model, faces: FaceSelector, width: number, label: string): void {
  m.bevel(faces.boundary().minus(sel.edges.meshBoundary()), { width, segments: 1, label });
}

/**
 * ISO 4014-style hex bolt along -Y: the hex head (label `<name>-head`) sits on
 * y = 0..k with a chamfered top, the shank (`<name>-shank`) runs to the chamfered tip
 * at y = -length and carries cosmetic V thread rings (`<name>-thread`). Head and
 * shank are one closed solid; slot `steel`. Anchors: `head`, `seat`, `tip`.
 */
export function hexBolt(options: HexBoltOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'bolt';
  const size = METRIC_SIZES[options.size] === undefined ? undefined : metric(options.size);
  const segments = options.segments ?? 24;
  const checked = checkAll([
    () => inRange('size', size === undefined ? Number.NaN : size.d, [0.003, 0.024]),
    () => inRange('segments', segments, HEX_BOLT_RANGES.segments, true),
  ]);
  if (!checked.ok || size === undefined) return checked as Result<never, ModelingError>;
  const { d, pitch, s, k } = size;
  const lengthOk = inRange('length', options.length, [1.5 * d, 20 * d]);
  if (!lengthOk.ok) return lengthOk;
  const length = options.length;
  const tipChamfer = 0.08 * d;
  const thread = options.thread ?? Math.min(length - tipChamfer, 2 * d + 0.006);
  const threadOk = inRange('thread', thread, [0, length - tipChamfer]);
  if (!threadOk.ok) return threadOk;
  const head = `${name}-head`;
  const shank = `${name}-shank`;
  const m = model();
  hexPrism(m, s, d / 2, k, segments, head);
  m.delete(sel.createdBy(head, 'hole'));
  m.fillHoles(sel.createdBy(head, 'top').boundary().and(sel.edges.meshBoundary()), { label: head });
  const top = sel.createdBy(head, 'top').or(sel.createdBy(head, 'cap'));
  m.dissolve(top.toEdges('contained').minus(top.boundary()));
  chamferRim(m, sel.createdBy(head).and(sel.facing('+y')), 0.05 * s, `${name}-chamfer`);
  m.revolve({
    points: [
      [0, -length],
      [d / 2 - tipChamfer, -length],
      [d / 2, -length + tipChamfer],
      [d / 2, 0],
    ],
    segments,
    label: shank,
  });
  m.weld({ distance: d * 1e-6 });
  const rings = Math.floor(thread / pitch);
  for (let i = 0; i < rings; i++) {
    m.panelLine(
      {
        faces: sel.createdBy(shank, 'side'),
        point: [0, -length + tipChamfer + pitch * (i + 0.5), 0],
        normal: [0, 1, 0],
      },
      { width: 0.85 * pitch, depth: 0.3 * pitch, profile: 'v', label: `${name}-thread` },
    );
  }
  m.assign(sel.all(), 'steel');
  return finishPart(
    m,
    name,
    { head: [0, k, 0], seat: [0, 0, 0], tip: [0, -length, 0] },
    { d, pitch, acrossFlats: s, headHeight: k, length, thread: rings * pitch },
  );
}

export interface HexNutOptions extends RecipeNaming {
  readonly size: MetricSize;
  /** Segments around the hole (default 24, matching the bolt). */
  readonly segments?: number;
}

/**
 * ISO 4032-style hex nut along +Y from y = 0 to its height, both hex rims chamfered
 * (labels `<name>`, `<name>-chamfer`, slot `steel`); its hole clears a bolt of the
 * same size and segment count. Anchors: `bottom`, `top`.
 */
export function hexNut(options: HexNutOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'nut';
  const size = METRIC_SIZES[options.size] === undefined ? undefined : metric(options.size);
  const segments = options.segments ?? 24;
  const checked = checkAll([
    () => inRange('size', size === undefined ? Number.NaN : size.d, [0.003, 0.024]),
    () => inRange('segments', segments, HEX_BOLT_RANGES.segments, true),
  ]);
  if (!checked.ok || size === undefined) return checked as Result<never, ModelingError>;
  const m = model();
  hexPrism(m, size.s, clearanceRadius(size.d / 2, segments, 0.01), size.m, segments, name);
  chamferRim(m, sel.createdBy(name, 'side'), 0.05 * size.s, `${name}-chamfer`);
  m.assign(sel.all(), 'steel');
  return finishPart(
    m,
    name,
    { bottom: [0, 0, 0], top: [0, size.m, 0] },
    { d: size.d, acrossFlats: size.s, height: size.m },
  );
}

export interface WasherOptions extends RecipeNaming {
  readonly size: MetricSize;
  readonly segments?: number;
}

/** ISO 7089-style plain washer along +Y from y = 0 (label `<name>`, slot `steel`). */
export function washer(options: WasherOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'washer';
  const size = METRIC_SIZES[options.size] === undefined ? undefined : metric(options.size);
  const segments = options.segments ?? 24;
  const checked = checkAll([
    () => inRange('size', size === undefined ? Number.NaN : size.d, [0.003, 0.024]),
    () => inRange('segments', segments, HEX_BOLT_RANGES.segments, true),
  ]);
  if (!checked.ok || size === undefined) return checked as Result<never, ModelingError>;
  const inner = clearanceRadius(size.d / 2, segments, 0.04);
  const outer = size.d;
  const h = Math.max(0.0005, 0.2 * size.d);
  const m = model();
  m.revolve({
    points: [
      [inner, 0],
      [outer, 0],
      [outer, h],
      [inner, h],
      [inner, 0],
    ],
    segments,
    label: name,
  });
  m.assign(sel.all(), 'steel');
  return finishPart(m, name, { bottom: [0, 0, 0], top: [0, h, 0] }, { inner, outer, thickness: h });
}
