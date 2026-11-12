import { err, ok, type Result } from '@forgeax/engine-types';
import { atan2, cos, sin } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import { model } from '../model';
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
  vertexRadius,
} from './common';
import { type FitClass, isoFit } from './fits';
import { fitSegments } from './pin-joint';

export interface BushingOptions extends RecipeNaming {
  /** Nominal shaft diameter (meters). */
  readonly d: number;
  /** ISO 286 fit of the shaft in the bore (default `'H8/f7'`, precision running). */
  readonly fit?: FitClass;
  /** Outside diameter, which the housing bore takes line to line (default 1.2 d). */
  readonly outer?: number;
  /** Length along +Y from y = 0 (default d, length/diameter 1). */
  readonly length?: number;
  /** A collar at y = 0 against the housing face. */
  readonly flange?: { readonly diameter: number; readonly thickness: number };
  readonly segments?: number;
}

export const BUSHING_RANGES = {
  d: [0.003, 0.18],
  outerDiameters: [1.05, 2],
  lengthDiameters: [0.25, 2],
  segments: [12, 512],
} as const satisfies Record<string, Range>;

/**
 * Plain bushing along +Y (`<name>`, slot `bronze`): a sleeve from y = 0 to `length` with its
 * bore at the ISO 286 hole mid size, so a shaft at the shaft mid size (`dimensions.shaft`,
 * same segment count and phase) clears it by `radialGap` across flats; the outside flats sit
 * at `outer` / 2 for a line-to-line housing bore. Length over diameter above 2 is refused
 * (metal-polymer bushings: edge loading). Anchors `bottom`, `top`.
 */
export function bushing(options: BushingOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'bushing';
  const { d } = options;
  const checked = checkAll([() => inRange('d', d, BUSHING_RANGES.d)]);
  if (!checked.ok) return checked;
  const fit = isoFit(d, options.fit ?? 'H8/f7');
  if (!fit.ok) return fit;
  const outer = options.outer ?? 1.2 * d;
  const length = options.length ?? d;
  const least = fitSegments(fit.value.shaftMid / 2, fit.value.clearanceMid / 2);
  const n = options.segments ?? least;
  const ranges = checkAll([
    () => inRange('outer', outer, [1.05 * d, 2 * d]),
    () => inRange('length', length, [0.25 * d, 2 * d]),
    () => inRange('segments', n, [least, BUSHING_RANGES.segments[1]], true),
    ...(options.flange === undefined
      ? []
      : [
          () =>
            inRange('flange.diameter', options.flange?.diameter as number, [
              outer * 1.1,
              outer * 2,
            ]),
          () =>
            inRange('flange.thickness', options.flange?.thickness as number, [
              0.05 * d,
              length / 2,
            ]),
        ]),
  ]);
  if (!ranges.ok) return ranges;
  const bore = vertexRadius(fit.value.holeMid / 2, n);
  const out = vertexRadius(outer / 2, n);
  const profile: Point2[] =
    options.flange === undefined
      ? [
          [bore, 0],
          [out, 0],
          [out, length],
          [bore, length],
          [bore, 0],
        ]
      : [
          [bore, 0],
          [vertexRadius(options.flange.diameter / 2, n), 0],
          [vertexRadius(options.flange.diameter / 2, n), options.flange.thickness],
          [out, options.flange.thickness],
          [out, length],
          [bore, length],
          [bore, 0],
        ];
  const m = model();
  m.revolve({ points: profile, segments: n, label: name });
  m.assign(sel.all(), 'bronze');
  return finishPart(
    m,
    name,
    { bottom: [0, 0, 0], top: [0, length, 0] },
    {
      hole: fit.value.holeMid,
      shaft: fit.value.shaftMid,
      radialGap: fit.value.clearanceMid / 2,
      outer,
      length,
      segments: n,
    },
  );
}

export interface RodEndOptions extends RecipeNaming {
  /** Ball bore, the pin diameter (meters, 3 mm to 60 mm). */
  readonly d: number;
  /** ISO 286 fit of the pin in the ball bore (default `'H7/g6'`). */
  readonly fit?: FitClass;
  /** Radial clearance between ball and race (default 50 um, ISO 12240 normal group mid band). */
  readonly clearance?: number;
  /** Shank length beyond the eye along -X (default 2 d). */
  readonly shank?: number;
}

export const ROD_END_RANGES = {
  d: [0.003, 0.06],
  clearance: [0.00001, 0.0005],
  shankDiameters: [0.5, 10],
} as const satisfies Record<string, Range>;

/** Facet plane distance per unit radius of the sphere zone band between latitudes a and b on an n-gon. */
function facetFactor(a: number, b: number, n: number): number {
  const p = (phi: number, theta: number) =>
    [cos(phi) * cos(theta), sin(phi), cos(phi) * sin(theta)] as const;
  const step = (2 * Math.PI) / n;
  const [p0, p1, p2] = [p(a, 0), p(a, step), p(b, 0)];
  const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const v = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
  const nx = (u[1] as number) * (v[2] as number) - (u[2] as number) * (v[1] as number);
  const ny = (u[2] as number) * (v[0] as number) - (u[0] as number) * (v[2] as number);
  const nz = (u[0] as number) * (v[1] as number) - (u[1] as number) * (v[0] as number);
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  return Math.abs(nx * p0[0] + ny * p0[1] + nz * p0[2]) / l;
}

/**
 * Rod end (spherical plain bearing, ISO 12240 proportions) about the +Y pin axis: a ball
 * (`<name>-ball`, slot `chrome`) of radius 0.75 d and width 0.83 d with its bore at the ISO 286
 * hole mid size, in a housing (`<name>-housing`, slot `steel`) of width 0.67 d whose concave
 * race keeps `clearance` across facets, with a shank along -X. Ball and race share latitude
 * steps and segments, so their facets stay parallel at rest; the steps are fine enough that a
 * tilted or turned ball loses at most half the clearance. `contacts` declares the pair a
 * `fit`. Anchors `axis`, `shankEnd`; dimensions `hole`, `shaft`, `ballRadius`, `raceRadius`,
 * `clearance`, `tilt` (degrees the ball tilts before its rim reaches the race edge), `segments`.
 */
export function rodEnd(options: RodEndOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'rod-end';
  const { d } = options;
  const c = options.clearance ?? 0.00005;
  const shank = options.shank ?? 2 * d;
  const checked = checkAll([
    () => inRange('d', d, ROD_END_RANGES.d),
    () => inRange('clearance', c, ROD_END_RANGES.clearance),
    () => inRange('shank', shank, [0.5 * d, 10 * d]),
  ]);
  if (!checked.ok) return checked;
  const fit = isoFit(d, options.fit ?? 'H7/g6');
  if (!fit.ok) return fit;
  const rb = 0.75 * d;
  const ballHalf = (0.83 * d) / 2;
  const raceHalf = (0.67 * d) / 2;
  // Latitude steps and segments that keep the faceting error under half the clearance.
  let steps = 8;
  let n = fitSegments(rb, c);
  const ballTop = atan2(ballHalf, Math.sqrt(rb * rb - ballHalf * ballHalf));
  while (steps < 256 && rb * (1 - facetFactor(0, ballTop / steps, n)) > c / 2) steps += 2;
  if (rb * (1 - facetFactor(0, ballTop / steps, n)) > c / 2) {
    return err(
      modelingError(
        'model-invalid-argument',
        'a ball clearance the faceting can keep',
        { clearance: c },
        'raise clearance',
      ),
    );
  }
  n = Math.max(n, fitSegments(fit.value.shaftMid / 2, fit.value.clearanceMid / 2));
  const delta = ballTop / steps;
  let k = 1;
  for (let i = -steps; i < steps; i++) k = Math.min(k, facetFactor(i * delta, (i + 1) * delta, n));
  // Facets of the scaled race stand (rr - rb) k off the ball's: that is the clearance.
  const rr = rb + c / k;
  const raceSteps = Math.max(
    1,
    Math.floor(atan2(raceHalf, Math.sqrt(rr * rr - raceHalf * raceHalf)) / delta),
  );
  const raceTop = raceSteps * delta;
  const zone = (r: number, from: number, to: number, count: number): Point2[] =>
    Array.from({ length: count + 1 }, (_, i) => {
      const phi = from + ((to - from) * i) / count;
      return [r * cos(phi), r * sin(phi)] as Point2;
    });
  const bore = vertexRadius(fit.value.holeMid / 2, n);
  const ball: Point2[] = [
    [bore, -rb * sin(ballTop)],
    ...zone(rb, -ballTop, ballTop, 2 * steps),
    [bore, rb * sin(ballTop)],
    [bore, -rb * sin(ballTop)],
  ];
  const outer = rr * 1.35;
  const yTop = rr * sin(raceTop);
  const race: Point2[] = [
    [rr * cos(raceTop), -yTop],
    [outer, -yTop],
    [outer, yTop],
    ...zone(rr, raceTop, -raceTop, 2 * raceSteps),
  ];
  const m = model();
  m.revolve({ points: ball, segments: n, label: `${name}-ball` });
  const housing = model();
  housing.revolve({ points: race, segments: n, label: `${name}-housing` });
  // The shank runs into the eye wall from -X, inside the housing width.
  const shankR = Math.min(0.3 * d, 0.8 * yTop);
  const shankIn = (rr + outer) / 2;
  housing.cylinder({
    radiusTop: shankR,
    radiusBottom: shankR,
    height: shank + outer - shankIn,
    radialSegments: 24,
    label: `${name}-shank`,
  });
  housing.rotate(sel.createdBy(`${name}-shank`), 'z', 90);
  housing.translate(sel.createdBy(`${name}-shank`), [
    -(shankIn + (shank + outer - shankIn) / 2),
    0,
    0,
  ]);
  housing.union(sel.createdBy(`${name}-shank`), { label: `${name}-housing` });
  if (housing.poisoned !== undefined) return err(housing.poisoned);
  m.append(housing.snapshot());
  m.assign(sel.all(), 'steel');
  m.assign(sel.createdBy(`${name}-ball`), 'chrome');
  const asin = (x: number) => atan2(x, Math.sqrt(1 - x * x));
  const finished = finishPart(
    m,
    name,
    { axis: [0, 0, 0], shankEnd: [-(outer + shank), 0, 0] },
    {
      hole: fit.value.holeMid,
      shaft: fit.value.shaftMid,
      ballRadius: rb,
      raceRadius: rr,
      clearance: c,
      tilt: degrees(asin((rb * sin(ballTop)) / rr) - raceTop),
      segments: n,
    },
  );
  if (!finished.ok) return finished;
  return ok({
    ...finished.value,
    // At rest the ball clears the race by `clearance`; tilted or turned, by at least half of it.
    contacts: [{ parts: [`${name}-housing`, `${name}-ball`], kind: 'fit', gap: [c / 2, c] }],
  });
}
