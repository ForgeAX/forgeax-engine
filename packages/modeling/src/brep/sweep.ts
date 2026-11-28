import { err, ok, type Result } from '@forgeax/engine-types';
import { atan2, cos, hypot3, sin } from '../dmath';
import type { ModelingError } from '../errors';
import { modelingError } from '../errors';
import { checkCurve } from '../nurbs';
import { ShapeAssembler } from './assembler';
import { extrude } from './build';
import { curvePoint, curveTangent } from './curves';
import { area2, isPointList, ringDefect, windPolygon } from './profile';
import { buildRailShell, placeOnFrame } from './rail-shell';
import { frameDefect, makeFrame } from './surfaces';
import type { ToleranceOptions } from './tolerance';
import type { Curve, Frame, Shape } from './types';
import { cross3, dist3, dot3, type P2, type P3, scale3, sub3, unit3 } from './vec';

export interface SweepOptions extends ToleranceOptions {
  /** Closed polygonal outline in the start frame's xy plane. */
  readonly profile: readonly P2[];
  /** Through holes in the profile plane. */
  readonly holes?: readonly (readonly P2[])[];
  /** Centerline; supported kinds are line, circle, ellipse and NURBS. */
  readonly path: Curve;
  /** Path interval; defaults to [0, 1] for line and [0, 2*pi] for circles and ellipses. */
  readonly range?: readonly [number, number];
  /** Number of interpolation stations for a curved path (2 through 128). */
  readonly stations?: number;
  /** Maximum allowed station-fit error relative to the profile/path extent (default 0.06). */
  readonly fitTolerance?: number;
  /** Total rotation of the profile about the moving tangent, in radians. */
  readonly twist?: number;
  /** Preferred x direction for the start frame. */
  readonly xHint?: P3;
  readonly label?: string;
  readonly role?: string;
}

interface Station {
  readonly t: number;
  readonly point: P3;
  readonly frame: Frame;
}

const DEFAULT_HINT: P3 = [1, 0, 0];
const FRAME_EPS = 1e-10;

function bad(expected: string, detail: Record<string, unknown> = {}): Result<never, ModelingError> {
  return err(
    modelingError('model-invalid-argument', expected, { brep: 'brep-bad-argument', ...detail }),
  );
}

function finitePoint(p: P3): boolean {
  return p.length === 3 && p.every(Number.isFinite);
}

function rotateAround(v: P3, axis: P3, angle: number): P3 {
  const c = cos(angle);
  const s = sin(angle);
  const kCrossV = cross3(axis, v);
  const kDotV = dot3(axis, v) * (1 - c);
  return [
    v[0] * c + kCrossV[0] * s + axis[0] * kDotV,
    v[1] * c + kCrossV[1] * s + axis[1] * kDotV,
    v[2] * c + kCrossV[2] * s + axis[2] * kDotV,
  ];
}

function transported(previous: Frame, tangent: P3): Frame | undefined {
  const axisRaw = cross3(previous.z, tangent);
  const sine = Math.sqrt(dot3(axisRaw, axisRaw));
  const cosine = dot3(previous.z, tangent);
  if (cosine < -1 + FRAME_EPS) return undefined;
  let x = previous.x;
  if (sine > FRAME_EPS) x = rotateAround(x, scale3(axisRaw, 1 / sine), atan2(sine, cosine));
  x = unit3(sub3(x, scale3(tangent, dot3(x, tangent))));
  if (Math.sqrt(dot3(x, x)) < FRAME_EPS) return undefined;
  return { o: previous.o, x, y: cross3(tangent, x), z: tangent };
}

function frameAt(point: P3, tangent: P3, xHint: P3): Frame {
  const base = makeFrame(point, tangent, xHint);
  return { ...base, o: point };
}

function curveRange(path: Curve, range?: readonly [number, number]): readonly [number, number] {
  if (range !== undefined) return range;
  switch (path.kind) {
    case 'line':
      return [0, 1];
    case 'circle':
    case 'ellipse':
      return [0, 2 * Math.PI];
    case 'nurbs':
      return [
        path.curve.knots[path.curve.degree] as number,
        path.curve.knots[path.curve.points.length] as number,
      ];
  }
}

function profileDiameter(rings: readonly (readonly P2[])[]): number {
  let diameter = 0;
  for (const ring of rings) {
    for (const p of ring) {
      for (const q of ring) {
        const dx = p[0] - q[0];
        const dy = p[1] - q[1];
        diameter = Math.max(diameter, Math.sqrt(dx * dx + dy * dy));
      }
    }
  }
  return diameter;
}

function boxDiagonal(points: readonly P3[]): number {
  let lo: P3 = points[0] as P3;
  let hi: P3 = lo;
  for (const p of points) {
    lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1]), Math.min(lo[2], p[2])];
    hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1]), Math.max(hi[2], p[2])];
  }
  return hypot3(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

function pathStations(
  path: Curve,
  t0: number,
  t1: number,
  count: number,
  hint: P3,
): Result<Station[], ModelingError> {
  const stations: Station[] = [];
  let previous: Frame | undefined;
  for (let i = 0; i < count; i++) {
    const u = i / (count - 1);
    const t = t0 + (t1 - t0) * u;
    const point = curvePoint(path, t);
    const derivative = curveTangent(path, t);
    if (
      !finitePoint(point) ||
      !finitePoint(derivative) ||
      Math.sqrt(dot3(derivative, derivative)) <= FRAME_EPS
    ) {
      return bad('a finite path with a non-zero tangent at every station', {
        reason: 'singular-path',
        station: i,
      });
    }
    const tangent = unit3(derivative);
    let base: Frame;
    if (previous === undefined) base = makeFrame(point, tangent, hint);
    else {
      const moved = transported(previous, tangent);
      if (moved === undefined) {
        return bad('a path without a 180-degree tangent reversal between stations', {
          reason: 'frame-antiparallel',
          station: i,
        });
      }
      base = { ...moved, o: point };
    }
    const frame = frameAt(point, tangent, base.x);
    const defect = frameDefect(frame);
    if (defect !== undefined) {
      return bad('a non-degenerate rotation-minimizing frame', { reason: defect, station: i });
    }
    stations.push({ t, point, frame });
    previous = base;
  }
  return ok(stations);
}

function balanceClosedFrames(stations: readonly Station[]): Result<Station[], ModelingError> {
  if (stations.length > 2) {
    const first = stations[0] as Station;
    const last = stations[stations.length - 1] as Station;
    const axisRaw = cross3(last.frame.z, first.frame.z);
    const sine = Math.sqrt(dot3(axisRaw, axisRaw));
    const cosine = dot3(last.frame.z, first.frame.z);
    if (Math.abs(cosine - 1) > 1e-8 || sine > 1e-8) {
      return bad('a closed sweep path with matching end tangents', {
        reason: 'closed-tangent-mismatch',
      });
    }
    const roll = atan2(
      dot3(cross3(last.frame.x, first.frame.x), first.frame.z),
      dot3(last.frame.x, first.frame.x),
    );
    const corrected: Station[] = [];
    for (let i = 0; i < stations.length; i++) {
      const station = stations[i] as Station;
      const u = i / (stations.length - 1);
      const x = rotateAround(station.frame.x, station.frame.z, roll * u);
      const frame = { ...station.frame, x, y: cross3(station.frame.z, x) };
      const defect = frameDefect(frame);
      if (defect !== undefined) {
        return bad('a non-degenerate closed-path frame correction', { reason: defect, station: i });
      }
      corrected.push({ ...station, frame });
    }
    return ok(corrected);
  }
  return ok([...stations]);
}

function lineSweep(
  options: SweepOptions,
  interval: readonly [number, number],
): Result<Shape, ModelingError> | undefined {
  if (options.path.kind !== 'line' || (options.twist ?? 0) !== 0) return undefined;
  const start = curvePoint(options.path, interval[0]);
  const end = curvePoint(options.path, interval[1]);
  const delta = sub3(end, start);
  const length = Math.sqrt(dot3(delta, delta));
  if (!(length > 0)) return undefined;
  const frame = makeFrame(start, scale3(delta, 1 / length), options.xHint ?? DEFAULT_HINT);
  const defect = frameDefect(frame);
  if (defect !== undefined)
    return bad('an orthonormal right-handed path frame', { reason: defect });
  return extrude({
    profile: options.profile,
    ...(options.holes === undefined ? {} : { holes: options.holes }),
    depth: length,
    frame,
    ...(options.tol === undefined ? {} : { tol: options.tol }),
    ...(options.maxTol === undefined ? {} : { maxTol: options.maxTol }),
    label: options.label ?? 'sweep',
    ...(options.role === undefined ? {} : { role: options.role }),
  });
}

/**
 * Sweeps a polygonal profile on rotation-minimizing frames. Curved paths are represented by a
 * NURBS loft through the requested stations; the station count is an explicit approximation
 * control, not a certified Hausdorff bound. A straight untwisted path uses exact planar faces.
 */
export function sweep(options: SweepOptions): Result<Shape, ModelingError> {
  if (!isPointList(options.profile, 3) || area2(options.profile) === 0) {
    return bad('a non-degenerate polygonal profile with at least 3 finite points');
  }
  const holes = options.holes ?? [];
  if (!Array.isArray(holes) || holes.some((ring) => !isPointList(ring, 3) || area2(ring) === 0)) {
    return bad('holes that are non-degenerate polygonal rings');
  }
  if (
    options.path === undefined ||
    !['line', 'circle', 'ellipse', 'nurbs'].includes(options.path.kind)
  ) {
    return bad('a line, circle, ellipse or NURBS path');
  }
  if (options.path.kind === 'nurbs') {
    const checked = checkCurve(options.path.curve);
    if (!checked.ok) return checked;
  }
  const range = curveRange(options.path, options.range);
  const [t0, t1] = range;
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || !(t1 > t0)) {
    return bad('a finite, increasing path parameter range');
  }
  const fitTolerance = options.fitTolerance ?? 0.06;
  if (!Number.isFinite(fitTolerance) || fitTolerance < 0 || fitTolerance > 0.25) {
    return bad('a finite fitTolerance from 0 through 0.25', { fitTolerance });
  }
  const twist = options.twist ?? 0;
  if (!Number.isFinite(twist)) return bad('a finite twist angle', { twist });
  const stationsCount = options.stations ?? 17;
  if (!Number.isInteger(stationsCount) || stationsCount < 2 || stationsCount > 128) {
    return bad('an integer station count from 2 through 128', { stations: stationsCount });
  }
  const profile = windPolygon(options.profile, true);
  const rings = [profile, ...holes.map((h) => windPolygon(h, false))];
  const hint = options.xHint ?? DEFAULT_HINT;
  if (!finitePoint(hint) || Math.sqrt(dot3(hint, hint)) <= FRAME_EPS) {
    return bad('a finite non-zero xHint');
  }

  const exactLine = lineSweep({ ...options, profile, holes: rings.slice(1) }, range);
  if (exactLine !== undefined) return exactLine;

  const pathStart = curvePoint(options.path, t0);
  const pathEnd = curvePoint(options.path, t1);
  const pathClosed = dist3(pathStart, pathEnd) <= 1e-9;
  const sampled = pathStations(options.path, t0, t1, stationsCount, hint);
  if (!sampled.ok) return sampled;
  const framed = pathClosed ? balanceClosedFrames(sampled.value) : ok([...sampled.value]);
  if (pathClosed) {
    const turns = twist / (2 * Math.PI);
    if (Math.abs(turns - Math.round(turns)) > 1e-8) {
      return bad('a closed sweep twist that is an integer number of turns', {
        reason: 'closed-twist-mismatch',
        twist,
      });
    }
  }
  if (!framed.ok) return framed;
  const stations = framed.value.map((station, i) => {
    const fraction = i / (framed.value.length - 1);
    const x = rotateAround(station.frame.x, station.frame.z, twist * fraction);
    return { ...station, frame: { ...station.frame, x, y: cross3(station.frame.z, x) } };
  });
  const stationProfiles = stations.map((s) =>
    rings.map((ring) => ring.map((p) => placeOnFrame(s.frame, p))),
  );
  const extentPoints = stationProfiles.flatMap((station) => station.flat());
  const pathSamples = stations.map((station) => station.point);
  const pathExtent = boxDiagonal(pathSamples);
  if (pathSamples.length === 0 || extentPoints.length === 0)
    return bad('a non-empty swept profile and path');
  for (let i = 0; i + 2 < stations.length; i += 2) {
    const t = ((stations[i] as Station).t + (stations[i + 2] as Station).t) / 2;
    const exact = curvePoint(options.path, t);
    const a = (stations[i] as Station).point;
    const b = (stations[i + 1] as Station).point;
    const c = (stations[i + 2] as Station).point;
    const predicted: P3 = [
      (a[0] + 2 * b[0] + c[0]) / 4,
      (a[1] + 2 * b[1] + c[1]) / 4,
      (a[2] + 2 * b[2] + c[2]) / 4,
    ];
    const residual = dist3(exact, predicted);
    const localChord = dist3(a, c);
    const localLimit = fitTolerance * Math.max(1, pathExtent, localChord, profileDiameter(rings));
    if (residual > localLimit) {
      return err(
        modelingError(
          'model-partial',
          'a path approximation within fitTolerance; increase stations',
          {
            reason: 'station-fit-error',
            error: residual,
            limit: localLimit,
            interval: i / 2,
          },
        ),
      );
    }
  }
  const diagonal = boxDiagonal(extentPoints);
  const made = ShapeAssembler.create(diagonal, options);
  if (!made.ok) return made;
  const asm = made.value;
  const defect = ringDefect(rings, asm.tol, 'profile');
  if (defect !== undefined) return bad(defect.expected, { reason: defect.reason, ...defect.ids });

  const ringEdges = rings.reduce((n, ring) => n + ring.length, 0);
  if (ringEdges > 4096 || ringEdges * (stationsCount + 2) > 4096) {
    return bad('a sweep below the B-rep face and edge limits', { reason: 'brep-limit' });
  }
  const stationParams = stations.map((_, i) => i / (stations.length - 1));
  const pathDegree = Math.min(3, stations.length - 1);
  const lastStationProfile = stationProfiles[stationProfiles.length - 1] as P3[][];
  const firstStationProfile = stationProfiles[0] as P3[][];
  const samePathEnds =
    dist3((stations[0] as Station).point, (stations[stations.length - 1] as Station).point) <=
    asm.tol;
  const closed =
    samePathEnds &&
    firstStationProfile.every((ring, ri) =>
      ring.every((p, pi) => dist3(p, (lastStationProfile[ri] as P3[])[pi] as P3) <= asm.tol),
    );
  if (samePathEnds && !closed) {
    return bad('matching start and end profiles for a closed path', {
      reason: 'closed-path-profile-mismatch',
    });
  }
  return buildRailShell({
    asm,
    stationProfiles,
    startFrame: (stations[0] as Station).frame,
    endFrame: (stations[stations.length - 1] as Station).frame,
    stationParams,
    pathDegree,
    closed,
    label: options.label ?? 'sweep',
    role: options.role,
  });
}
