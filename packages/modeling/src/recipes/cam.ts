import { err, ok, type Result } from '@forgeax/engine-types';
import { minOf } from '../arrays';
import { atan, cos, hypot2, sin } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import type { Tuple3 } from '../geom';
import { type Model, model } from '../model';
import type { Point2 } from '../primitives';
import { sel } from '../selectors';
import {
  checkAll,
  circle,
  degrees,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
} from './common';

const TWO_PI = 2 * Math.PI;
/** Profile samples over one turn of the cam. */
const SAMPLES = 360;

export interface CamOptions extends RecipeNaming {
  /** Base circle (pitch curve) radius, meters. */
  readonly baseRadius: number;
  /** Follower lift, meters. */
  readonly lift: number;
  /** Duration of each rise and of each return, as a share of the cycle (dwells fill the rest). */
  readonly motionShare: number;
  /** Face width along Z, meters. */
  readonly width: number;
  /** `flat` pushes a flat face; `roller` runs a translating roller on the pitch curve. */
  readonly follower: 'flat' | 'roller';
  /** Roller radius, meters (required for a roller follower). */
  readonly rollerRadius?: number;
  /** Largest pressure angle, degrees (default 30). */
  readonly maxPressureAngle?: number;
  /** Bore diameter, meters (default 0: solid). */
  readonly bore?: number;
}

/** Declared ranges. Motion share is bounded so the rise and return never overlap a dwell. */
export const CAM_RANGES = {
  baseRadius: [0.005, 0.2],
  lift: [0.0005, 0.1],
  motionShare: [0.2, 0.45],
  width: [0.0005, 0.2],
  rollerRadius: [0.0001, 0.05],
  maxPressureAngle: [10, 45],
} as const satisfies Record<string, Range>;

/**
 * Cycloidal rise-dwell-return-dwell lift law at cycle phase `t` in [0, 1). `s` is the lift
 * fraction in [0, 1], `v` is ds/dt and `a` is d2s/dt2 in phase units. Rise over [0, d), dwell
 * at the top to 1/2, return over [1/2, 1/2 + d), dwell at the base after that. Velocity and
 * acceleration vanish at every segment end, so the profile has no impulsive jumps.
 */
export function cycloidal(t: number, motionShare: number): { s: number; v: number; a: number } {
  const d = motionShare;
  if (t < d) {
    const u = t / d;
    return {
      s: u - sin(TWO_PI * u) / TWO_PI,
      v: (1 - cos(TWO_PI * u)) / d,
      a: (TWO_PI * sin(TWO_PI * u)) / (d * d),
    };
  }
  if (t < 0.5) return { s: 1, v: 0, a: 0 };
  if (t < 0.5 + d) {
    const u = (t - 0.5) / d;
    return {
      s: 1 - (u - sin(TWO_PI * u) / TWO_PI),
      v: -(1 - cos(TWO_PI * u)) / d,
      a: (-TWO_PI * sin(TWO_PI * u)) / (d * d),
    };
  }
  return { s: 0, v: 0, a: 0 };
}

/** Radians-based derivatives of the lift at cam angle `theta` (radians). */
function lawAt(theta: number, motionShare: number, lift: number) {
  const t = theta / TWO_PI;
  const law = cycloidal(t, motionShare);
  return {
    s: lift * law.s,
    d1: (lift * law.v) / TWO_PI,
    d2: (lift * law.a) / (TWO_PI * TWO_PI),
  };
}

function signedArea(points: readonly Point2[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Point2;
    const b = points[(i + 1) % points.length] as Point2;
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return twice / 2;
}

/**
 * Derived facts of a cam, from the lift law alone: the largest pressure angle (radians) and the
 * smallest radius of curvature of the cam profile (meters). Roller: pitch-curve radius of
 * curvature less the roller radius; flat: the face contact radius `r + s''`.
 */
function derive(options: CamOptions) {
  const { baseRadius: rb, lift, motionShare, follower } = options;
  const rr = options.rollerRadius ?? 0;
  let maxPressure = 0;
  let minCurvature = Number.POSITIVE_INFINITY;
  for (let k = 0; k < SAMPLES; k++) {
    const theta = (TWO_PI * k) / SAMPLES;
    const { s, d1, d2 } = lawAt(theta, motionShare, lift);
    const r = rb + s;
    if (follower === 'roller') {
      maxPressure = Math.max(maxPressure, atan(Math.abs(d1) / r));
      const radiusSq = r * r + d1 * d1;
      const numerator = radiusSq * Math.sqrt(radiusSq);
      const denominator = r * r + 2 * d1 * d1 - r * d2;
      const rhoPitch = numerator / denominator;
      minCurvature = Math.min(minCurvature, rhoPitch - rr);
    } else {
      minCurvature = Math.min(minCurvature, r + d2);
    }
  }
  return { maxPressure, minCurvature };
}

/** Cam profile points, counter-clockwise, with the follower's contact geometry applied. */
function profile(options: CamOptions): Point2[] {
  const { baseRadius: rb, lift, motionShare, follower } = options;
  const rr = options.rollerRadius ?? 0;
  const points: Point2[] = [];
  for (let k = 0; k < SAMPLES; k++) {
    const theta = (TWO_PI * k) / SAMPLES;
    const c = cos(theta);
    const sn = sin(theta);
    const { s, d1 } = lawAt(theta, motionShare, lift);
    const r = rb + s;
    if (follower === 'roller') {
      const tx = d1 * c - r * sn;
      const ty = d1 * sn + r * c;
      const len = Math.sqrt(tx * tx + ty * ty);
      points.push([r * c - (rr * ty) / len, r * sn + (rr * tx) / len]);
    } else {
      points.push([r * c - d1 * sn, r * sn + d1 * c]);
    }
  }
  return signedArea(points) < 0 ? points.reverse() : points;
}

/**
 * A translating cam about +Z. Its profile is sampled from a cycloidal rise-dwell-return-dwell
 * law: a flat-faced follower contacts it at `(r cos - s' sin, r sin + s' cos)`, and a roller of
 * `rollerRadius` runs on the pitch curve at `r = baseRadius + s`, with the profile offset inward
 * along the pitch normal. The lift law is closed-form, so the pressure angle and radius of
 * curvature are derived analytically, not measured from the mesh.
 *
 * Rejected with `model-invalid-argument` (detail names the limit): a roller follower without
 * `rollerRadius`, a roller that undercuts the profile (`minCurvature <= 0`), and a pressure
 * angle above `maxPressureAngle`. Dimensions: `baseRadius`, `lift`, `maxLift`, `motionShare`,
 * `maxPressureAngle` (degrees), `minCurvature`, `rollerRadius`, `width`, `bore`. Anchor
 * `hub` at the origin. Parts: `<name>`.
 */
export function cam(options: CamOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'cam';
  const { baseRadius, lift, motionShare, width, follower } = options;
  const bore = options.bore ?? 0;
  const maxPressureDeg = options.maxPressureAngle ?? 30;
  const checked = checkAll([
    () => inRange('baseRadius', baseRadius, CAM_RANGES.baseRadius),
    () => inRange('lift', lift, CAM_RANGES.lift),
    () => inRange('motionShare', motionShare, CAM_RANGES.motionShare),
    () => inRange('width', width, CAM_RANGES.width),
    () => inRange('maxPressureAngle', maxPressureDeg, CAM_RANGES.maxPressureAngle),
  ]);
  if (!checked.ok) return checked;
  if (follower !== 'flat' && follower !== 'roller') {
    return err(
      modelingError(
        'model-invalid-argument',
        "a cam follower is 'flat' or 'roller'",
        { follower },
        'choose the follower kind',
      ),
    );
  }
  if (follower === 'roller') {
    if (options.rollerRadius === undefined) {
      return err(
        modelingError(
          'model-invalid-argument',
          'a roller follower needs rollerRadius',
          { follower },
          'pass the roller radius',
        ),
      );
    }
    const rolled = inRange('rollerRadius', options.rollerRadius, CAM_RANGES.rollerRadius);
    if (!rolled.ok) return rolled;
  }
  const { maxPressure, minCurvature } = derive({ ...options, follower });
  if (!(minCurvature > 0)) {
    return err(
      modelingError(
        'model-invalid-argument',
        follower === 'roller'
          ? 'the roller undercuts the cam profile'
          : 'the flat face loses contact on the cam profile',
        { minCurvature, rollerRadius: options.rollerRadius ?? 0, baseRadius, lift },
        follower === 'roller'
          ? 'use a smaller roller or a larger base circle'
          : 'use a larger base circle or a shorter lift',
      ),
    );
  }
  const pressureDeg = degrees(maxPressure);
  if (follower === 'roller' && pressureDeg > maxPressureDeg) {
    return err(
      modelingError(
        'model-invalid-argument',
        'the pressure angle exceeds maxPressureAngle',
        { pressureAngle: pressureDeg, maxPressureAngle: maxPressureDeg },
        'lengthen the motion share or enlarge the base circle',
      ),
    );
  }
  const outline = profile({ ...options, follower });
  const reach = minOf(outline.map((p) => hypot2(p[0], p[1])));
  if (bore > 0 && !(bore / 2 < reach)) {
    return err(
      modelingError(
        'model-invalid-argument',
        'the bore reaches the cam profile',
        { bore, minProfileRadius: reach },
        'reduce the bore',
      ),
    );
  }
  const m = model();
  const holes: Point2[][] = bore > 0 ? [circle(bore / 2, 32)] : [];
  m.extrudePolygon({ points: outline, holes, depth: width, label: name });
  m.translate(sel.all(), [0, 0, -width / 2]);
  return finishPart(
    m,
    name,
    { hub: [0, 0, 0] },
    {
      baseRadius,
      lift,
      maxLift: lift,
      motionShare,
      maxPressureAngle: pressureDeg,
      minCurvature,
      rollerRadius: options.rollerRadius ?? 0,
      width,
      bore,
    },
  );
}

export interface CamFollowerGuideOptions extends RecipeNaming {
  /** Base circle radius of the cam the roller runs on, meters. */
  readonly baseRadius: number;
  /** Follower lift, meters. */
  readonly lift: number;
  /** Roller radius, meters. */
  readonly rollerRadius: number;
  /** Stem radius, meters. */
  readonly stemRadius: number;
  /** Radial clearance between the stem and the guide bore, meters. */
  readonly clearance: number;
  /** Stem length from the roller's outer edge along +X, meters. */
  readonly stemLength: number;
  /** Cam-side face of the guide block along X, meters. */
  readonly guideStart: number;
  /** Guide block length along X, meters. */
  readonly guideLength: number;
  /** Guide block half width across the follower axis, meters. */
  readonly guideHalfWidth: number;
}

/** Declared ranges for the follower guide, meters. */
export const CAM_GUIDE_RANGES = {
  stemRadius: [0.0005, 0.02],
  clearance: [0.00001, 0.001],
} as const satisfies Record<string, Range>;

/**
 * Follower stem sliding in a fixed guide block, both on the follower axis (+X). The stem is
 * bound to the follower joint with its roller; the guide is fixed to the frame. The bore radius
 * is `stemRadius + clearance`, so the stem is held on the axis with a radial clearance of
 * `clearance`, declared as a fit band. `stopMargin` is the gap between the roller's outer edge at
 * max lift and the guide's cam-side face (negative means the roller runs into the guide). Parts:
 * `<name>-stem` and `<name>-guide`. Dimensions include `clearance`, `boreRadius`, `stemLength`,
 * `stopMargin` and `engagedAtMaxLift` (stem length still inside the guide at max lift, meters).
 * Refused with `model-invalid-argument`: a guide too narrow for its bore, and a stem that does not
 * reach the guide at rest. A roller that runs into the guide is not refused: the rig reports it
 * as confirmed interference, which is the design check.
 */
export function camFollowerGuide(
  options: CamFollowerGuideOptions,
): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'cam-follower';
  const { baseRadius: rb, lift, rollerRadius: rr, stemRadius: rs, clearance: c } = options;
  const { stemLength: stem, guideStart: gs, guideLength: gl, guideHalfWidth: h } = options;
  const checked = checkAll([
    () => inRange('stemRadius', rs, CAM_GUIDE_RANGES.stemRadius),
    () => inRange('clearance', c, CAM_GUIDE_RANGES.clearance),
  ]);
  if (!checked.ok) return checked;
  if (!(h > rs + c)) {
    return err(
      modelingError(
        'model-invalid-argument',
        'the guide block is too narrow for the stem bore',
        { guideHalfWidth: h, boreRadius: rs + c },
        'widen the guide block',
      ),
    );
  }
  if (!(rb + rr + stem > gs)) {
    return err(
      modelingError(
        'model-invalid-argument',
        'the stem does not reach the guide at rest',
        { stemLength: stem, guideStart: gs, rollerOuterEdge: rb + rr },
        'lengthen the stem',
      ),
    );
  }
  const bore = rs + c;
  const m = model();
  // Built along +Z and turned onto +X: z maps to x under a +90 deg turn about Y.
  const piece = (label: string, at: Tuple3, build: (s: Model) => void) => {
    const s = model();
    build(s);
    s.rotate(sel.all(), 'y', 90);
    s.translate(sel.all(), at);
    m.append(s.snapshot(), { tag: label });
  };
  // The stem leaves the roller's outer edge on the follower axis, so it does not overlap the roller.
  piece(`${name}-stem`, [rb + rr, 0, 0], (s) =>
    s.extrudePolygon({ points: circle(rs, 32), holes: [], depth: stem, label: `${name}-stem` }),
  );
  piece(`${name}-guide`, [gs, 0, 0], (s) =>
    s.extrudePolygon({
      points: [
        [-h, -h],
        [h, -h],
        [h, h],
        [-h, h],
      ],
      holes: [circle(bore, 32)],
      depth: gl,
      label: `${name}-guide`,
    }),
  );
  const stemTail = rb + rr + lift + stem;
  const engagedAtMaxLift = Math.max(0, Math.min(stemTail, gs + gl) - Math.max(rb + rr + lift, gs));
  const finished = finishPart(
    m,
    name,
    { hub: [rb, 0, 0] },
    {
      baseRadius: rb,
      lift,
      rollerRadius: rr,
      stemRadius: rs,
      boreRadius: bore,
      clearance: c,
      stemLength: stem,
      stopMargin: gs - (rb + lift + rr),
      engagedAtMaxLift,
    },
  );
  if (!finished.ok) return finished;
  return ok({
    ...finished.value,
    contacts: [{ parts: [`${name}-guide`, `${name}-stem`], kind: 'fit', gap: [c * 0.9, c * 1.1] }],
  });
}
