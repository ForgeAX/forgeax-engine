// @forgeax/engine-render - host-side light helpers (M2 / w12).
//
// Pure-function single-shot conversion helpers for the SpotLight + PointLight
// extract path. Host calls each helper once per light entity per frame; the
// shader then sees only pre-computed `cos*` / `invRangeSquared` values. The
// runtime range owner is the revision-pinned Three r184 squared window; KHR
// values remain an import/reference boundary and are not substituted here.
//
// AC anchors: requirements AC-03 (deg -> rad -> cos host two-step
// conversion) + AC-08 (a + b) (KHR quartic + range = 0 NaN protection
// boundary).
//
// Plan-strategy anchors: D-S2 (cone unit deg API + cos shader optimization
// transparent to AI users) + D-S5 (Layer 1 host-side range = 0 ->
// invRangeSquared = 1e8 protects the 0 * Infinity = NaN intermediate).

import { err, ok, R_MIN, type Result } from '@forgeax/engine-types';
import { SpawnLightInvalidBoundsError } from '../errors/ecs-validation';
import { ShadowInvalidConfigError } from '../errors/render';
import { DirectionalLight } from './directional-light';
import { DirectionalShadowFilterValue } from './directional-shadow-filter';
import { PointLightShadow } from './point-light-shadow';
import { RectAreaLight } from './rect-area-light';
import { SpotLight } from './spot-light';

export type LightValidationError = SpawnLightInvalidBoundsError | ShadowInvalidConfigError;
export type LightValidationResult = Result<void, LightValidationError>;

const RANGE_ZERO_FALLBACK_INV_R2 = 1e8;
const DEG_TO_RAD = Math.PI / 180;
const PCSS_RADIUS_MIN = 0.0001;
const PCSS_RADIUS_MAX = 0.05;
const PCSS_PENUMBRA_MIN = 1;
const PCSS_PENUMBRA_MAX = 64;

/**
 * Convert SpotLight cone half-angle (degrees) to its cosine.
 *
 * Single-shot deg -> rad -> cos conversion executed once per spot light
 * entity per frame on the host; the GPU shader sees only `cosInner` /
 * `cosOuter`. The shader uses a hard step for equal cones and smoothstep
 * for an authored penumbra.
 *
 * @param deg cone half-angle in degrees (component schema field
 *            `innerConeDeg` / `outerConeDeg`)
 * @returns `cos(deg * pi / 180)`
 */
export function degToCos(deg: number): number {
  return Math.cos(deg * DEG_TO_RAD);
}

/**
 * Convert PointLight / SpotLight `range` (meters) to `1 / range^2`.
 *
 * Three-branch fold supplies `1 / range^2` for the Three r184 finite-range
 * window `clamp(1 - (d / range)^4, 0, 1)^2`:
 *
 *   - `range = +Infinity` -> `0` (no truncation; quartic factor collapses
 *     to `1`, falloff reduces to plain `1 / d^2`).
 *   - `range = 0` -> `1e8` (host safety boundary; glTF `range: 0` is mapped
 *     to the no-cutoff `Infinity` value before this helper is called).
 *   - `range > 0` -> `1 / (range * range)` (standard quartic factor).
 *
 * @param range meters (component schema field `range`); `+Infinity` is the
 *              KHR no-truncation default
 * @returns `1 / range^2` with three-branch NaN protection
 */
export function computeInvRangeSquared(range: number): number {
  if (range === Number.POSITIVE_INFINITY) return 0;
  if (range === 0) return RANGE_ZERO_FALLBACK_INV_R2;
  return 1 / (range * range);
}

/**
 * feat-20260709 M2 / D-1: shared zero/missing-direction validate for
 * DirectionalLight + SpotLight. `direction` has no layer-2 default, so an
 * omitted direction lands the array layer-3 all-zero -- the same illegal state
 * as an explicit zero vector. SSOT for the rejection so the two lights cannot
 * drift. Returns the structured error to reject, or `null` when the direction
 * is a valid non-zero vector.
 */
export function validateDirection(
  componentName: 'DirectionalLight' | 'SpotLight',
  direction: ArrayLike<number> | undefined,
): SpawnLightInvalidBoundsError | null {
  const dir = direction;
  if (dir === undefined || ((dir[0] ?? 0) === 0 && (dir[1] ?? 0) === 0 && (dir[2] ?? 0) === 0)) {
    return new SpawnLightInvalidBoundsError(
      componentName,
      'direction',
      dir === undefined ? [0, 0, 0] : [dir[0] ?? 0, dir[1] ?? 0, dir[2] ?? 0],
    );
  }
  return null;
}

function validateDirectedLightData(
  componentName: 'DirectionalLight' | 'SpotLight',
  data: Readonly<Record<string, unknown>>,
): LightValidationResult {
  const directionError = validateDirection(
    componentName,
    data.direction as ArrayLike<number> | undefined,
  );
  if (directionError !== null) return err(directionError);
  const contactShadowLength = (data.contactShadowLength as number | undefined) ?? 0;
  if (!Number.isFinite(contactShadowLength) || contactShadowLength < 0) {
    return err(
      new ShadowInvalidConfigError(
        'contactShadowLength',
        contactShadowLength,
        { kind: 'lower-bound', value: 0, operator: '>=' },
        'a finite value >= 0 (0 disables contact shadows)',
      ),
    );
  }
  return ok(undefined);
}

/** Projection and update controls share the same admission in all light families. */
function validateShadowPolicy(
  data: Readonly<Record<string, unknown>>,
  kind: 'directional' | 'point' | 'spot',
): LightValidationResult {
  for (const field of ['shadowProjection', 'shadowBiasMode'] as const) {
    const value = (data[field] as number | undefined) ?? 0;
    if (value !== 0 && value !== 1)
      return err(
        new ShadowInvalidConfigError(field, value, { kind: 'allowed-values', values: [0, 1] }),
      );
  }
  for (const [field, fallback, min, max] of [
    ['shadowRadius', 1, 0, 3.4028234663852886e38],
    ['shadowIntensity', 1, 0, 1],
    ['shadowMapAspect', 1, Number.MIN_VALUE, 3.4028234663852886e38],
    ['shadowRevision', 0, 0, Number.MAX_SAFE_INTEGER],
    ['shadowBlurSamples', 8, 1, 64],
  ] as const) {
    const value = (data[field] as number | undefined) ?? fallback;
    if (
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      ((field === 'shadowRevision' || field === 'shadowBlurSamples') &&
        !Number.isSafeInteger(value))
    )
      return err(new ShadowInvalidConfigError(field, value, { kind: 'range', min, max }));
  }
  if (kind !== 'directional') {
    const values = kind === 'point' ? [1, 6] : [1, 6, 7, 8];
    const filter = (data.shadowFilter as number | undefined) ?? 6;
    if (!values.includes(filter))
      return err(
        new ShadowInvalidConfigError('shadowFilter', filter, { kind: 'allowed-values', values }),
      );
  }
  if (data.shadowProjection !== 1) return ok(undefined);
  if (kind === 'point') {
    const position = data.shadowPosition as ArrayLike<number> | undefined;
    if (
      position?.length !== 3 ||
      !Array.from(position).every((value) => Number.isFinite(Math.fround(value)))
    )
      return err(
        new ShadowInvalidConfigError(
          'shadowPosition',
          0,
          { kind: 'range', min: -3.4028234663852886e38, max: 3.4028234663852886e38 },
          'three finite world-space coordinates',
        ),
      );
    return ok(undefined);
  }
  const matrix = data.shadowViewProjection as ArrayLike<number> | undefined;
  if (
    matrix?.length !== 16 ||
    !Array.from(matrix).every((value) => Number.isFinite(Math.fround(value)))
  )
    return err(
      new ShadowInvalidConfigError(
        'shadowViewProjection',
        0,
        { kind: 'lower-bound', operator: '>', value: 0 },
        'a finite nonsingular reverse-Z world-to-clip matrix',
      ),
    );
  // Gaussian elimination checks rank without an absolute scale cutoff: valid
  // orthographic cameras may span very small or very large world distances.
  const rows = Float64Array.from(
    { length: 16 },
    (_, i) => matrix[(i % 4) * 4 + Math.floor(i / 4)] as number,
  );
  let valid = true;
  for (let col = 0; col < 4; col++) {
    const target = col * 4;
    let pivot = target;
    for (let row = col + 1; row < 4; row++) {
      const candidate = row * 4;
      if (Math.abs(rows[candidate + col] as number) > Math.abs(rows[pivot + col] as number))
        pivot = candidate;
    }
    if (rows[pivot + col] === 0) {
      valid = false;
      break;
    }
    for (let lane = col; lane < 4; lane++)
      [rows[pivot + lane], rows[target + lane]] = [
        rows[target + lane] as number,
        rows[pivot + lane] as number,
      ];
    for (let row = col + 1; row < 4; row++) {
      const offset = row * 4;
      const factor = (rows[offset + col] as number) / (rows[target + col] as number);
      for (let lane = col + 1; lane < 4; lane++)
        rows[offset + lane] =
          (rows[offset + lane] as number) - factor * (rows[target + lane] as number);
    }
  }
  if (
    !valid ||
    (kind === 'directional' &&
      ([3, 7, 11].some((index) => matrix[index] !== 0) || matrix[15] !== 1))
  )
    return err(
      new ShadowInvalidConfigError(
        'shadowViewProjection',
        0,
        { kind: 'lower-bound', operator: '>', value: 0 },
        kind === 'directional'
          ? 'a nonsingular orthographic reverse-Z matrix'
          : 'a nonsingular reverse-Z matrix',
      ),
    );
  return ok(undefined);
}

/** Validate directional-light payloads at the render owner boundary. */
export function validateDirectionalLightData(
  data: Readonly<Record<string, unknown>>,
): LightValidationResult {
  const directed = validateDirectedLightData('DirectionalLight', data);
  if (!directed.ok) return directed;
  if (data.castShadow !== true) return ok(undefined);

  const mapSize =
    (data.mapSize as number | undefined) ?? (DirectionalLight.fields.mapSize.default as number);
  if (!Number.isInteger(mapSize) || mapSize < 1) {
    return err(
      new ShadowInvalidConfigError('mapSize', mapSize, {
        kind: 'lower-bound',
        value: 1,
        operator: '>=',
      }),
    );
  }
  const policy = validateShadowPolicy(data, 'directional');
  if (!policy.ok) return policy;
  const cascadeCount =
    (data.cascadeCount as number | undefined) ??
    (DirectionalLight.fields.cascadeCount.default as number);
  if (cascadeCount < 1 || cascadeCount > 4 || !Number.isInteger(cascadeCount)) {
    return err(
      new ShadowInvalidConfigError('cascadeCount', cascadeCount, { kind: 'range', min: 1, max: 4 }),
    );
  }
  const splitLambda =
    (data.splitLambda as number | undefined) ??
    (DirectionalLight.fields.splitLambda.default as number);
  if (splitLambda < 0 || splitLambda > 1) {
    return err(
      new ShadowInvalidConfigError('splitLambda', splitLambda, { kind: 'range', min: 0, max: 1 }),
    );
  }
  const cascadeBlend = (data.cascadeBlend as number | undefined) ?? 0.2;
  if (cascadeBlend < 0 || cascadeBlend > 0.5) {
    return err(
      new ShadowInvalidConfigError('cascadeBlend', cascadeBlend, {
        kind: 'range',
        min: 0,
        max: 0.5,
      }),
    );
  }
  const shadowDistance =
    (data.shadowDistance as number | undefined) ??
    (DirectionalLight.fields.shadowDistance.default as number);
  if (shadowDistance <= 0) {
    return err(
      new ShadowInvalidConfigError('shadowDistance', shadowDistance, {
        kind: 'lower-bound',
        value: 0,
        operator: '>',
      }),
    );
  }
  const shadowFilter =
    (data.shadowFilter as number | undefined) ??
    (DirectionalLight.fields.shadowFilter.default as number);
  const allowedFilters = Object.values(DirectionalShadowFilterValue);
  if (!Number.isFinite(shadowFilter) || !allowedFilters.includes(shadowFilter as never)) {
    return err(
      new ShadowInvalidConfigError(
        'shadowFilter',
        shadowFilter,
        { kind: 'allowed-values', values: allowedFilters },
        'one of [pcf1, pcf3, pcf5, pcssMedium, pcssHigh, pcfVogel, pcfSoft, variance]',
      ),
    );
  }
  if (
    shadowFilter === DirectionalShadowFilterValue.pcssMedium ||
    shadowFilter === DirectionalShadowFilterValue.pcssHigh
  ) {
    const shadowAngularRadius = (data.shadowAngularRadius as number | undefined) ?? 0.00465;
    if (!Number.isFinite(shadowAngularRadius)) {
      return err(
        new ShadowInvalidConfigError('shadowAngularRadius', shadowAngularRadius, {
          kind: 'range',
          min: PCSS_RADIUS_MIN,
          max: PCSS_RADIUS_MAX,
        }),
      );
    }
    // ECS stores this field as f32; both authored endpoints round outward.
    // Accept their stored representations, but not the adjacent out-of-range f32.
    if (
      shadowAngularRadius < Math.fround(PCSS_RADIUS_MIN) ||
      shadowAngularRadius > Math.fround(PCSS_RADIUS_MAX)
    ) {
      return err(
        new ShadowInvalidConfigError('shadowAngularRadius', shadowAngularRadius, {
          kind: 'range',
          min: PCSS_RADIUS_MIN,
          max: PCSS_RADIUS_MAX,
        }),
      );
    }
    const maxPenumbraTexels = (data.maxPenumbraTexels as number | undefined) ?? 32;
    if (
      !Number.isFinite(maxPenumbraTexels) ||
      !Number.isInteger(maxPenumbraTexels) ||
      maxPenumbraTexels < PCSS_PENUMBRA_MIN ||
      maxPenumbraTexels > PCSS_PENUMBRA_MAX
    ) {
      return err(
        new ShadowInvalidConfigError(
          'maxPenumbraTexels',
          maxPenumbraTexels,
          { kind: 'range', min: PCSS_PENUMBRA_MIN, max: PCSS_PENUMBRA_MAX },
          'a finite integer in [1, 64]',
        ),
      );
    }
  }
  return ok(undefined);
}

/** Three light.distance selects the shadow far plane; unlimited lights use camera.far. */
export function resolvePunctualShadowFarPlane(
  range: number,
  nearPlane: number,
  fallback: number,
): Result<number, ShadowInvalidConfigError> {
  if (!Number.isFinite(nearPlane) || nearPlane <= 0)
    return err(
      new ShadowInvalidConfigError(
        'nearPlane',
        nearPlane,
        { kind: 'lower-bound', value: 0, operator: '>' },
        'a finite value > 0',
      ),
    );
  const farPlane = Number.isFinite(range) && range > 0 ? range : fallback;
  if (!Number.isFinite(farPlane) || farPlane <= nearPlane)
    return err(
      new ShadowInvalidConfigError(
        'farPlane',
        farPlane,
        { kind: 'lower-bound', value: nearPlane, operator: '>' },
        'a finite far plane beyond nearPlane; reduce nearPlane for short-range lights',
      ),
    );
  return ok(farPlane);
}

function validatePunctualShadowData(
  data: Readonly<Record<string, unknown>>,
  component: typeof PointLightShadow | typeof SpotLight,
  range: number,
): LightValidationResult {
  const policy = validateShadowPolicy(data, component === PointLightShadow ? 'point' : 'spot');
  if (!policy.ok) return policy;
  const mapSize =
    (data.mapSize as number | undefined) ?? (component.fields.mapSize.default as number);
  if (!Number.isInteger(mapSize) || mapSize < 1)
    return err(
      new ShadowInvalidConfigError('mapSize', mapSize, {
        kind: 'lower-bound',
        value: 1,
        operator: '>=',
      }),
    );
  const nearPlane =
    (data.nearPlane as number | undefined) ?? (component.fields.nearPlane.default as number);
  const farPlane =
    (data.farPlane as number | undefined) ?? (component.fields.farPlane.default as number);
  const projection = resolvePunctualShadowFarPlane(range, nearPlane, farPlane);
  if (!projection.ok) return projection;
  const pcfKernelSize = (data.pcfKernelSize as number | undefined) ?? 3;
  if (!Number.isFinite(pcfKernelSize) || pcfKernelSize < 1) {
    return err(
      new ShadowInvalidConfigError(
        'pcfKernelSize',
        pcfKernelSize,
        { kind: 'lower-bound', operator: '>=', value: 1 },
        'a finite footprint diameter >= 1',
      ),
    );
  }
  return ok(undefined);
}

/** Validate spot-light payloads at the render owner boundary. */
export function validateSpotLightData(
  data: Readonly<Record<string, unknown>>,
): LightValidationResult {
  const directed = validateDirectedLightData('SpotLight', data);
  if (!directed.ok) return directed;

  const range = (data.range as number | undefined) ?? (SpotLight.fields.range.default as number);
  if (typeof range !== 'number' || Number.isNaN(range) || range < 0) {
    return err(new SpawnLightInvalidBoundsError('SpotLight', 'range', range));
  }
  const innerConeDeg =
    (data.innerConeDeg as number | undefined) ?? (SpotLight.fields.innerConeDeg.default as number);
  const outerConeDeg =
    (data.outerConeDeg as number | undefined) ?? (SpotLight.fields.outerConeDeg.default as number);
  if (!Number.isFinite(outerConeDeg) || outerConeDeg <= 0 || outerConeDeg > 90) {
    return err(new SpawnLightInvalidBoundsError('SpotLight', 'outerNinety', outerConeDeg));
  }
  if (!Number.isFinite(innerConeDeg) || innerConeDeg < 0 || outerConeDeg < innerConeDeg) {
    return err(new SpawnLightInvalidBoundsError('SpotLight', 'innerOuter', outerConeDeg));
  }
  if (data.castShadow !== true) return ok(undefined);
  const shadow = validatePunctualShadowData(data, SpotLight, range);
  if (!shadow.ok) return shadow;
  return ok(undefined);
}

/** Validate point-light shadow payloads at the render owner boundary. */
export function validatePointLightShadowData(
  data: Readonly<Record<string, unknown>>,
): LightValidationResult {
  return validatePunctualShadowData(data, PointLightShadow, Infinity);
}

/** Validate rectangular area-light authoring facts before renderer admission. */
export function validateRectAreaLightData(
  data: Readonly<Record<string, unknown>>,
): LightValidationResult {
  const intensity = (data.intensity as number | undefined) ?? 1;
  if (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0) {
    return err(new SpawnLightInvalidBoundsError('RectAreaLight', 'intensity', intensity));
  }
  const color = (data.color as ArrayLike<number> | undefined) ?? [1, 1, 1];
  if (
    color.length !== 3 ||
    Array.from(color).some(
      (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0,
    )
  ) {
    return err(new SpawnLightInvalidBoundsError('RectAreaLight', 'color', Array.from(color)));
  }
  for (const field of ['width', 'height', 'range'] as const) {
    const value =
      (data[field] as number | undefined) ?? (RectAreaLight.fields[field].default as number);
    if (
      typeof value !== 'number' ||
      Number.isNaN(value) ||
      value <= 0 ||
      (field !== 'range' && !Number.isFinite(value))
    ) {
      return err(new SpawnLightInvalidBoundsError('RectAreaLight', field, value));
    }
  }
  return ok(undefined);
}

/** Validate the fixed 27-value SH payload and minimum finite radius. */
export function validateLightProbeData(
  data: Readonly<Record<string, unknown>>,
): LightValidationResult {
  const irradiance = data.irradiance as ArrayLike<number> | undefined;
  if (
    irradiance === undefined ||
    irradiance.length !== 27 ||
    Array.from(irradiance).some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    return err(
      new SpawnLightInvalidBoundsError(
        'LightProbe',
        'irradiance',
        irradiance === undefined ? [] : Array.from(irradiance),
      ),
    );
  }
  const radius = (data.radius as number | undefined) ?? R_MIN;
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < R_MIN) {
    return err(new SpawnLightInvalidBoundsError('LightProbe', 'radius', radius));
  }
  return ok(undefined);
}
