import { err, ok, type Result } from '@forgeax/engine-types';
import { hypot3 } from './dmath';
import { type ModelingError, modelingError } from './errors';
import type { Tuple3 } from './geom';
import {
  checkCurve,
  compatibleCurves,
  curveDerivatives,
  curvePoint,
  domain,
  loftSurface,
  type NurbsCurve,
  type NurbsSurface,
  surfacePoint,
} from './nurbs';

/** Options for an arc-length rail sweep. */
export interface RailSweepOptions {
  /** Normalized arc-length station of each section, increasing from 0 to 1. */
  readonly parameters?: readonly number[];
  /** Rotation-minimizing frame (default) or a frame aligned to a fixed up direction. */
  readonly frame?: 'rmf' | { readonly up: Tuple3 };
  /** Maximum measured between-station deviation in meters (default 1e-5). */
  readonly tolerance?: number;
  /** Maximum loft stations (default 65). */
  readonly maxStations?: number;
  /** Degree along the rail (default 3). */
  readonly degree?: number;
}

/** A rail-sweep surface and its between-station convergence evidence. */
export interface RailSweepResult {
  readonly surface: NurbsSurface;
  readonly stations: number;
  readonly deviation: number;
  readonly converged: boolean;
}

/** Options for a two-rail sweep. */
export interface BirailOptions extends Omit<RailSweepOptions, 'frame'> {
  /** Uniformly scale the section by chord ratio (default), or scale only its width. */
  readonly scale?: 'uniform' | 'width';
}

/** A two-rail sweep and the maximum sampled mismatch at each rail. */
export interface BirailResult extends RailSweepResult {
  readonly railGap: readonly [number, number];
}

interface Frame {
  readonly origin: Tuple3;
  readonly x: Tuple3;
  readonly y: Tuple3;
  readonly z: Tuple3;
}

interface RailTable {
  readonly curve: NurbsCurve;
  readonly parameters: readonly number[];
  readonly points: readonly Tuple3[];
  readonly lengths: readonly number[];
  readonly tangents: readonly Tuple3[];
  readonly totalLength: number;
}

interface LocalSection {
  readonly degree: number;
  readonly knots: readonly number[];
  readonly points: readonly Tuple3[];
  readonly weights: readonly number[];
  readonly rational: boolean;
  readonly chordLength: number;
}

interface Profile {
  readonly points: readonly Tuple3[];
  readonly weights: readonly number[];
  readonly rational: boolean;
  readonly degree: number;
  readonly knots: readonly number[];
  readonly referenceLength: number;
}

interface SweepConfiguration {
  readonly parameters: readonly number[];
  readonly tolerance: number;
  readonly maxStations: number;
  readonly degree: number;
}

const ARC_SAMPLES = 256;
const GAP_SAMPLES = 512;
const PROFILE_SAMPLES = 8;

function invalid(expected: string, detail: Record<string, unknown> = {}): ModelingError {
  return modelingError('model-invalid-argument', expected, detail);
}

function sub(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Tuple3, factor: number): Tuple3 {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}

function dot(a: Tuple3, b: Tuple3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function length(v: Tuple3): number {
  return hypot3(v[0], v[1], v[2]);
}

function unit(v: Tuple3): Tuple3 | undefined {
  const magnitude = length(v);
  if (!(magnitude > 0) || !Number.isFinite(magnitude)) return undefined;
  return scale(v, 1 / magnitude);
}

function distance(a: Tuple3, b: Tuple3): number {
  return length(sub(a, b));
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mixPoint(a: Tuple3, b: Tuple3, t: number): Tuple3 {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

function stablePerpendicular(tangent: Tuple3): Tuple3 {
  const ax = Math.abs(tangent[0]);
  const ay = Math.abs(tangent[1]);
  const az = Math.abs(tangent[2]);
  const axis: Tuple3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  return unit(sub(axis, scale(tangent, dot(axis, tangent)))) as Tuple3;
}

function projectedUnit(v: Tuple3, normal: Tuple3): Tuple3 | undefined {
  return unit(sub(v, scale(normal, dot(v, normal))));
}

function tangentFromDifference(points: readonly Tuple3[], index: number): Tuple3 | undefined {
  const last = points.length - 1;
  if (index > 0 && index < last) {
    const central = unit(sub(points[index + 1] as Tuple3, points[index - 1] as Tuple3));
    if (central !== undefined) return central;
  }
  if (index < last) {
    const forward = unit(sub(points[index + 1] as Tuple3, points[index] as Tuple3));
    if (forward !== undefined) return forward;
  }
  if (index > 0) {
    const backward = unit(sub(points[index] as Tuple3, points[index - 1] as Tuple3));
    if (backward !== undefined) return backward;
  }
  for (let offset = 1; offset <= last; offset++) {
    const lo = Math.max(0, index - offset);
    const hi = Math.min(last, index + offset);
    const nearby = unit(sub(points[hi] as Tuple3, points[lo] as Tuple3));
    if (nearby !== undefined) return nearby;
  }
  return undefined;
}

function speed(curve: NurbsCurve, parameter: number): number {
  return length(curveDerivatives(curve, parameter, 1)[1] as Tuple3);
}

function integrateSpeed(curve: NurbsCurve, from: number, to: number): number {
  if (to === from) return 0;
  const middle = (from + to) / 2;
  return ((to - from) * (speed(curve, from) + 4 * speed(curve, middle) + speed(curve, to))) / 6;
}

function makeRailTable(curve: NurbsCurve): Result<RailTable, ModelingError> {
  const [start, end] = domain(curve);
  const parameters = new Array<number>(ARC_SAMPLES + 1);
  const points = new Array<Tuple3>(ARC_SAMPLES + 1);
  const lengths = new Array<number>(ARC_SAMPLES + 1).fill(0);
  const tangents = new Array<Tuple3>(ARC_SAMPLES + 1);
  for (let i = 0; i <= ARC_SAMPLES; i++) {
    const t = mix(start, end, i / ARC_SAMPLES);
    parameters[i] = t;
    points[i] = curvePoint(curve, t);
    if (i > 0) {
      lengths[i] =
        (lengths[i - 1] as number) + integrateSpeed(curve, parameters[i - 1] as number, t);
    }
  }
  const totalLength = lengths[ARC_SAMPLES] as number;
  if (!(totalLength > 0) || !Number.isFinite(totalLength)) {
    return err(
      modelingError('model-degenerate', 'the rail has positive finite arc length', {
        length: totalLength,
      }),
    );
  }
  for (let i = 0; i <= ARC_SAMPLES; i++) {
    const derivative = curveDerivatives(curve, parameters[i] as number, 1)[1] as Tuple3;
    tangents[i] = unit(derivative) ?? tangentFromDifference(points, i) ?? [0, 0, 0];
    if (length(tangents[i] as Tuple3) === 0) {
      return err(
        modelingError('model-degenerate', 'the rail has a defined tangent', { sample: i }),
      );
    }
  }
  return ok({ curve, parameters, points, lengths, tangents, totalLength });
}

function locate(
  table: RailTable,
  station: number,
): { index: number; alpha: number; parameter: number } {
  const target = station * table.totalLength;
  if (station <= 0) return { index: 0, alpha: 0, parameter: table.parameters[0] as number };
  if (station >= 1)
    return { index: ARC_SAMPLES - 1, alpha: 1, parameter: table.parameters[ARC_SAMPLES] as number };
  let lo = 0;
  let hi = ARC_SAMPLES;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if ((table.lengths[mid] as number) < target) lo = mid;
    else hi = mid;
  }
  const lowParameter = table.parameters[lo] as number;
  const highParameter = table.parameters[hi] as number;
  const span = (table.lengths[hi] as number) - (table.lengths[lo] as number);
  const alpha = span > 0 ? (target - (table.lengths[lo] as number)) / span : 0;
  let lower = lowParameter;
  let upper = highParameter;
  let parameter = mix(lowParameter, highParameter, alpha);
  for (let iteration = 0; iteration < 48; iteration++) {
    const lengthAtParameter =
      (table.lengths[lo] as number) + integrateSpeed(table.curve, lowParameter, parameter);
    if (lengthAtParameter < target) lower = parameter;
    else upper = parameter;
    parameter = (lower + upper) / 2;
  }
  return { index: lo, alpha, parameter };
}

function pointAndTangent(
  table: RailTable,
  station: number,
): { point: Tuple3; tangent: Tuple3; index: number } {
  const { index, alpha, parameter } = locate(table, station);
  const point = curvePoint(table.curve, parameter);
  const derivative = curveDerivatives(table.curve, parameter, 1)[1] as Tuple3;
  const tangent =
    unit(derivative) ??
    unit(mixPoint(table.tangents[index] as Tuple3, table.tangents[index + 1] as Tuple3, alpha)) ??
    (table.tangents[index] as Tuple3);
  return { point, tangent, index };
}

function doubleReflect(
  x: Tuple3,
  fromPoint: Tuple3,
  fromTangent: Tuple3,
  toPoint: Tuple3,
  toTangent: Tuple3,
): Tuple3 {
  const chord = sub(toPoint, fromPoint);
  const chordSquared = dot(chord, chord);
  let reflectedX = x;
  let reflectedTangent = fromTangent;
  if (chordSquared > 0) {
    reflectedX = sub(x, scale(chord, (2 * dot(chord, x)) / chordSquared));
    reflectedTangent = sub(fromTangent, scale(chord, (2 * dot(chord, fromTangent)) / chordSquared));
  }
  const correction = sub(toTangent, reflectedTangent);
  const correctionSquared = dot(correction, correction);
  if (correctionSquared > 0) {
    reflectedX = sub(
      reflectedX,
      scale(correction, (2 * dot(correction, reflectedX)) / correctionSquared),
    );
  }
  return projectedUnit(reflectedX, toTangent) ?? stablePerpendicular(toTangent);
}

function rmfAxes(table: RailTable): Tuple3[] {
  const axes = new Array<Tuple3>(ARC_SAMPLES + 1);
  axes[0] = stablePerpendicular(table.tangents[0] as Tuple3);
  for (let i = 1; i <= ARC_SAMPLES; i++) {
    axes[i] = doubleReflect(
      axes[i - 1] as Tuple3,
      table.points[i - 1] as Tuple3,
      table.tangents[i - 1] as Tuple3,
      table.points[i] as Tuple3,
      table.tangents[i] as Tuple3,
    );
  }
  return axes;
}

function sweepFrame(
  table: RailTable,
  station: number,
  axes: readonly Tuple3[],
  up?: Tuple3,
): Result<Frame, ModelingError> {
  const { point, tangent, index } = pointAndTangent(table, station);
  let x: Tuple3;
  let y: Tuple3;
  if (up !== undefined) {
    const upAxis = projectedUnit(up, tangent);
    if (upAxis === undefined) {
      return err(
        modelingError(
          'model-degenerate',
          'the fixed up direction is not parallel to the rail tangent',
          { station },
        ),
      );
    }
    y = upAxis;
    x = unit(cross(y, tangent)) as Tuple3;
  } else {
    const transported = doubleReflect(
      axes[index] as Tuple3,
      table.points[index] as Tuple3,
      table.tangents[index] as Tuple3,
      point,
      tangent,
    );
    x = transported;
    y = unit(cross(tangent, x)) as Tuple3;
  }
  return ok({ origin: point, x, y, z: tangent });
}

function birailFrame(
  railA: RailTable,
  railB: RailTable,
  station: number,
): Result<Frame & { readonly chordLength: number }, ModelingError> {
  const a = pointAndTangent(railA, station);
  const b = pointAndTangent(railB, station);
  const chord = sub(b.point, a.point);
  const chordLength = length(chord);
  if (!(chordLength > 0) || !Number.isFinite(chordLength)) {
    return err(
      modelingError('model-degenerate', 'the rails have positive separation at every station', {
        station,
        chordLength,
      }),
    );
  }
  const x = scale(chord, 1 / chordLength);
  let z = projectedUnit(add(a.tangent, b.tangent), x);
  if (z === undefined) z = projectedUnit(a.tangent, x) ?? projectedUnit(b.tangent, x);
  if (z === undefined) {
    return err(
      modelingError('model-degenerate', 'the mean rail tangent defines the birail frame', {
        station,
      }),
    );
  }
  const y = unit(cross(z, x)) as Tuple3;
  return ok({ origin: a.point, x, y, z, chordLength });
}

function sectionParameters(
  count: number,
  supplied?: readonly number[],
): Result<number[], ModelingError> {
  if (supplied !== undefined && supplied.length !== count) {
    return err(
      invalid('parameters has one station per section', {
        expected: count,
        actual: supplied.length,
      }),
    );
  }
  const parameters =
    supplied === undefined
      ? count === 1
        ? [0]
        : Array.from({ length: count }, (_, i) => i / (count - 1))
      : [...supplied];
  if (parameters.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    return err(invalid('section parameters are finite and in [0, 1]', { parameters }));
  }
  for (let i = 1; i < parameters.length; i++) {
    if ((parameters[i] as number) <= (parameters[i - 1] as number)) {
      return err(invalid('section parameters increase strictly', { at: i }));
    }
  }
  if (count === 1 && parameters[0] !== 0) {
    return err(invalid('a single section is authored at station 0', { parameter: parameters[0] }));
  }
  return ok(parameters);
}

function configuration(
  sections: readonly NurbsCurve[],
  options: RailSweepOptions | BirailOptions,
): Result<SweepConfiguration, ModelingError> {
  if (sections.length === 0) return err(invalid('at least one section curve is required'));
  const parameters = sectionParameters(sections.length, options.parameters);
  if (!parameters.ok) return parameters;
  const tolerance = options.tolerance ?? 1e-5;
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    return err(invalid('tolerance is finite and > 0', { tolerance }));
  }
  const degree = options.degree ?? 3;
  if (!Number.isInteger(degree) || degree < 1) {
    return err(invalid('degree is an integer >= 1', { degree }));
  }
  const maxStations = options.maxStations ?? 65;
  if (!Number.isInteger(maxStations) || maxStations < 2) {
    return err(invalid('maxStations is an integer >= 2', { maxStations }));
  }
  return ok({ parameters: parameters.value, tolerance, maxStations, degree });
}

function initialStations(parameters: readonly number[], degree: number): number[] {
  const stations = [...new Set([0, 1, ...parameters])].sort((a, b) => a - b);
  const target = Math.max(degree + 1, stations.length, 2);
  while (stations.length < target) {
    let best = 0;
    let gap = -1;
    for (let i = 0; i < stations.length - 1; i++) {
      const width = (stations[i + 1] as number) - (stations[i] as number);
      if (width > gap) {
        best = i;
        gap = width;
      }
    }
    stations.splice(best + 1, 0, ((stations[best] as number) + (stations[best + 1] as number)) / 2);
  }
  return stations;
}

function refineStations(stations: readonly number[]): number[] {
  const refined = new Array<number>(2 * stations.length - 1);
  for (let i = 0; i < stations.length - 1; i++) {
    refined[2 * i] = stations[i] as number;
    refined[2 * i + 1] = ((stations[i] as number) + (stations[i + 1] as number)) / 2;
  }
  refined[refined.length - 1] = stations[stations.length - 1] as number;
  return refined;
}

function localSections(
  sections: readonly NurbsCurve[],
  parameters: readonly number[],
  frameAt: (station: number) => Result<Frame & { readonly chordLength?: number }, ModelingError>,
  normalizeChord: boolean,
  checkEndpoints?: (
    section: NurbsCurve,
    index: number,
    station: number,
  ) => Result<number, ModelingError>,
): Result<LocalSection[], ModelingError> {
  for (const section of sections) {
    const checked = checkCurve(section);
    if (!checked.ok) return err(checked.error);
  }
  if (checkEndpoints !== undefined) {
    for (let i = 0; i < sections.length; i++) {
      const checked = checkEndpoints(sections[i] as NurbsCurve, i, parameters[i] as number);
      if (!checked.ok) return err(checked.error);
    }
  }
  const compatible = compatibleCurves(sections);
  const referenceKnots = (compatible[0] as NurbsCurve).knots;
  const referenceDegree = (compatible[0] as NurbsCurve).degree;
  const rational = compatible.some((section) => section.weights !== undefined);
  const local: LocalSection[] = [];
  for (let k = 0; k < compatible.length; k++) {
    const source = compatible[k] as NurbsCurve;
    const frame = frameAt(parameters[k] as number);
    if (!frame.ok) return err(frame.error);
    const chordLength = frame.value.chordLength ?? 1;
    const points: Tuple3[] = [];
    const weights: number[] = [];
    for (let i = 0; i < source.points.length; i++) {
      const delta = sub(source.points[i] as Tuple3, frame.value.origin);
      points.push([
        dot(delta, frame.value.x) / (normalizeChord ? chordLength : 1),
        dot(delta, frame.value.y),
        dot(delta, frame.value.z),
      ]);
      weights.push(source.weights?.[i] ?? 1);
    }
    local.push({
      degree: referenceDegree,
      knots: referenceKnots,
      points,
      weights,
      rational,
      chordLength,
    });
  }
  return ok(local);
}

function blendProfile(
  sections: readonly LocalSection[],
  parameters: readonly number[],
  station: number,
): Profile {
  if (sections.length === 1) {
    const section = sections[0] as LocalSection;
    return {
      points: section.points,
      weights: section.weights,
      rational: section.rational,
      degree: section.degree,
      knots: section.knots,
      referenceLength: section.chordLength,
    };
  }
  let hi = 1;
  while (hi < parameters.length - 1 && station > (parameters[hi] as number)) hi++;
  const lo = hi - 1;
  const a = sections[lo] as LocalSection;
  const b = sections[hi] as LocalSection;
  const t0 = parameters[lo] as number;
  const t1 = parameters[hi] as number;
  const alpha = station <= t0 ? 0 : station >= t1 ? 1 : (station - t0) / (t1 - t0);
  const points = a.points.map((point, i) => mixPoint(point, b.points[i] as Tuple3, alpha));
  const weights = a.weights.map((weight, i) => mix(weight, b.weights[i] as number, alpha));
  return {
    points,
    weights,
    rational: a.rational || b.rational,
    degree: a.degree,
    knots: a.knots,
    referenceLength: mix(a.chordLength, b.chordLength, alpha),
  };
}

function placeProfiles(
  local: readonly LocalSection[],
  sectionParams: readonly number[],
  stations: readonly number[],
  frameAt: (station: number) => Result<Frame & { readonly chordLength?: number }, ModelingError>,
  normalizeChord: boolean,
  uniformScale: boolean,
): Result<NurbsCurve[], ModelingError> {
  const curves: NurbsCurve[] = [];
  for (const station of stations) {
    const frame = frameAt(station);
    if (!frame.ok) return err(frame.error);
    const profile = blendProfile(local, sectionParams, station);
    const points = profile.points.map((localPoint) => {
      const chordLength = frame.value.chordLength;
      const x =
        normalizeChord && chordLength !== undefined ? localPoint[0] * chordLength : localPoint[0];
      const sideScale =
        uniformScale && chordLength !== undefined ? chordLength / profile.referenceLength : 1;
      return add(
        frame.value.origin,
        add(
          scale(frame.value.x, x),
          add(
            scale(frame.value.y, localPoint[1] * sideScale),
            scale(frame.value.z, localPoint[2] * sideScale),
          ),
        ),
      );
    });
    const curve: NurbsCurve = {
      degree: profile.degree,
      points,
      knots: profile.knots,
      ...(profile.rational ? { weights: [...profile.weights] } : {}),
    };
    curves.push(curve);
  }
  return ok(curves);
}

function measureDeviation(
  surface: NurbsSurface,
  stations: readonly number[],
  local: readonly LocalSection[],
  sectionParams: readonly number[],
  frameAt: (station: number) => Result<Frame & { readonly chordLength?: number }, ModelingError>,
  normalizeChord: boolean,
  uniformScale: boolean,
): Result<number, ModelingError> {
  let deviation = 0;
  const vStart = surface.knotsV[surface.degreeV] as number;
  const vEnd = surface.knotsV[surface.points[0]?.length ?? 0] as number;
  for (let i = 0; i < stations.length - 1; i++) {
    const station = ((stations[i] as number) + (stations[i + 1] as number)) / 2;
    const frame = frameAt(station);
    if (!frame.ok) return err(frame.error);
    const profile = blendProfile(local, sectionParams, station);
    for (let j = 0; j <= PROFILE_SAMPLES; j++) {
      const u = j / PROFILE_SAMPLES;
      const exact = placedPoint(profile, frame.value, u, normalizeChord, uniformScale);
      const actual = surfacePoint(surface, u, mix(vStart, vEnd, station));
      deviation = Math.max(deviation, distance(exact, actual));
    }
  }
  return ok(deviation);
}

function placedPoint(
  profile: Profile,
  frame: Frame & { readonly chordLength?: number },
  u: number,
  normalizeChord: boolean,
  uniformScale: boolean,
): Tuple3 {
  const curve: NurbsCurve = {
    degree: profile.degree,
    points: profile.points,
    knots: profile.knots,
    ...(profile.rational ? { weights: profile.weights } : {}),
  };
  const point = curvePoint(curve, u);
  const chordLength = frame.chordLength;
  const x = normalizeChord && chordLength !== undefined ? point[0] * chordLength : point[0];
  const sideScale =
    uniformScale && chordLength !== undefined ? chordLength / profile.referenceLength : 1;
  return add(
    frame.origin,
    add(
      scale(frame.x, x),
      add(scale(frame.y, point[1] * sideScale), scale(frame.z, point[2] * sideScale)),
    ),
  );
}

function buildSurface(
  local: readonly LocalSection[],
  sectionParams: readonly number[],
  configuration: SweepConfiguration,
  frameAt: (station: number) => Result<Frame & { readonly chordLength?: number }, ModelingError>,
  normalizeChord: boolean,
  uniformScale: boolean,
  acceptable?: (surface: NurbsSurface) => boolean,
): Result<RailSweepResult, ModelingError> {
  let stations = initialStations(sectionParams, configuration.degree);
  if (stations.length > configuration.maxStations) {
    return err(
      invalid('maxStations accommodates the degree and section stations', {
        required: stations.length,
        maxStations: configuration.maxStations,
      }),
    );
  }
  let surface: NurbsSurface | undefined;
  let deviation = Number.POSITIVE_INFINITY;
  let converged = false;
  while (true) {
    const curves = placeProfiles(
      local,
      sectionParams,
      stations,
      frameAt,
      normalizeChord,
      uniformScale,
    );
    if (!curves.ok) return err(curves.error);
    const loft = loftSurface(curves.value, { degree: configuration.degree, parameters: stations });
    if (!loft.ok) return err(loft.error);
    surface = loft.value;
    const measured = measureDeviation(
      surface,
      stations,
      local,
      sectionParams,
      frameAt,
      normalizeChord,
      uniformScale,
    );
    if (!measured.ok) return err(measured.error);
    deviation = measured.value;
    const boundaryPassed = acceptable === undefined || acceptable(surface);
    const passes = deviation <= configuration.tolerance && boundaryPassed;
    if (passes) {
      converged = true;
      break;
    }
    if (2 * stations.length - 1 > configuration.maxStations) break;
    stations = refineStations(stations);
  }
  return ok({ surface: surface as NurbsSurface, stations: stations.length, deviation, converged });
}

function validateRail(curve: NurbsCurve): Result<RailTable, ModelingError> {
  const checked = checkCurve(curve);
  if (!checked.ok) return err(checked.error);
  return makeRailTable(curve);
}

function sweepUp(frame: RailSweepOptions['frame']): Result<Tuple3 | undefined, ModelingError> {
  if (frame === undefined || frame === 'rmf') return ok(undefined);
  if (
    typeof frame !== 'object' ||
    frame === null ||
    !Array.isArray(frame.up) ||
    frame.up.length !== 3
  ) {
    return err(invalid("frame is 'rmf' or has a finite up vector", { frame }));
  }
  const up = frame.up;
  if (up.some((value) => !Number.isFinite(value))) {
    return err(invalid('frame up vector is finite', { up }));
  }
  const normalized = unit(up);
  if (normalized === undefined) return err(invalid('frame up vector is non-zero', { up }));
  return ok(normalized);
}

/** Sweep compatible sections along a rail using a transported or fixed-up frame. */
export function sweepSurface(
  rail: NurbsCurve,
  sections: readonly NurbsCurve[],
  options: RailSweepOptions = {},
): Result<RailSweepResult, ModelingError> {
  const config = configuration(sections, options);
  if (!config.ok) return err(config.error);
  const up = sweepUp(options.frame);
  if (!up.ok) return err(up.error);
  const table = validateRail(rail);
  if (!table.ok) return err(table.error);
  const axes = rmfAxes(table.value);
  const frameAt = (station: number): Result<Frame, ModelingError> =>
    sweepFrame(table.value, station, axes, up.value);
  const local = localSections(sections, config.value.parameters, frameAt, false);
  if (!local.ok) return err(local.error);
  return buildSurface(local.value, config.value.parameters, config.value, frameAt, false, false);
}

function checkBirailSection(
  section: NurbsCurve,
  index: number,
  station: number,
  railA: RailTable,
  railB: RailTable,
  tolerance: number,
): Result<number, ModelingError> {
  const frame = birailFrame(railA, railB, station);
  if (!frame.ok) return err(frame.error);
  const [start, end] = domain(section);
  const sectionStart = curvePoint(section, start);
  const sectionEnd = curvePoint(section, end);
  const railStart = frame.value.origin;
  const railEnd = curvePoint(railB.curve, locate(railB, station).parameter);
  const gapA = distance(sectionStart, railStart);
  if (gapA > tolerance) {
    return err(
      modelingError('model-precondition', 'section starts on rail A within tolerance', {
        section: index,
        rail: 'A',
        gap: gapA,
      }),
    );
  }
  const gapB = distance(sectionEnd, railEnd);
  if (gapB > tolerance) {
    return err(
      modelingError('model-precondition', 'section ends on rail B within tolerance', {
        section: index,
        rail: 'B',
        gap: gapB,
      }),
    );
  }
  return ok(Math.max(gapA, gapB));
}

function measureRailGaps(
  surface: NurbsSurface,
  railA: RailTable,
  railB: RailTable,
): readonly [number, number] {
  let gapA = 0;
  let gapB = 0;
  const vStart = surface.knotsV[surface.degreeV] as number;
  const vEnd = surface.knotsV[surface.points[0]?.length ?? 0] as number;
  for (let i = 0; i <= GAP_SAMPLES; i++) {
    const station = i / GAP_SAMPLES;
    const surfaceStation = mix(vStart, vEnd, station);
    const pointA = curvePoint(railA.curve, locate(railA, station).parameter);
    const pointB = curvePoint(railB.curve, locate(railB, station).parameter);
    gapA = Math.max(gapA, distance(surfacePoint(surface, 0, surfaceStation), pointA));
    gapB = Math.max(gapB, distance(surfacePoint(surface, 1, surfaceStation), pointB));
  }
  return [gapA, gapB];
}

/** Build a surface between two rails, with sections constrained to both rails. */
export function birailSurface(
  railA: NurbsCurve,
  railB: NurbsCurve,
  sections: readonly NurbsCurve[],
  options: BirailOptions = {},
): Result<BirailResult, ModelingError> {
  const config = configuration(sections, options);
  if (!config.ok) return err(config.error);
  const scaleMode = options.scale ?? 'uniform';
  if (scaleMode !== 'uniform' && scaleMode !== 'width') {
    return err(invalid("scale is 'uniform' or 'width'", { scale: scaleMode }));
  }
  const tableA = validateRail(railA);
  if (!tableA.ok) return err(tableA.error);
  const tableB = validateRail(railB);
  if (!tableB.ok) return err(tableB.error);
  for (let i = 0; i <= ARC_SAMPLES; i++) {
    const station = i / ARC_SAMPLES;
    const a = pointAndTangent(tableA.value, station).point;
    const b = pointAndTangent(tableB.value, station).point;
    if (!(distance(a, b) > 0)) {
      return err(modelingError('model-degenerate', 'the birail curves do not touch', { station }));
    }
  }
  const checkEndpoints = (section: NurbsCurve, index: number, station: number) =>
    checkBirailSection(section, index, station, tableA.value, tableB.value, config.value.tolerance);
  const local = localSections(
    sections,
    config.value.parameters,
    (station) => birailFrame(tableA.value, tableB.value, station),
    true,
    checkEndpoints,
  );
  if (!local.ok) return err(local.error);
  const frameAt = (station: number) => birailFrame(tableA.value, tableB.value, station);
  const built = buildSurface(
    local.value,
    config.value.parameters,
    config.value,
    frameAt,
    true,
    scaleMode === 'uniform',
    (surface) =>
      measureRailGaps(surface, tableA.value, tableB.value).every(
        (gap) => gap <= config.value.tolerance,
      ),
  );
  if (!built.ok) return err(built.error);
  const railGap = measureRailGaps(built.value.surface, tableA.value, tableB.value);
  return ok({ ...built.value, railGap });
}
