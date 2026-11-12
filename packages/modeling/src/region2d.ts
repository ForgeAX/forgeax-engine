import { err, ok, type Result } from '@forgeax/engine-types';
import { tsBackend } from './compute/boolean-ts';
import {
  type ComputeJobResult,
  type ComputeOptions,
  type RegionJobParams,
  runComputeJob,
} from './compute/job';
import { decodeRegion, encodeRegion, type Region2, type Shape2 } from './compute/region-ts';
import { cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { orient2d } from './predicates';
import type { Point2 } from './primitives';

/** A region, one shape, or one counter-clockwise outline. */
export type RegionInput = Region2 | Shape2 | readonly Point2[];

export interface RegionOptions {
  /** Weld distance in region units (default 1e-6). */
  readonly tolerance?: number;
  /** Compute-job backend policy and budget (design 4.1). */
  readonly compute?: ComputeOptions;
}

export type OffsetOptions = RegionOptions &
  Pick<RegionJobParams, 'join' | 'cap' | 'miterLimit' | 'arcTolerance'>;

/** A region result with the job report and per-ring edge provenance. */
export type RegionResult = Omit<ComputeJobResult<'region'>, 'outputs'> & {
  readonly region: Region2;
};

const DEFAULT_TOLERANCE = 1e-6;

function isPoint(value: unknown): value is Point2 {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'number';
}

/** The region an input names. */
export function toRegion(input: RegionInput): Region2 {
  if (!Array.isArray(input)) return [input as Shape2];
  const list = input as readonly unknown[];
  if (list.length > 0 && isPoint(list[0])) return [{ outer: input as readonly Point2[] }];
  return input as Region2;
}

function job(
  inputs: readonly RegionInput[],
  params: Omit<RegionJobParams, 'tolerance'>,
  options: RegionOptions,
): Result<RegionResult, ModelingError> {
  const out = runComputeJob(
    {
      kind: 'region',
      inputs: inputs.map((input) => encodeRegion(toRegion(input))),
      params: { ...params, tolerance: options.tolerance ?? DEFAULT_TOLERANCE },
    },
    tsBackend,
    options.compute,
  );
  if (!out.ok) return out;
  const { outputs, ...rest } = out.value;
  const decoded = decodeRegion(outputs[0] as Uint8Array);
  if (!decoded.ok) return decoded;
  return ok({ ...rest, region: decoded.value });
}

function signedArea(ring: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point2;
    const b = ring[(i + 1) % ring.length] as Point2;
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

function winding(ring: readonly Point2[], q: Point2): number {
  let w = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point2;
    const b = ring[(i + 1) % ring.length] as Point2;
    if (a[1] <= q[1]) {
      if (b[1] > q[1] && orient2d(a[0], a[1], b[0], b[1], q[0], q[1]) > 0) w++;
    } else if (b[1] <= q[1] && orient2d(a[0], a[1], b[0], b[1], q[0], q[1]) < 0) w--;
  }
  return w;
}

/**
 * 2D regions (design 13): outlines with holes for contours, text and panel layouts.
 * Booleans, offsets and strokes run as the `region` compute job (TS baseline; a
 * `native` policy reports `model-capability-unavailable`). Inputs may overlap and use
 * either orientation; results are disjoint shapes, outlines counter-clockwise and
 * holes clockwise, each ring starting at its lowest-then-leftmost point.
 */
export const region2d = {
  union: (a: RegionInput, b: RegionInput, options: RegionOptions = {}) =>
    job([a, b], { operation: 'union' }, options),
  difference: (a: RegionInput, b: RegionInput, options: RegionOptions = {}) =>
    job([a, b], { operation: 'difference' }, options),
  intersection: (a: RegionInput, b: RegionInput, options: RegionOptions = {}) =>
    job([a, b], { operation: 'intersection' }, options),
  xor: (a: RegionInput, b: RegionInput, options: RegionOptions = {}) =>
    job([a, b], { operation: 'xor' }, options),
  /** Grow (`delta` > 0) or shrink every outline by `delta`; holes move the opposite way. */
  offset: (a: RegionInput, delta: number, options: OffsetOptions = {}) =>
    job([a], { operation: 'offset', delta, ...pickOffset(options) }, options),
  /** The area within `halfWidth` of open polylines (text strokes, panel gaps). */
  stroke: (
    lines: readonly (readonly Point2[])[],
    halfWidth: number,
    options: OffsetOptions = {},
  ) => {
    for (const line of lines) {
      if (line.length < 2) {
        return err(
          modelingError('model-invalid-argument', 'every stroke polyline has at least 2 points', {
            count: line.length,
          }),
        );
      }
    }
    return job(
      [lines.map((outer) => ({ outer }))],
      { operation: 'stroke', delta: halfWidth, ...pickOffset(options) },
      options,
    );
  },
  /** Signed area: outlines count positive, holes negative (for normalized results). */
  area(input: RegionInput): number {
    let total = 0;
    for (const shape of toRegion(input)) {
      total += Math.abs(signedArea(shape.outer));
      for (const hole of shape.holes ?? []) total -= Math.abs(signedArea(hole));
    }
    return total;
  },
  /** Whether `p` is inside (boundary points count as unspecified). */
  contains(input: RegionInput, p: Point2): boolean {
    for (const shape of toRegion(input)) {
      if (winding(shape.outer, p) === 0) continue;
      if ((shape.holes ?? []).every((hole) => winding(hole, p) === 0)) return true;
    }
    return false;
  },
  /** `[minX, minY, maxX, maxY]`, or undefined for an empty region. */
  bounds(input: RegionInput): readonly [number, number, number, number] | undefined {
    const out: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const shape of toRegion(input)) {
      for (const p of shape.outer) {
        out[0] = Math.min(out[0], p[0]);
        out[1] = Math.min(out[1], p[1]);
        out[2] = Math.max(out[2], p[0]);
        out[3] = Math.max(out[3], p[1]);
      }
    }
    return out[0] === Infinity ? undefined : out;
  },
  /**
   * Scale (number or [sx, sy]), then rotate (degrees, counter-clockwise), then
   * translate every point; a mirroring scale keeps outlines counter-clockwise.
   */
  transform(
    input: RegionInput,
    transform: {
      readonly scale?: number | readonly [number, number];
      readonly rotate?: number;
      readonly translate?: Point2;
    },
  ): Region2 {
    const [sx, sy] =
      typeof transform.scale === 'number'
        ? [transform.scale, transform.scale]
        : (transform.scale ?? [1, 1]);
    const a = ((transform.rotate ?? 0) * Math.PI) / 180;
    const c = cos(a);
    const s = sin(a);
    const [tx, ty] = transform.translate ?? [0, 0];
    const map = (ring: readonly Point2[]) => {
      const out = ring.map(([x, y]): Point2 => {
        const px = x * sx;
        const py = y * sy;
        return [px * c - py * s + tx, px * s + py * c + ty];
      });
      return sx * sy < 0 ? out.reverse() : out;
    };
    return toRegion(input).map((shape) => {
      const holes = shape.holes?.map(map);
      return holes === undefined ? { outer: map(shape.outer) } : { outer: map(shape.outer), holes };
    });
  },
  encode: encodeRegion,
  decode: decodeRegion,
};

function pickOffset(options: OffsetOptions): Partial<RegionJobParams> {
  return {
    ...(options.join === undefined ? {} : { join: options.join }),
    ...(options.cap === undefined ? {} : { cap: options.cap }),
    ...(options.miterLimit === undefined ? {} : { miterLimit: options.miterLimit }),
    ...(options.arcTolerance === undefined ? {} : { arcTolerance: options.arcTolerance }),
  };
}

export type { Region2, Shape2 };
