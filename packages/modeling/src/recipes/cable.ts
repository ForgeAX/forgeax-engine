import { err, ok, type Result } from '@forgeax/engine-types';
import { exp, log } from '../brep/dmath-explog';
import { pathFrames } from '../curve';
import { atan2, cos, hypot3, sin } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import { add, cross, dot, length, normalize, scale, sub, type Tuple3 } from '../geom';
import { type Model, model, type OpReport } from '../model';
import {
  checkAll,
  circle,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
} from './common';

/** Catenary points, analytic length and sag, its lowest point, and constant `a = H / w` in meters. */
export interface Catenary {
  readonly points: Tuple3[];
  readonly length: number;
  readonly sag: number;
  readonly lowest: Tuple3;
  readonly parameter: number;
}

/** Cable recipe limits; lengths and radii are in meters. */
export const CABLE_RANGES = {
  samples: [2, 257],
  radius: [0.0005, 0.2],
  strands: [1, 19],
  pitch: [0.002, 2],
  segments: [8, 48],
  wrapWidth: [0.001, 0.1],
  wrapPitch: [0.002, 2],
  wrapThickness: [0.0001, 0.02],
  fittingLength: [0.001, 0.5],
  fittingRadius: [0.0005, 0.5],
} as const satisfies Record<string, Range>;

/** Cable endpoints can be set by either positive sag below their chord or cable length. */
export function catenary(
  a: Tuple3,
  b: Tuple3,
  shape: { readonly sag: number } | { readonly length: number },
  options: { readonly down?: Tuple3; readonly samples?: number } = {},
): Result<Catenary, ModelingError> {
  const samples = options.samples ?? 33;
  const sampleRange = inRange('samples', samples, CABLE_RANGES.samples, true);
  if (!sampleRange.ok) return sampleRange;
  for (const [name, point] of [
    ['a', a],
    ['b', b],
  ] as const) {
    if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) {
      return err(
        modelingError('model-invalid-argument', `${name} is three finite coordinates`, {
          [name]: point,
        }),
      );
    }
  }
  const down = options.down ?? [0, -1, 0];
  if (
    !Array.isArray(down) ||
    down.length !== 3 ||
    !down.every(Number.isFinite) ||
    length(down) === 0
  ) {
    return err(
      modelingError('model-invalid-argument', 'down is a non-zero vector of finite coordinates', {
        down,
      }),
    );
  }
  if (typeof shape !== 'object' || shape === null || Array.isArray(shape)) {
    return err(
      modelingError('model-invalid-argument', 'shape has exactly one of sag or length', { shape }),
    );
  }
  const hasSag = Object.hasOwn(shape, 'sag');
  const hasLength = Object.hasOwn(shape, 'length');
  if (hasSag === hasLength) {
    return err(
      modelingError('model-invalid-argument', 'shape has exactly one of sag or length', { shape }),
    );
  }
  const magnitude = hasSag
    ? (shape as { readonly sag: number }).sag
    : (shape as { readonly length: number }).length;
  if (typeof magnitude !== 'number' || !Number.isFinite(magnitude) || magnitude <= 0) {
    return err(
      modelingError(
        'model-invalid-argument',
        `${hasSag ? 'sag' : 'length'} is finite and greater than zero`,
        { [hasSag ? 'sag' : 'length']: magnitude },
      ),
    );
  }

  // The kernel is Y-up; the local vertical is opposite the caller's down vector.
  const downUnit = normalize(down);
  const chord = sub(b, a);
  const vertical = dot(chord, downUnit);
  const horizontal = sub(chord, scale(downUnit, vertical));
  const span = length(horizontal);
  const chordLength = length(chord);
  if (!(chordLength > 0)) {
    return err(
      modelingError(
        'model-precondition',
        'catenary endpoints are distinct',
        { a, b },
        'separate the supports; a zero span has no cable path',
      ),
    );
  }
  if (!(span > chordLength * 1e-12)) {
    return err(
      modelingError(
        'model-precondition',
        'supports have non-zero horizontal separation in the vertical plane',
        { a, b, down },
        'a vertical cable has no catenary; a slack vertical cable hangs as a loop',
      ),
    );
  }
  const horizontalUnit = scale(horizontal, 1 / span);
  const up = scale(downUnit, -1);
  const slope = -vertical / span;
  let low = 0;
  let high = 1;
  let parameter: number;

  if (hasLength) {
    if (!(magnitude > chordLength)) {
      return err(
        modelingError(
          'model-precondition',
          'cable length exceeds the straight chord',
          { length: magnitude, chord: chordLength },
          'increase the cable length above the support distance',
        ),
      );
    }
    for (let i = 0; i < 128 && arcForK(high, span, slope) < magnitude; i++) high *= 2;
    if (!(arcForK(high, span, slope) >= magnitude)) {
      return err(
        modelingError(
          'model-precondition',
          'a finite catenary parameter represents the requested length',
          { length: magnitude, span, vertical },
          'reduce the requested length or rescale the supports',
        ),
      );
    }
    for (let i = 0; i < 100; i++) {
      const mid = (low + high) / 2;
      if (arcForK(mid, span, slope) < magnitude) low = mid;
      else high = mid;
    }
    parameter = span / (low + high);
  } else {
    if (!(magnitude > 0)) {
      return err(
        modelingError('model-invalid-argument', 'sag is greater than zero', { sag: magnitude }),
      );
    }
    for (let i = 0; i < 128 && sagForK(high, span, slope) < magnitude; i++) high *= 2;
    if (!(sagForK(high, span, slope) >= magnitude)) {
      return err(
        modelingError(
          'model-precondition',
          'a finite catenary parameter represents the requested sag',
          { sag: magnitude, span, vertical },
          'reduce the requested sag or rescale the supports',
        ),
      );
    }
    for (let i = 0; i < 100; i++) {
      const mid = (low + high) / 2;
      if (sagForK(mid, span, slope) < magnitude) low = mid;
      else high = mid;
    }
    parameter = span / (low + high);
  }

  const k = span / (2 * parameter);
  const q = asinh((slope * k) / sinh(k));
  const x0 = parameter * (k - q);
  const startSlope = q - k;
  const analyticLength = parameter * (sinh(k + q) + sinh(k - q));
  const actualSag = sagForK(k, span, slope);
  const totalArc = analyticLength;
  const pointAtX = (x: number): Tuple3 => {
    const u = (x - x0) / parameter;
    const rise = parameter * coshDifference(u, startSlope);
    return add(add(a, scale(horizontalUnit, x)), scale(up, rise));
  };
  const points: Tuple3[] = [];
  for (let i = 0; i < samples; i++) {
    if (i === 0) {
      points.push([...a]);
      continue;
    }
    if (i === samples - 1) {
      points.push([...b]);
      continue;
    }
    const targetArc = (totalArc * i) / (samples - 1);
    const u = asinh(targetArc / parameter + sinh(startSlope));
    const x = Math.max(0, Math.min(span, x0 + parameter * u));
    points.push(pointAtX(x));
  }
  const minimumX = Math.max(0, Math.min(span, x0));
  const lowest =
    minimumX === 0
      ? ([...a] as Tuple3)
      : minimumX === span
        ? ([...b] as Tuple3)
        : pointAtX(minimumX);
  return ok({ points, length: totalArc, sag: actualSag, lowest, parameter });
}

/** A round cable bundle, optional helical strands/wrap, and annular end fittings. */
export interface CableOptions extends RecipeNaming {
  readonly path: readonly Tuple3[];
  /** Outer bundle radius (meters). */
  readonly radius: number;
  /**
   * Sub-cables twist around the transported path frame; omitted means one plain cable. Counts 2 to 7
   * use one touching ring with r = R sin(pi / n) / (1 + sin(pi / n)); counts 8 to 19 use that
   * same one-ring construction and therefore leave a central lumen rather than adding inner layers.
   */
  readonly strands?: { readonly count: number; readonly pitch: number };
  readonly wrap?: { readonly width: number; readonly pitch: number; readonly thickness: number };
  readonly fittings?: { readonly start?: CableFitting; readonly end?: CableFitting };
  /** Polygon sides and helical samples per turn (default 16). */
  readonly segments?: number;
}

/** Optional sleeve (`ferrule`) or tapered strain relief (`boot`) at a cable end. */
export interface CableFitting {
  readonly kind: 'ferrule' | 'boot' | 'none';
  readonly length?: number;
  /** Outer radius at the cable end (meters). */
  readonly radius?: number;
}

/** Build a closed cable bundle along a polyline with optional details. */
export function cable(options: CableOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'cable';
  if (!Array.isArray(options.path) || options.path.length < 2) {
    return err(
      modelingError('model-invalid-argument', 'path has at least two finite points', {
        count: options.path?.length,
      }),
    );
  }
  for (const [index, point] of options.path.entries()) {
    if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) {
      return err(
        modelingError('model-invalid-argument', 'every path point has three finite coordinates', {
          index,
          point,
        }),
      );
    }
  }
  const radius = options.radius;
  const segments = options.segments ?? 16;
  const count = options.strands?.count ?? 1;
  const pitch = options.strands?.pitch;
  const checked = checkAll([
    () => inRange('radius', radius, CABLE_RANGES.radius),
    () => inRange('strands.count', count, CABLE_RANGES.strands, true),
    () => inRange('segments', segments, CABLE_RANGES.segments, true),
    ...(options.strands === undefined
      ? []
      : [() => inRange('strands.pitch', pitch as number, CABLE_RANGES.pitch)]),
  ]);
  if (!checked.ok) return checked as Result<never, ModelingError>;
  const tolerance = 1e-5;
  if (radius < 10 * tolerance) {
    return err(
      modelingError(
        'model-precondition',
        'radius is at least ten model tolerances',
        { radius, tolerance },
        'raise the bundle radius or use a model with finer tolerance',
      ),
    );
  }
  const path = options.path.map((point) => [...point] as Tuple3);
  const cumulative = [0];
  for (let i = 1; i < path.length; i++) {
    const span = length(sub(path[i] as Tuple3, path[i - 1] as Tuple3));
    if (!(span > tolerance)) {
      return err(
        modelingError(
          'model-degenerate',
          'consecutive cable path points are distinct',
          { span: i - 1, distance: span, tolerance },
          'remove repeated or near-repeated path points',
        ),
      );
    }
    cumulative.push((cumulative.at(-1) as number) + span);
  }
  const pathLength = cumulative.at(-1) as number;
  const minimumBend = minimumBendRadius(path);
  if (minimumBend !== undefined && minimumBend.radius < 2 * radius) {
    return err(
      modelingError(
        'model-precondition',
        'the cable path bend radius is at least twice the bundle radius',
        {
          vertex: minimumBend.vertex,
          point: path[minimumBend.vertex],
          radius: minimumBend.radius,
          minimum: 2 * radius,
        },
        'widen the path bend or reduce cable radius',
      ),
    );
  }
  const strandRadius = count === 1 ? radius : bundleStrandRadius(radius, count);
  if (count > 1 && (pitch as number) < 2 * strandRadius) {
    return err(
      modelingError(
        'model-precondition',
        'strand pitch is at least two strand radii',
        { pitch, strandRadius, minimum: 2 * strandRadius },
        'increase the twist pitch or reduce bundle radius',
      ),
    );
  }
  const framePoints =
    count > 1 || options.wrap !== undefined
      ? subdividePath(
          path,
          cumulative,
          pitchForSampling(pitch, options.wrap?.pitch, pathLength, segments * 4),
        )
      : path;
  const frames = pathFrames(framePoints, false, 'rmf', [0, 1, 0]);
  if (!frames.ok) return frames;
  const m = model();
  const circleProfile = circle(strandRadius, segments);

  if (count === 1) {
    const built = m.sweep({
      profile: circleProfile,
      path,
      frame: 'rmf',
      caps: true,
      label: `${name}-strand`,
      tag: `${name}-strand`,
    });
    const failure = operationFailure(m, built);
    if (failure !== undefined) return err(failure);
  } else {
    for (let strand = 0; strand < count; strand++) {
      const phase = (2 * Math.PI * strand) / count;
      const strandPath = (
        frames.value as readonly { point: Tuple3; x: Tuple3; y: Tuple3; s: number }[]
      ).map((frame) => {
        const angle = phase + strandPhase(frame.s, pathLength, pitch as number);
        const offset = add(
          scale(frame.x, (radius - strandRadius) * cos(angle)),
          scale(frame.y, (radius - strandRadius) * sin(angle)),
        );
        return add(frame.point, offset);
      });
      const built = m.sweep({
        profile: circleProfile,
        path: strandPath,
        frame: 'rmf',
        caps: true,
        label: `${name}-strand`,
        tag: `${name}-strand`,
      });
      const failure = operationFailure(m, built);
      if (failure !== undefined) return err(failure);
    }
  }

  if (options.wrap !== undefined) {
    const { width, pitch: wrapPitch, thickness } = options.wrap;
    const wrapChecked = checkAll([
      () => inRange('wrap.width', width, CABLE_RANGES.wrapWidth),
      () => inRange('wrap.pitch', wrapPitch, CABLE_RANGES.wrapPitch),
      () => inRange('wrap.thickness', thickness, CABLE_RANGES.wrapThickness),
    ]);
    if (!wrapChecked.ok) return wrapChecked as Result<never, ModelingError>;
    if (width > wrapPitch) {
      return err(
        modelingError(
          'model-precondition',
          'wrap width does not exceed its pitch',
          { width, pitch: wrapPitch },
          'increase wrap pitch or reduce tape width so adjacent turns do not overlap',
        ),
      );
    }
    const centerRadius = radius + (width + thickness) / 2 + 4 * tolerance;
    const wrapPath = (
      frames.value as readonly { point: Tuple3; x: Tuple3; y: Tuple3; s: number }[]
    ).map((frame) => {
      const angle = strandPhase(frame.s, pathLength, wrapPitch);
      return add(
        frame.point,
        add(scale(frame.x, centerRadius * cos(angle)), scale(frame.y, centerRadius * sin(angle))),
      );
    });
    const halfWidth = width / 2;
    const halfThickness = thickness / 2;
    const wrapProfile: [number, number][] = [
      [-halfThickness, -halfWidth],
      [halfThickness, -halfWidth],
      [halfThickness, halfWidth],
      [-halfThickness, halfWidth],
    ];
    const wrapped = m.sweep({
      profile: wrapProfile,
      path: wrapPath,
      frame: 'rmf',
      caps: true,
      label: `${name}-wrap`,
      tag: `${name}-wrap`,
    });
    const failure = operationFailure(m, wrapped);
    if (failure !== undefined) return err(failure);
  }

  for (const [end, fitting] of [
    ['start', options.fittings?.start],
    ['end', options.fittings?.end],
  ] as const) {
    if (fitting === undefined || fitting.kind === 'none') continue;
    const placed = addFitting(m, name, end, fitting, path, radius);
    if (!placed.ok) return placed;
  }

  const lowestPathPoint = path.reduce(
    (lowest, point) => (point[1] < lowest[1] ? point : lowest),
    path[0] as Tuple3,
  );
  const turns = count > 1 ? pathLength / (pitch as number) : 0;
  return finishPart(
    m,
    name,
    {
      start: [...(path[0] as Tuple3)],
      end: [...(path.at(-1) as Tuple3)],
      lowest: [...lowestPathPoint],
    },
    { length: pathLength, radius, strandRadius, strands: count, turns },
  );
}

function minimumBendRadius(
  path: readonly Tuple3[],
): { readonly vertex: number; readonly radius: number } | undefined {
  let smallest: { vertex: number; radius: number } | undefined;
  for (let i = 1; i + 1 < path.length; i++) {
    const before = sub(path[i] as Tuple3, path[i - 1] as Tuple3);
    const after = sub(path[i + 1] as Tuple3, path[i] as Tuple3);
    const turn = atan2(length(cross(before, after)), dot(before, after));
    if (turn <= 1e-9) continue;
    if (Math.PI - turn <= 1e-9) return { vertex: i, radius: 0 };
    const chord = length(sub(path[i + 1] as Tuple3, path[i - 1] as Tuple3));
    const bendRadius = chord / (2 * sin(turn));
    if (smallest === undefined || bendRadius < smallest.radius)
      smallest = { vertex: i, radius: bendRadius };
  }
  return smallest;
}

function bundleStrandRadius(radius: number, count: number): number {
  const sine = sin(Math.PI / count);
  return (radius * sine) / (1 + sine);
}

function strandPhase(distance: number, total: number, pitch: number): number {
  const transition = Math.min(total / 2, pitch / 16);
  let progress = distance;
  if (distance < transition) {
    const u = distance / transition;
    progress = transition * (2 * u * u - u * u * u);
  } else if (distance > total - transition) {
    const u = (total - distance) / transition;
    progress = total - transition * (2 * u * u - u * u * u);
  }
  return ((2 * Math.PI * progress) / pitch) % (2 * Math.PI);
}

function pitchForSampling(
  strandPitch: number | undefined,
  wrapPitch: number | undefined,
  total: number,
  segments: number,
): number {
  const pitch = Math.min(strandPitch ?? Infinity, wrapPitch ?? Infinity);
  return pitch === Infinity ? total : pitch / segments;
}

function subdividePath(
  path: readonly Tuple3[],
  cumulative: readonly number[],
  maxStep: number,
): Tuple3[] {
  const out: Tuple3[] = [[...(path[0] as Tuple3)]];
  for (let span = 0; span + 1 < path.length; span++) {
    const a = path[span] as Tuple3;
    const b = path[span + 1] as Tuple3;
    const distance = (cumulative[span + 1] as number) - (cumulative[span] as number);
    const steps = Math.max(1, Math.ceil(distance / maxStep));
    for (let i = 1; i <= steps; i++) out.push(add(a, scale(sub(b, a), i / steps)));
  }
  return out;
}

function operationFailure(m: Model, report: OpReport): ModelingError | undefined {
  return m.poisoned ?? report.error;
}

function addFitting(
  m: Model,
  name: string,
  end: 'start' | 'end',
  fitting: CableFitting,
  path: readonly Tuple3[],
  cableRadius: number,
): Result<void, ModelingError> {
  if (fitting.kind !== 'ferrule' && fitting.kind !== 'boot') {
    return err(
      modelingError('model-invalid-argument', "fitting.kind is 'ferrule', 'boot' or 'none'", {
        end,
        kind: fitting.kind,
      }),
    );
  }
  const label = `${name}-fitting-${end}`;
  const tag = `${name}-fitting`;
  const fittingLength =
    fitting.length ?? (fitting.kind === 'boot' ? 4 * cableRadius : 2 * cableRadius);
  const fittingRadius =
    fitting.radius ?? (fitting.kind === 'boot' ? 1.5 * cableRadius : 1.35 * cableRadius);
  const checked = checkAll([
    () => inRange(`fittings.${end}.length`, fittingLength, CABLE_RANGES.fittingLength),
    () => inRange(`fittings.${end}.radius`, fittingRadius, CABLE_RANGES.fittingRadius),
  ]);
  if (!checked.ok) return checked as Result<never, ModelingError>;
  const clearance = Math.max(cableRadius * 1e-3, 2e-5);
  const inner = cableRadius + clearance;
  if (!(fittingRadius > inner + 2e-5)) {
    return err(
      modelingError(
        'model-precondition',
        'fitting outer radius exceeds the bundle and sleeve clearance',
        { end, radius: fittingRadius, inner, cableRadius },
        'increase the fitting radius or reduce the cable radius',
      ),
    );
  }
  const wall = Math.max((fittingRadius - inner) * 0.35, 2e-5);
  const outerTip = fitting.kind === 'boot' ? inner + wall : fittingRadius;
  const point = path[end === 'start' ? 0 : path.length - 1] as Tuple3;
  const tangent = normalize(
    sub(
      path[end === 'start' ? 1 : path.length - 1] as Tuple3,
      path[end === 'start' ? 0 : path.length - 2] as Tuple3,
    ),
  );
  const fittingPath: Tuple3[] =
    end === 'start'
      ? [sub(point, scale(tangent, fittingLength)), [...point] as Tuple3]
      : [[...point] as Tuple3, add(point, scale(tangent, fittingLength))];
  const outerAtStart = fitting.kind === 'boot' && end === 'start' ? outerTip : fittingRadius;
  const outerAtEnd = fitting.kind === 'boot' && end === 'end' ? outerTip : fittingRadius;
  const fittingProfile: [number, number][] = [
    [inner, 0],
    [outerAtStart, 0],
    [outerAtEnd, fittingLength],
    [inner, fittingLength],
    [inner, 0],
  ];
  const swept = m.sweep({
    profile: fittingProfile,
    path: fittingPath,
    frame: 'rmf',
    up: [0, 1, 0],
    caps: true,
    label,
    tag,
  });
  const failure = operationFailure(m, swept);
  if (failure !== undefined) return err(failure);
  return ok(undefined);
}

function sinh(x: number): number {
  if (Math.abs(x) < 1e-4) {
    const x2 = x * x;
    return x * (1 + x2 / 6 + (x2 * x2) / 120);
  }
  return (exp(x) - exp(-x)) / 2;
}

function cosh(x: number): number {
  if (Math.abs(x) < 1e-4) {
    const x2 = x * x;
    return 1 + x2 / 2 + (x2 * x2) / 24;
  }
  return (exp(x) + exp(-x)) / 2;
}

function asinh(x: number): number {
  const absolute = Math.abs(x);
  if (absolute < 1e-4) {
    const x2 = x * x;
    return x * (1 - x2 / 6 + (3 * x2 * x2) / 40);
  }
  const value = log(absolute + Math.sqrt(absolute * absolute + 1));
  return x < 0 ? -value : value;
}

function coshDifference(a: number, b: number): number {
  return 2 * sinh((a + b) / 2) * sinh((a - b) / 2);
}

function arcForK(k: number, span: number, slope: number): number {
  if (k === 0) return span * hypot3(1, slope, 0);
  const q = asinh((slope * k) / sinh(k));
  return (span / k) * sinh(k) * cosh(q);
}

function sagForK(k: number, span: number, slope: number): number {
  if (k === 0) return 0;
  const q = asinh((slope * k) / sinh(k));
  const a = span / (2 * k);
  const x0 = a * (k - q);
  const atChordTangent = asinh(slope);
  const x = x0 + a * atChordTangent;
  const curveRise = a * coshDifference(atChordTangent, q - k);
  return slope * x - curveRise;
}
