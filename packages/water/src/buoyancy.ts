import type {
  PhysicsBodyDynamics,
  PhysicsFixedError,
  PhysicsSensorOverlap,
  PhysicsSensorOverlaps,
  PhysicsWorld,
} from '@forgeax/engine-physics';
import { err, ok, type Result, type WATER_BUOYANCY_DEFAULTS } from '@forgeax/engine-types';
import {
  type Vec3,
  type WaterError,
  type WaterOperationObserver,
  WaterQueryFlags,
  type WaterQueryResult,
} from './contracts.js';
import { beginWaterOperation, endWaterOperation } from './operation-observation.js';
import { type WaterQueryBodySnapshot, waterSplineSample } from './query.js';
import { requireWaterValue } from './required-value.js';
import type { WaterSystem } from './system.js';

export { WATER_BUOYANCY_DEFAULTS } from '@forgeax/engine-types';
export type WaterBuoyancySettings = {
  readonly [K in keyof typeof WATER_BUOYANCY_DEFAULTS]: (typeof WATER_BUOYANCY_DEFAULTS)[K] extends boolean
    ? boolean
    : number;
};
export type WaterPontoon = Readonly<{
  id: string;
  radiusM: number;
  enabled: boolean;
  centerM: Vec3;
  /** Relative center or parent-local socket position, before the source COM rules. */
  coefficientPositionM: Vec3;
  anchor: 'relative' | 'socket';
  previousWaterState?: Readonly<{ inWater: boolean; bodyGuid?: string; bodyGeneration?: number }>;
}>;
export type WaterBuoyancyError = Readonly<{
  code: 'buoyancy-config-invalid' | 'buoyancy-physics-unsupported' | 'buoyancy-candidate-rejected';
  expected: string;
  hint: string;
  detail: WaterBuoyancyErrorDetail;
  coefficientSolve?: WaterPontoonCoefficients;
}>;
export type WaterBuoyancyErrorDetail =
  | Readonly<{ kind: 'coefficient'; reason: 'active-count'; count: number }>
  | Readonly<{
      kind: 'coefficient';
      reason: 'non-finite-input';
      field: 'center-of-mass' | 'coefficient-position';
      pontoonIndex?: number;
    }>
  | Readonly<{
      kind: 'coefficient';
      reason: 'singular-general';
      determinantM4: number;
      thresholdM4: 1e-18;
    }>
  | Readonly<{ kind: 'coefficient'; reason: 'stored-fraction-invalid'; weights: readonly number[] }>
  | Readonly<{
      kind: 'coefficient';
      reason: 'cache-layout-mismatch';
      expectedCount: number;
      actualCount: number;
    }>
  | Readonly<{ kind: 'root'; reason: 'invalid-root-mass'; entity: number; massKg: number }>
  | Readonly<{
      kind: 'step';
      reason: 'overlap-step-mismatch';
      dynamicsCompletedStep: number;
      overlapCompletedStep: number;
    }>
  | Readonly<{ kind: 'input'; reason: 'time-settings-generation-geometry' }>
  | Readonly<{
      kind: 'settings';
      reason: 'velocity-pontoon-index';
      velocityPontoonIndex: number;
      configuredCount: number;
    }>
  | Readonly<{
      kind: 'physics';
      reason: 'backend-missing' | 'dynamics-capability' | 'force-capability';
      entity: number;
    }>
  | Readonly<{
      kind: 'configuration';
      reason:
        | 'retired'
        | 'cardinality'
        | 'enabled-mask'
        | 'root-transform-missing'
        | 'root-transform-invalid';
      entity: number;
    }>
  | Readonly<{
      kind: 'socket';
      reason: 'not-descendant' | 'stale-or-cyclic' | 'detached' | 'transform-missing';
      socket: number;
    }>
  | Readonly<{
      kind: 'candidate';
      reason: 'stale-collider' | 'water-publication';
      overlap: PhysicsSensorOverlap;
      bodyGuid?: string;
      bodyGeneration?: number;
      collisionRevision?: number;
    }>
  | Readonly<{ kind: 'pontoon'; reason: 'disabled' }>;
export type WaterBuoyancyFailure = WaterBuoyancyError | WaterError | PhysicsFixedError;
export type WaterBuoyancyCandidateTrace = Readonly<{
  overlap: PhysicsSensorOverlap;
  bodyGuid?: string;
  bodyGeneration?: number;
  splineSample?: NonNullable<ReturnType<typeof waterSplineSample>>;
  result: Result<WaterQueryResult, WaterBuoyancyFailure>;
  isInWater: boolean;
}>;
export type WaterPontoonTrace = Readonly<{
  physicsStep: number;
  completedOverlapStep: number;
  fixedDeltaSeconds: number;
  fixedTimeSeconds: number;
  rootEntity: number;
  rootGeneration: number;
  pontoonId: string;
  enabled: boolean;
  anchor: WaterPontoon['anchor'];
  coefficientSpace: WaterPontoonCoefficientPoint['coefficientSpace'];
  coefficientPositionM: Vec3;
  massFramePositionM: Vec3;
  centerM: Vec3;
  radiusM: number;
  queryPointM: Vec3;
  candidateRoster: readonly WaterBuoyancyCandidateTrace[];
  queryFlags: number;
  selectedBodyGuid?: string;
  selectedBodyGeneration?: number;
  splineSample?: NonNullable<ReturnType<typeof waterSplineSample>>;
  waterYM?: number;
  immersionM: number;
  volumeM3: number;
  sprungMassKg: number;
  coefficient: number;
  rampCoefficientNPerM3: number;
  dampingN: number;
  preCapForceN: number;
  postCapForceN: number;
  buoyancyForceN: Vec3;
  riverForceN: Vec3;
  dragForceN: Vec3;
  applicationPointM: Vec3;
  torqueNm: Vec3;
  inWater: boolean;
  result: Result<void, WaterBuoyancyFailure>;
}>;
export type WaterBuoyancyForceEvent = Readonly<{
  physicsStep: number;
  rootEntity: number;
  rootGeneration: number;
  pontoonId: string;
  bodyGuid: string;
  bodyGeneration: number;
  positionM: Vec3;
  forceN: Vec3;
  torqueNm: Vec3;
}>;
export type WaterSplashWakeEvent = Readonly<{
  sourcePhysicsStep: number;
  queryTimeSeconds: number;
  fixedDeltaSeconds: number;
  rootEntity: number;
  rootGeneration: number;
  pontoonId: string;
  bodyGuid?: string;
  bodyGeneration?: number;
  phase: 'entered' | 'exited' | 'wake';
  positionM: Vec3;
  forceN: Vec3;
  contact:
    | Readonly<{
        kind: 'none';
        reason: 'exited' | 'surface-unavailable' | 'tangent' | 'submerged' | 'above-surface';
      }>
    | Readonly<{
        kind: 'water-plane-intersection';
        positionM: Vec3;
        radiusM: number;
        relativeVelocityMps: Vec3;
      }>;
}>;
export type WaterPontoonCoefficientDiagnostic = Readonly<{
  code: 'sprung-axis-singular';
  axis: 'x' | 'z';
  determinantM2: number;
  thresholdM2: 1e-14;
}>;
export type WaterPontoonCoefficients = Readonly<{
  sourceSuccess: boolean;
  sourceStatus: 'computed' | 'not-invoked';
  centerOfMassM: Vec3;
  centerPontoonsOnCOM: boolean;
  branch: 'unselected' | 'inactive' | 'single' | 'pair' | 'axis-x' | 'axis-z' | 'general';
  points: readonly WaterPontoonCoefficientPoint[];
  coefficients: readonly number[];
  diagnostics: readonly WaterPontoonCoefficientDiagnostic[];
}>;
export type WaterPontoonCoefficientPoint = Readonly<{
  id: string;
  enabled: boolean;
  anchor: WaterPontoon['anchor'];
  coefficientSpace: 'root-local' | 'socket-parent-local';
  coefficientPositionM: Vec3;
  massFramePositionM: Vec3;
}>;
export type WaterBuoyancyStep = Readonly<{
  physicsStep: number;
  rootEntity: number;
  rootGeneration: number;
  dynamics: PhysicsBodyDynamics;
  overlaps: PhysicsSensorOverlaps;
  coefficientSolve: WaterPontoonCoefficients;
  coefficientCache: Readonly<{ enabledMask: number; hit: boolean }>;
  pontoons: readonly WaterPontoonTrace[];
  forceEvents: readonly WaterBuoyancyForceEvent[];
  splashWakeEvents: readonly WaterSplashWakeEvent[];
  riverAccelerationMps2: Vec3;
  dragAccelerationMps2: Vec3;
  angularAccelerationRadps2: Vec3;
  angularDragTorqueNm: Vec3;
  bodyForceResult: Result<void, WaterBuoyancyFailure>;
  bodyTorqueResult: Result<void, WaterBuoyancyFailure>;
}>;

const zero = (): Vec3 => [0, 0, 0];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): Vec3 => mul(a, 1 / (Math.hypot(...a) || 1));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const failure = (
  detail: WaterBuoyancyErrorDetail,
  code: WaterBuoyancyError['code'] = 'buoyancy-config-invalid',
): WaterBuoyancyError => ({
  code,
  expected:
    'finite enabled pontoon geometry, source settings and current completed Physics/Water input',
  hint: 'repair the named source; rejected pontoons never apply force',
  detail,
});

export function sphericalCapVolumeM3(radiusM: number, immersionM: number): number {
  const h = clamp(immersionM, 0, 2 * radiusM);
  return (Math.PI / 3) * h * h * (3 * radiusM - h);
}

/** UE min-variance sprung fractions; aligned supports retain its one-axis branch. */
function coefficientInputIssue(
  pontoons: readonly WaterPontoon[],
  comM: Vec3,
): Extract<WaterBuoyancyErrorDetail, { reason: 'non-finite-input' }> | undefined {
  if (comM.length !== 3 || !Array.from(comM).every(Number.isFinite))
    return { kind: 'coefficient', reason: 'non-finite-input', field: 'center-of-mass' };
  const pontoonIndex = pontoons.findIndex(
    (p) =>
      p.coefficientPositionM.length !== 3 ||
      !Array.from(p.coefficientPositionM).every(Number.isFinite),
  );
  return pontoonIndex < 0
    ? undefined
    : {
        kind: 'coefficient',
        reason: 'non-finite-input',
        field: 'coefficient-position',
        pontoonIndex,
      };
}

function coefficientInputs(
  pontoons: readonly WaterPontoon[],
  comM: Vec3,
  centerOnCOM: boolean,
): readonly WaterPontoonCoefficientPoint[] {
  return Object.freeze(
    pontoons.map((p) => {
      const initial =
        p.anchor === 'relative' && centerOnCOM
          ? sub(p.coefficientPositionM, comM)
          : p.coefficientPositionM;
      return Object.freeze({
        id: p.id,
        enabled: p.enabled,
        anchor: p.anchor,
        coefficientSpace:
          p.anchor === 'relative' ? ('root-local' as const) : ('socket-parent-local' as const),
        coefficientPositionM: Object.freeze<Vec3>([...p.coefficientPositionM]),
        massFramePositionM: Object.freeze(sub(initial, comM)),
      });
    }),
  );
}

export function computeWaterPontoonCoefficients(
  pontoons: readonly WaterPontoon[],
  comM: Vec3,
  centerOnCOM = true,
): Result<WaterPontoonCoefficients, WaterBuoyancyError> {
  const inputs = coefficientInputs(pontoons, comM, centerOnCOM);
  const active = inputs.map((p, i) => ({ p, i })).filter(({ p }) => p.enabled);
  const points = active.map(({ p }) => p.massFramePositionM);
  const diagnostics: WaterPontoonCoefficientDiagnostic[] = [];
  let branch: WaterPontoonCoefficients['branch'] = 'unselected';
  const trace = (
    sourceSuccess: boolean,
    weights: readonly number[],
    sourceStatus: WaterPontoonCoefficients['sourceStatus'] = 'computed',
  ): WaterPontoonCoefficients => {
    const coefficients = pontoons.map(() => 0);
    active.forEach(({ i }, j) => {
      coefficients[i] = weights[j] ?? 0;
    });
    return Object.freeze({
      sourceSuccess,
      sourceStatus,
      centerOfMassM: Object.freeze<Vec3>([...comM]),
      centerPontoonsOnCOM: centerOnCOM,
      branch,
      points: inputs,
      coefficients: Object.freeze(coefficients),
      diagnostics: Object.freeze(diagnostics),
    });
  };
  const reject = (detail: WaterBuoyancyErrorDetail, weights: readonly number[] = []) =>
    err<WaterBuoyancyError>({ ...failure(detail), coefficientSolve: trace(false, weights) });
  const inputIssue = coefficientInputIssue(pontoons, comM);
  if (inputIssue !== undefined)
    return err({ ...failure(inputIssue), coefficientSolve: trace(false, [], 'not-invoked') });
  if (!active.length || active.length > 32)
    return err({
      ...failure({ kind: 'coefficient', reason: 'active-count', count: active.length }),
      coefficientSolve: trace(false, [], 'not-invoked'),
    });
  let weights: number[];
  if (points.length === 1) {
    branch = 'single';
    weights = [1];
  } else if (points.length === 2) {
    branch = 'pair';
    const a = requireWaterValue(points[0]),
      b = requireWaterValue(points[1]),
      dx = b[0] - a[0],
      dz = b[2] - a[2],
      length2 = dx * dx + dz * dz;
    const first = Math.fround(
      Math.hypot(dx, dz) <= 1e-10 ? 0.5 : ((0 - a[0]) * dx + (0 - a[2]) * dz) / length2,
    );
    weights = [first, Math.fround(1 - first)];
  } else {
    const n = points.length,
      base = 1 / n;
    const first = requireWaterValue(points[0]);
    const axis = points.every((p) => Math.abs(p[2] - first[2]) <= 0.001)
      ? 0
      : points.every((p) => Math.abs(p[0] - first[0]) <= 0.001)
        ? 2
        : undefined;
    if (axis !== undefined) {
      branch = axis === 0 ? 'axis-x' : 'axis-z';
      const sum = points.reduce((total, p) => total + p[axis], 0);
      const sumSquares = points.reduce((total, p) => total + p[axis] * p[axis], 0);
      const determinant = n * sumSquares - sum * sum;
      let lambdaAxis: number, lambdaConstant: number;
      if (Math.abs(determinant) <= 1e-14) {
        // The source ignores the helper failure and retains its SI lambda inputs.
        lambdaAxis = -1e4 * base * sum;
        lambdaConstant = 0;
        diagnostics.push({
          code: 'sprung-axis-singular',
          axis: axis === 0 ? 'x' : 'z',
          determinantM2: determinant,
          thresholdM2: 1e-14,
        });
      } else {
        lambdaAxis = -sum / determinant;
        lambdaConstant = (base * sum * sum) / determinant;
      }
      weights = points.map((p) => Math.fround(base + lambdaAxis * p[axis] + lambdaConstant));
    } else {
      branch = 'general';
      let x = 0,
        z = 0,
        xx = 0,
        xz = 0,
        zz = 0;
      for (const p of points) {
        x += p[0];
        z += p[2];
        xx += p[0] * p[0];
        xz += p[0] * p[2];
        zz += p[2] * p[2];
      }
      const c00 = zz * n - z * z,
        c01 = x * z - xz * n,
        c02 = xz * z - zz * x,
        c11 = xx * n - x * x,
        c12 = xz * x - xx * z;
      const determinant = xx * c00 + xz * c01 + x * c02;
      if (Math.abs(determinant) <= 1e-18)
        return reject({
          kind: 'coefficient',
          reason: 'singular-general',
          determinantM4: determinant,
          thresholdM4: 1e-18,
        });
      const rhsX = -base * x,
        rhsZ = -base * z;
      const lambdaX = (c00 * rhsX + c01 * rhsZ) / determinant;
      const lambdaZ = (c01 * rhsX + c11 * rhsZ) / determinant;
      const lambdaConstant = (c02 * rhsX + c12 * rhsZ) / determinant;
      weights = points.map((p) =>
        Math.fround(base + lambdaX * p[0] + lambdaZ * p[2] + lambdaConstant),
      );
    }
  }
  if (weights.some((v) => !Number.isFinite(v) || v < 0))
    return reject({ kind: 'coefficient', reason: 'stored-fraction-invalid', weights }, weights);
  return ok(trace(true, weights));
}

/** One admitted participant owns these source solves for its enabled masks. */
export class WaterBuoyancyCoefficientCache {
  private readonly solves = new Map<number, Result<WaterPontoonCoefficients, WaterBuoyancyError>>();

  resolve(pontoons: readonly WaterPontoon[], comM: Vec3, centerOnCOM: boolean) {
    const enabledMask = pontoons.reduce(
      (mask, point, index) => (point.enabled ? (mask | (1 << index)) >>> 0 : mask),
      0,
    );
    if (coefficientInputIssue(pontoons, comM) !== undefined)
      return {
        enabledMask,
        hit: false,
        result: computeWaterPontoonCoefficients(pontoons, comM, centerOnCOM),
      } as const;
    const cached = this.solves.get(enabledMask);
    if (cached !== undefined) {
      const solve = cached.ok ? cached.value : cached.error.coefficientSolve;
      if (solve !== undefined && solve.points.length !== pontoons.length)
        return {
          enabledMask,
          hit: false,
          result: err(
            failure({
              kind: 'coefficient',
              reason: 'cache-layout-mismatch',
              expectedCount: solve.points.length,
              actualCount: pontoons.length,
            }),
          ),
        } as const;
      return { enabledMask, hit: true, result: cached } as const;
    }
    const result =
      enabledMask === 0
        ? ok<WaterPontoonCoefficients>({
            sourceSuccess: false,
            sourceStatus: 'not-invoked',
            branch: 'inactive',
            centerOfMassM: Object.freeze<Vec3>([...comM]),
            centerPontoonsOnCOM: centerOnCOM,
            points: coefficientInputs(pontoons, comM, centerOnCOM),
            coefficients: Object.freeze(pontoons.map(() => 0)),
            diagnostics: Object.freeze([]),
          })
        : computeWaterPontoonCoefficients(pontoons, comM, centerOnCOM);
    this.solves.set(enabledMask, result);
    return { enabledMask, hit: false, result } as const;
  }
}

export function rotateWaterVector(q: PhysicsBodyDynamics['rotation'], v: Vec3): Vec3 {
  const qv: Vec3 = [q[0], q[1], q[2]],
    t = mul(cross(qv, v), 2);
  return add(v, add(mul(t, q[3]), cross(qv, t)));
}
export function waterWorldInertiaTorque(
  dynamics: PhysicsBodyDynamics,
  angularAcceleration: Vec3,
): Vec3 {
  const toLocal = (q: PhysicsBodyDynamics['rotation'], v: Vec3) =>
    rotateWaterVector([-q[0], -q[1], -q[2], q[3]], v);
  const local = toLocal(
    dynamics.principalInertiaLocalRotation,
    toLocal(dynamics.rotation, angularAcceleration),
  );
  const scaled: Vec3 = [
    local[0] * dynamics.principalInertiaKgM2[0],
    local[1] * dynamics.principalInertiaKgM2[1],
    local[2] * dynamics.principalInertiaKgM2[2],
  ];
  return rotateWaterVector(
    dynamics.rotation,
    rotateWaterVector(dynamics.principalInertiaLocalRotation, scaled),
  );
}

const QUERY_FLAGS =
  WaterQueryFlags.ComputeLocation |
  WaterQueryFlags.ComputeNormal |
  WaterQueryFlags.ComputeImmersionDepth |
  WaterQueryFlags.ComputeVelocity |
  WaterQueryFlags.IncludeWaves;

/** The query and native pose belong to the force snapshot, before integration. */
export function waterPontoonContact(
  pontoon: WaterPontoonTrace,
  dynamics: PhysicsBodyDynamics,
): WaterSplashWakeEvent['contact'] {
  const none = (reason: Extract<WaterSplashWakeEvent['contact'], { kind: 'none' }>['reason']) =>
    Object.freeze({ kind: 'none', reason } as const);
  if (!pontoon.inWater) return none('exited');
  const waterY = pontoon.waterYM;
  if (waterY === undefined) return none('surface-unavailable');
  const offsetM = waterY - pontoon.centerM[1];
  if (Math.abs(offsetM) === pontoon.radiusM) return none('tangent');
  if (offsetM > pontoon.radiusM) return none('submerged');
  if (offsetM < -pontoon.radiusM) return none('above-surface');
  const selected = pontoon.candidateRoster.find(
    (candidate) =>
      candidate.bodyGuid === pontoon.selectedBodyGuid &&
      candidate.bodyGeneration === pontoon.selectedBodyGeneration &&
      candidate.result.ok,
  )?.result;
  const velocity = selected?.ok ? (selected.value.velocityMPerSec ?? zero()) : zero();
  const positionM: Vec3 = Object.freeze([pontoon.centerM[0], waterY, pontoon.centerM[2]]);
  return Object.freeze({
    kind: 'water-plane-intersection',
    positionM,
    radiusM: Math.sqrt(pontoon.radiusM ** 2 - offsetM ** 2),
    relativeVelocityMps: Object.freeze(
      sub(
        add(
          dynamics.linearVelocityMps,
          cross(dynamics.angularVelocityRadps, sub(positionM, dynamics.centerOfMassM)),
        ),
        velocity,
      ),
    ),
  });
}

export function stepWaterBuoyancy(
  input: Readonly<{
    physics: Pick<PhysicsWorld, 'applyBodyForceAtPoint' | 'applyBodyTorque'>;
    water: Pick<WaterSystem, 'queryBody'>;
    dynamics: PhysicsBodyDynamics;
    overlaps: PhysicsSensorOverlaps;
    pontoons: readonly WaterPontoon[];
    settings: WaterBuoyancySettings;
    fixedDeltaSeconds: number;
    fixedTimeSeconds: number;
    nativePhysicsTimeSeconds?: number;
    resolveBody: (
      overlap: PhysicsSensorOverlap,
    ) => Result<WaterQueryBodySnapshot, WaterBuoyancyFailure>;
    solverSafe?: boolean;
    observe?: WaterOperationObserver;
  }> &
    (
      | Readonly<{ coefficientCache: WaterBuoyancyCoefficientCache; coefficientResolution?: never }>
      | Readonly<{
          coefficientCache?: never;
          coefficientResolution: ReturnType<WaterBuoyancyCoefficientCache['resolve']>;
        }>
    ),
): Result<WaterBuoyancyStep, WaterBuoyancyFailure> {
  const {
    physics,
    water,
    dynamics,
    overlaps,
    pontoons,
    settings: s,
    fixedDeltaSeconds: dt,
  } = input;
  if (!physics.applyBodyForceAtPoint || !physics.applyBodyTorque)
    return err(
      failure(
        { kind: 'physics', reason: 'force-capability', entity: dynamics.entity },
        'buoyancy-physics-unsupported',
      ),
    );
  if (!(Number.isFinite(dynamics.massKg) && dynamics.massKg > 0))
    return err(
      failure({
        kind: 'root',
        reason: 'invalid-root-mass',
        entity: dynamics.entity,
        massKg: dynamics.massKg,
      }),
    );
  if (overlaps.completedStep !== dynamics.completedStep)
    return err(
      failure({
        kind: 'step',
        reason: 'overlap-step-mismatch',
        dynamicsCompletedStep: dynamics.completedStep,
        overlapCompletedStep: overlaps.completedStep,
      }),
    );
  if (
    !Number.isInteger(s.velocityPontoonIndex) ||
    s.velocityPontoonIndex < 0 ||
    s.velocityPontoonIndex >= pontoons.length
  )
    return err(
      failure({
        kind: 'settings',
        reason: 'velocity-pontoon-index',
        velocityPontoonIndex: s.velocityPontoonIndex,
        configuredCount: pontoons.length,
      }),
    );
  const admitsStepInputs = (): boolean =>
    !(
      !(dt > 0 && dt <= 0.1) ||
      !Number.isFinite(input.fixedTimeSeconds) ||
      overlaps.rootEntity !== dynamics.entity ||
      overlaps.rootGeneration !== dynamics.generation ||
      Object.entries(s).some(
        ([key, v]) =>
          typeof v === 'number' &&
          (!Number.isFinite(v) ||
            (v < 0 && !(input.solverSafe && key === 'riverShoreFactor' && v >= -1))),
      ) ||
      s.rampMaxSpeedMps <= s.rampMinSpeedMps ||
      s.riverShoreFactor > 1 ||
      pontoons.length < 1 ||
      pontoons.length > 32 ||
      pontoons.some(
        (p) =>
          !p.id ||
          !(p.radiusM > 0) ||
          ![...p.centerM, ...p.coefficientPositionM, p.radiusM].every(Number.isFinite),
      )
    );
  if (!admitsStepInputs())
    return err(failure({ kind: 'input', reason: 'time-settings-generation-geometry' }));
  const applyBodyForceAtPoint = physics.applyBodyForceAtPoint.bind(physics);
  const coefficientCache =
    input.coefficientResolution ??
    input.coefficientCache.resolve(pontoons, dynamics.localCenterOfMassM, s.centerPontoonsOnCOM);
  const coefficients = coefficientCache.result;
  if (!coefficients.ok) return coefficients;
  const solvedCoefficients = coefficients.value;
  const forward = rotateWaterVector(dynamics.rotation, [1, 0, 0]);
  const forwardSpeed = dot(dynamics.linearVelocityMps, forward);
  const ramp = clamp(
    (forwardSpeed - s.rampMinSpeedMps) / (s.rampMaxSpeedMps - s.rampMinSpeedMps),
    0,
    1,
  );
  const rampCoefficient = s.buoyancyCoefficientNPerM3 * (1 + ramp * (s.rampMax - 1));
  const vy = dynamics.linearVelocityMps[1];
  const damping = -Math.max(
    s.dampingNPerMps * vy + Math.sign(vy) * s.dampingNPerMpsSquared * vy * vy,
    0,
  );
  const forceEvents: WaterBuoyancyForceEvent[] = [];
  const selected: (WaterQueryBodySnapshot | undefined)[] = [];
  const traces: WaterPontoonTrace[] = pontoons.map((p, index) => {
    const queryPoint: Vec3 = [p.centerM[0], p.centerM[1] - p.radiusM - 1, p.centerM[2]];
    const candidates: WaterBuoyancyCandidateTrace[] = [];
    let winner: WaterQueryResult | undefined,
      selectedBody: WaterQueryBodySnapshot | undefined,
      selectedSpline: WaterBuoyancyCandidateTrace['splineSample'],
      maxImmersion = -1;
    const collectPontoonCandidates = (): void => {
      for (const overlap of p.enabled ? [...overlaps.current, ...overlaps.stale] : []) {
        const resolved = overlaps.stale.includes(overlap)
          ? err(
              failure(
                { kind: 'candidate', overlap, reason: 'stale-collider' },
                'buoyancy-candidate-rejected',
              ),
            )
          : input.resolveBody(overlap);
        const splineScope = beginWaterOperation(input.observe, 'water/buoyancy/spline-sample');
        let spline: ReturnType<typeof waterSplineSample>;
        try {
          spline = resolved.ok ? waterSplineSample(resolved.value, p.centerM) : undefined;
        } finally {
          endWaterOperation(splineScope);
        }
        let result: Result<WaterQueryResult, WaterBuoyancyFailure>;
        if (resolved.ok && p.enabled) {
          const queryInput = {
            positionM: queryPoint,
            flags: QUERY_FLAGS,
            receiver: { entity: dynamics.entity, generation: dynamics.generation },
            timeSeconds: input.fixedTimeSeconds,
            ...(input.nativePhysicsTimeSeconds === undefined
              ? {}
              : {
                  nativePhysics: {
                    completedStep: dynamics.completedStep,
                    timeSeconds: input.nativePhysicsTimeSeconds,
                  },
                }),
            expectedBodyGeneration: resolved.value.sceneGeneration,
            ...(spline === undefined ? {} : { splineKey: spline.key }),
          };
          const queryScope = beginWaterOperation(input.observe, 'water/buoyancy/candidate-query');
          try {
            result = water.queryBody(resolved.value.guid, queryInput, input.observe);
          } finally {
            endWaterOperation(queryScope);
          }
        } else if (resolved.ok) result = err(failure({ kind: 'pontoon', reason: 'disabled' }));
        else result = resolved;
        const candidateImmersion = result.ok ? result.value.immersionM : undefined;
        const candidateIsInWater = (): boolean => {
          const isInWater =
            result.ok &&
            !result.value.excluded &&
            result.value.valid.has('immersion') &&
            candidateImmersion !== undefined &&
            candidateImmersion > 0;
          return isInWater;
        };
        const isInWater = candidateIsInWater();
        candidates.push({
          overlap,
          ...(resolved.ok
            ? { bodyGuid: resolved.value.guid, bodyGeneration: resolved.value.sceneGeneration }
            : {}),
          result,
          ...(spline === undefined ? {} : { splineSample: spline }),
          isInWater,
        });
        if (
          result.ok &&
          resolved.ok &&
          isInWater &&
          candidateImmersion !== undefined &&
          candidateImmersion > maxImmersion
        ) {
          winner = result.value;
          selectedBody = resolved.value;
          selectedSpline = spline;
          maxImmersion = candidateImmersion;
        }
      }
    };
    collectPontoonCandidates();
    selected[index] = selectedBody;
    const waterY = winner?.immersionM === undefined ? undefined : queryPoint[1] + winner.immersionM;
    const immersion = waterY === undefined ? -1 : waterY - (p.centerM[1] - p.radiusM);
    const volume =
      p.enabled && waterY !== undefined ? sphericalCapVolumeM3(p.radiusM, immersion) : 0;
    const coefficient = solvedCoefficients.coefficients[index] as number;
    const preCap = volume * rampCoefficient + damping;
    const postCap = clamp(preCap, 0, s.maxBuoyantForceN);
    const force: Vec3 = [0, p.enabled && waterY !== undefined ? postCap * coefficient : 0, 0];
    const torque = cross(sub(p.centerM, dynamics.centerOfMassM), force);
    const result = p.enabled
      ? applyBodyForceAtPoint({
          entity: dynamics.entity,
          generation: dynamics.generation,
          fixedStep: dynamics.nextFixedStep,
          forceN: force,
          pointM: p.centerM,
        })
      : ok(undefined);
    if (result.ok && selectedBody && force[1] !== 0)
      forceEvents.push({
        physicsStep: dynamics.nextFixedStep,
        rootEntity: dynamics.entity,
        rootGeneration: dynamics.generation,
        pontoonId: p.id,
        bodyGuid: selectedBody.guid,
        bodyGeneration: selectedBody.sceneGeneration,
        positionM: p.centerM,
        forceN: force,
        torqueNm: torque,
      });
    return {
      physicsStep: dynamics.nextFixedStep,
      completedOverlapStep: overlaps.completedStep,
      fixedDeltaSeconds: dt,
      fixedTimeSeconds: input.fixedTimeSeconds,
      rootEntity: dynamics.entity,
      rootGeneration: dynamics.generation,
      pontoonId: p.id,
      enabled: p.enabled,
      anchor: p.anchor,
      coefficientSpace: (solvedCoefficients.points[index] as WaterPontoonCoefficientPoint)
        .coefficientSpace,
      coefficientPositionM: (solvedCoefficients.points[index] as WaterPontoonCoefficientPoint)
        .coefficientPositionM,
      massFramePositionM: (solvedCoefficients.points[index] as WaterPontoonCoefficientPoint)
        .massFramePositionM,
      centerM: p.centerM,
      radiusM: p.radiusM,
      queryPointM: queryPoint,
      candidateRoster: candidates,
      queryFlags: QUERY_FLAGS,
      ...(selectedSpline === undefined ? {} : { splineSample: selectedSpline }),
      ...(waterY !== undefined && selectedBody
        ? {
            selectedBodyGuid: selectedBody.guid,
            selectedBodyGeneration: selectedBody.sceneGeneration,
            waterYM: waterY,
          }
        : {}),
      immersionM: immersion,
      volumeM3: volume,
      sprungMassKg: dynamics.massKg * coefficient,
      coefficient,
      rampCoefficientNPerM3: rampCoefficient,
      dampingN: damping,
      preCapForceN: preCap,
      postCapForceN: postCap,
      buoyancyForceN: force,
      riverForceN: zero(),
      dragForceN: zero(),
      applicationPointM: p.centerM,
      torqueNm: torque,
      inWater: p.enabled && waterY !== undefined && immersion >= 0,
      result,
    };
  });
  let river = zero(),
    drag = zero(),
    angular = zero();
  const velocityIndex =
      input.solverSafe && selected[s.velocityPontoonIndex]?.asset.type !== 'river'
        ? Math.max(
            0,
            selected.findIndex((body) => body?.asset.type === 'river'),
          )
        : s.velocityPontoonIndex,
    velocityBody = selected[velocityIndex],
    velocityTrace = traces[velocityIndex];
  const applyRiverAcceleration = (): void => {
    if (s.applyRiverForces && velocityBody?.asset.type === 'river' && velocityTrace) {
      const spline = velocityTrace.splineSample;
      if (spline) {
        const shore = norm([
          velocityTrace.centerM[0] - spline.positionM[0],
          0,
          velocityTrace.centerM[2] - spline.positionM[2],
        ]);
        const direction = add(
          mul(spline.tangent, s.riverShoreFactor === 1 ? 0 : 1 - s.riverShoreFactor),
          mul(shore, s.riverShoreFactor),
        );
        if (
          !input.solverSafe &&
          Math.abs(dot(dynamics.linearVelocityMps, direction)) < spline.speedMps
        ) {
          river = mul(direction, (spline.speedMps / dt) * s.riverVelocityStrength);
          const magnitude = Math.hypot(...river);
          if (magnitude > s.maxRiverAccelerationMps2)
            river = mul(river, s.maxRiverAccelerationMps2 / magnitude);
        }
        if (input.solverSafe) {
          const current = mul(spline.tangent, spline.speedMps * s.riverVelocityStrength);
          const allowCurrent =
            s.allowFastUpstream ||
            Math.abs(dot(dynamics.linearVelocityMps, norm(current))) < spline.speedMps;
          const distance = Math.hypot(
            velocityTrace.centerM[0] - spline.positionM[0],
            velocityTrace.centerM[2] - spline.positionM[2],
          );
          const inward = mul(shore, -1);
          let lateral =
            s.riverShoreFactor >= 0
              ? mul(shore, s.riverShoreFactor)
              : mul(
                  inward,
                  (-s.riverShoreFactor * (distance - s.riverTraversalPathWidthM)) /
                    Math.max(s.riverTraversalPathWidthM, 1e-8),
                );
          if (s.riverShoreFactor < 0 && distance <= s.riverTraversalPathWidthM)
            lateral = mul(
              inward,
              (-dot(dynamics.linearVelocityMps, inward) /
                Math.max(s.maxRiverAccelerationMps2, 1e-8)) *
                ((2 * distance) / Math.max(s.riverTraversalPathWidthM, 1e-8)) *
                Math.abs(s.riverShoreFactor),
            );
          const limit = (v: Vec3, max: number): Vec3 =>
            Math.hypot(...v) > max ? mul(norm(v), max) : v;
          river = add(
            allowCurrent ? limit(mul(current, 1 / dt), s.maxRiverAccelerationMps2) : zero(),
            allowCurrent || s.alwaysAllowLateralPush
              ? limit(mul(lateral, 1 / dt), s.maxLateralAccelerationMps2)
              : zero(),
          );
        }
      }
    }
  };
  applyRiverAcceleration();
  if (s.applyDrag && traces.some((t) => t.inWater)) {
    const horizontal: Vec3 = [dynamics.linearVelocityMps[0], 0, dynamics.linearVelocityMps[2]],
      speed = Math.hypot(...horizontal),
      limited = Math.min(speed, s.maxDragSpeedMps);
    drag = mul(
      norm(horizontal),
      -(
        0.036 * s.linearDragCoefficient * limited +
        0.1296 * s.quadraticDragCoefficient * limited * limited
      ),
    );
    angular = mul(dynamics.angularVelocityRadps, -s.angularDragPerSecond);
  }
  const riverForce = mul(river, dynamics.massKg),
    dragForce = mul(drag, dynamics.massKg),
    torque = waterWorldInertiaTorque(dynamics, angular);
  const active = pontoons.some((p) => p.enabled);
  const bodyForceResult = active
    ? physics.applyBodyForceAtPoint({
        entity: dynamics.entity,
        generation: dynamics.generation,
        fixedStep: dynamics.nextFixedStep,
        forceN: add(riverForce, dragForce),
        pointM: dynamics.centerOfMassM,
      })
    : ok(undefined);
  const bodyTorqueResult = active
    ? physics.applyBodyTorque({
        entity: dynamics.entity,
        generation: dynamics.generation,
        fixedStep: dynamics.nextFixedStep,
        torqueNm: torque,
      })
    : ok(undefined);
  return ok(
    Object.freeze({
      physicsStep: dynamics.nextFixedStep,
      rootEntity: dynamics.entity,
      rootGeneration: dynamics.generation,
      dynamics,
      overlaps,
      coefficientSolve: coefficients.value,
      coefficientCache: { enabledMask: coefficientCache.enabledMask, hit: coefficientCache.hit },
      pontoons: Object.freeze(
        traces.map((t, i) =>
          Object.freeze({
            ...t,
            riverForceN: i === velocityIndex ? riverForce : zero(),
            dragForceN: i === velocityIndex ? dragForce : zero(),
          }),
        ),
      ),
      forceEvents: Object.freeze(forceEvents),
      splashWakeEvents: Object.freeze(
        traces.flatMap((pontoon, index): WaterSplashWakeEvent[] => {
          const previous = requireWaterValue(pontoons[index]).previousWaterState;
          if (!pontoon.enabled || (!pontoon.inWater && !previous?.inWater)) return [];
          const bodyGuid = pontoon.inWater ? pontoon.selectedBodyGuid : previous?.bodyGuid;
          const bodyGeneration = pontoon.inWater
            ? pontoon.selectedBodyGeneration
            : previous?.bodyGeneration;
          return [
            Object.freeze({
              sourcePhysicsStep: dynamics.nextFixedStep,
              queryTimeSeconds: input.fixedTimeSeconds,
              fixedDeltaSeconds: dt,
              rootEntity: dynamics.entity,
              rootGeneration: dynamics.generation,
              pontoonId: pontoon.pontoonId,
              ...(bodyGuid === undefined || bodyGeneration === undefined
                ? {}
                : { bodyGuid, bodyGeneration }),
              phase: pontoon.inWater ? (previous?.inWater ? 'wake' : 'entered') : 'exited',
              positionM: Object.freeze<Vec3>([...pontoon.centerM]),
              forceN: Object.freeze<Vec3>(pontoon.result.ok ? [...pontoon.buoyancyForceN] : zero()),
              contact: waterPontoonContact(pontoon, dynamics),
            }),
          ];
        }),
      ),
      riverAccelerationMps2: river,
      dragAccelerationMps2: drag,
      angularAccelerationRadps2: angular,
      angularDragTorqueNm: torque,
      bodyForceResult,
      bodyTorqueResult,
    }),
  );
}
