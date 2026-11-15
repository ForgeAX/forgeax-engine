import {
  PHYSICS_SOLVER_MAX_PAYLOAD_BYTES,
  type PhysicsBodyDynamics,
  PhysicsFixedError,
  type PhysicsFixedErrorCode,
  type PhysicsSensorOverlap,
  type PhysicsSensorOverlaps,
  type PhysicsSolverOutput,
  type PhysicsSolverTask,
} from '@forgeax/engine-physics';
import { err, ok, type Result, sha256, WATER_BUOYANCY_DEFAULTS } from '@forgeax/engine-types';
import type { WaterBuoyancySolverSnapshot } from './async-buoyancy.js';
import {
  type WaterBuoyancyError,
  type WaterBuoyancyErrorDetail,
  type WaterBuoyancyFailure,
  type WaterBuoyancyStep,
  type WaterPontoonCoefficients,
  type WaterSplashWakeEvent,
  waterPontoonContact,
} from './buoyancy.js';
import type { WaterError, WaterErrorCode, WaterQueryField, WaterQueryResult } from './contracts.js';
import {
  isWaterResidualQueryError,
  isWaterResidualQuerySample,
  isWaterResidualQuerySource,
} from './query-residual.js';
import { validateWaterRuntimeAsset, validateWaterRuntimeBody } from './validate.js';

const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true });
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown): value is number =>
  finite(value) && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const oneOf = (value: unknown, values: readonly string[]): boolean =>
  typeof value === 'string' && values.includes(value);
const vector = (value: unknown, length = 3): boolean =>
  Array.isArray(value) && value.length === length && value.every(finite);
const numbers = (row: Record<string, unknown>, fields: readonly string[]): boolean =>
  fields.every((field) => finite(row[field]));
const vectors = (row: Record<string, unknown>, fields: readonly string[]): boolean =>
  fields.every((field) => vector(row[field]));
const optional = (
  row: Record<string, unknown>,
  key: string,
  check: (value: unknown) => boolean,
): boolean => row[key] === undefined || check(row[key]);
const array = (
  value: unknown,
  check: (value: unknown) => boolean,
  maximum = Number.MAX_SAFE_INTEGER,
): value is unknown[] => Array.isArray(value) && value.length <= maximum && value.every(check);
const invalid = (entity: number, reason: string) =>
  err(new PhysicsFixedError('fixed-input-invalid', { entity, reason }));

function finiteJson(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((child) => finiteJson(child, depth + 1));
  const row = record(value);
  return !row || Object.values(row).every((child) => finiteJson(child, depth + 1));
}

function parse(bytes: Uint8Array, entity: number): Result<unknown, PhysicsFixedError> {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > PHYSICS_SOLVER_MAX_PAYLOAD_BYTES
  )
    return invalid(entity, 'Water solver payload exceeds the Physics byte capacity or is empty');
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return finiteJson(value)
      ? ok(value)
      : invalid(entity, 'Water solver payload contains nonfinite numbers or excessive nesting');
  } catch {
    return invalid(entity, 'Water solver payload must be valid UTF-8 JSON');
  }
}

function dynamics(value: unknown): value is PhysicsBodyDynamics {
  const row = record(value);
  return (
    !!row &&
    ['entity', 'generation', 'completedStep', 'nextFixedStep'].every((key) => integer(row[key])) &&
    finite(row.massKg) &&
    vectors(row, [
      'positionM',
      'centerOfMassM',
      'localCenterOfMassM',
      'linearVelocityMps',
      'angularVelocityRadps',
      'principalInertiaKgM2',
    ]) &&
    vector(row.rotation, 4) &&
    vector(row.principalInertiaLocalRotation, 4)
  );
}
function overlap(value: unknown): value is PhysicsSensorOverlap {
  const row = record(value);
  return (
    !!row &&
    text(row.colliderId) &&
    ['entity', 'generation', 'bodyGeneration', 'collisionGroups'].every((key) => integer(row[key]))
  );
}
function overlaps(value: unknown): value is PhysicsSensorOverlaps {
  const row = record(value);
  return (
    !!row &&
    ['rootEntity', 'rootGeneration', 'completedStep'].every((key) => integer(row[key])) &&
    ['current', 'entered', 'exited', 'stale'].every((key) => array(row[key], overlap))
  );
}
function coefficientPoint(value: unknown): boolean {
  const row = record(value);
  return (
    !!row &&
    text(row.id) &&
    typeof row.enabled === 'boolean' &&
    oneOf(row.anchor, ['relative', 'socket']) &&
    oneOf(row.coefficientSpace, ['root-local', 'socket-parent-local']) &&
    vectors(row, ['coefficientPositionM', 'massFramePositionM'])
  );
}
function coefficients(value: unknown): value is WaterPontoonCoefficients {
  const row = record(value);
  return (
    !!row &&
    typeof row.sourceSuccess === 'boolean' &&
    typeof row.centerPontoonsOnCOM === 'boolean' &&
    oneOf(row.sourceStatus, ['computed', 'not-invoked']) &&
    oneOf(row.branch, [
      'unselected',
      'inactive',
      'single',
      'pair',
      'axis-x',
      'axis-z',
      'general',
    ]) &&
    vector(row.centerOfMassM) &&
    array(row.points, coefficientPoint, 32) &&
    array(row.coefficients, finite, 32) &&
    row.coefficients.length === row.points.length &&
    array(
      row.diagnostics,
      (value) => {
        const detail = record(value);
        return (
          !!detail &&
          detail.code === 'sprung-axis-singular' &&
          oneOf(detail.axis, ['x', 'z']) &&
          finite(detail.determinantM2) &&
          detail.thresholdM2 === 1e-14
        );
      },
      32,
    )
  );
}

function coefficientFailureDetail(row: Record<string, unknown>): boolean {
  switch (row.reason) {
    case 'active-count':
      return integer(row.count);
    case 'non-finite-input':
      return (
        oneOf(row.field, ['center-of-mass', 'coefficient-position']) &&
        optional(row, 'pontoonIndex', integer)
      );
    case 'singular-general':
      return finite(row.determinantM4) && row.thresholdM4 === 1e-18;
    case 'stored-fraction-invalid':
      return array(row.weights, finite, 32);
    case 'cache-layout-mismatch':
      return integer(row.expectedCount) && integer(row.actualCount);
    default:
      return false;
  }
}

function candidateFailureDetail(row: Record<string, unknown>): boolean {
  return (
    oneOf(row.reason, ['stale-collider', 'water-publication']) &&
    overlap(row.overlap) &&
    optional(row, 'bodyGuid', text) &&
    optional(row, 'bodyGeneration', integer) &&
    optional(row, 'collisionRevision', integer)
  );
}

function velocitySettingFailureDetail(row: Record<string, unknown>): boolean {
  return (
    row.reason === 'velocity-pontoon-index' &&
    finite(row.velocityPontoonIndex) &&
    Number.isInteger(row.velocityPontoonIndex) &&
    integer(row.configuredCount)
  );
}

function buoyancyDetail(value: unknown): value is WaterBuoyancyErrorDetail {
  const row = record(value);
  if (!row) return false;
  switch (row.kind) {
    case 'coefficient':
      return coefficientFailureDetail(row);
    case 'root':
      return row.reason === 'invalid-root-mass' && integer(row.entity) && finite(row.massKg);
    case 'step':
      return (
        row.reason === 'overlap-step-mismatch' &&
        integer(row.dynamicsCompletedStep) &&
        integer(row.overlapCompletedStep)
      );
    case 'input':
      return row.reason === 'time-settings-generation-geometry';
    case 'settings':
      return velocitySettingFailureDetail(row);
    case 'physics':
      return (
        oneOf(row.reason, ['backend-missing', 'dynamics-capability', 'force-capability']) &&
        integer(row.entity)
      );
    case 'configuration':
      return (
        oneOf(row.reason, [
          'retired',
          'cardinality',
          'enabled-mask',
          'root-transform-missing',
          'root-transform-invalid',
        ]) && integer(row.entity)
      );
    case 'socket':
      return (
        oneOf(row.reason, ['not-descendant', 'stale-or-cyclic', 'detached', 'transform-missing']) &&
        integer(row.socket)
      );
    case 'candidate':
      return candidateFailureDetail(row);
    case 'pontoon':
      return row.reason === 'disabled';
    default:
      return false;
  }
}

const physicsCodes = {
  'fixed-body-missing': true,
  'fixed-input-invalid': true,
  'fixed-generation-stale': true,
  'fixed-step-stale': true,
  'fixed-operation-unavailable': true,
  'fixed-backend-failed': true,
} satisfies Record<PhysicsFixedErrorCode, true>;
const waterCodes = {
  'invalid-source': true,
  'missing-dependency': true,
  'stale-generation': true,
  'zone-unbound': true,
  'wave-upload-capacity-exceeded': true,
  'body-unregistered': true,
  'null-spline-metadata': true,
  'invalid-query-flags': true,
  'query-data-unavailable': true,
} satisfies Record<WaterErrorCode, true>;
const buoyancyCodes = {
  'buoyancy-config-invalid': true,
  'buoyancy-physics-unsupported': true,
  'buoyancy-candidate-rejected': true,
} satisfies Record<WaterBuoyancyError['code'], true>;
function failure(value: unknown): WaterBuoyancyFailure | undefined {
  const row = record(value);
  if (!row || !text(row.code) || !text(row.expected) || !text(row.hint)) return undefined;
  if (Object.hasOwn(physicsCodes, row.code)) {
    const detail = record(row.detail);
    if (
      !detail ||
      !integer(detail.entity) ||
      !text(detail.reason) ||
      !optional(detail, 'expected', finite) ||
      !optional(detail, 'actual', finite) ||
      !optional(
        detail,
        'recovery',
        (value) =>
          value === 'rebuild-required' ||
          (value === 'await-native-sync' && row.code === 'fixed-body-missing'),
      )
    )
      return undefined;
    const restored = new PhysicsFixedError(
      row.code as PhysicsFixedErrorCode,
      detail as PhysicsFixedError['detail'],
    );
    return row.expected === restored.expected && row.hint === restored.hint ? restored : undefined;
  }
  if (Object.hasOwn(waterCodes, row.code)) return row as WaterError;
  if (
    !Object.hasOwn(buoyancyCodes, row.code) ||
    !buoyancyDetail(row.detail) ||
    !optional(row, 'coefficientSolve', coefficients)
  )
    return undefined;
  return row as WaterBuoyancyError;
}
function restoreResult<T>(
  value: unknown,
  valid: (value: unknown) => value is T,
): Result<T, WaterBuoyancyFailure> | undefined {
  const row = record(value);
  if (!row || Object.keys(row).some((key) => !['ok', 'value', 'error'].includes(key)))
    return undefined;
  if (row.ok === true && row.error === undefined && valid(row.value)) return ok(row.value);
  const error = row.ok === false && row.value === undefined ? failure(row.error) : undefined;
  return error ? err(error) : undefined;
}
const nothing = (value: unknown): value is undefined => value === undefined;
function spline(value: unknown): boolean {
  const row = record(value);
  return !!row && numbers(row, ['key', 'speedMps']) && vectors(row, ['positionM', 'tangent']);
}
function query(value: unknown): value is WaterQueryResult {
  const row = record(value),
    valid = row && record(row.valid);
  const fields = {
    location: true,
    normal: true,
    depth: true,
    immersion: true,
    velocity: true,
    waves: true,
  } satisfies Record<WaterQueryField, true>;
  if (
    !row ||
    !valid ||
    Object.keys(valid).length !== 1 ||
    !array(
      valid.waterQueryFields,
      (field) => typeof field === 'string' && Object.hasOwn(fields, field),
      6,
    ) ||
    new Set(valid.waterQueryFields).size !== valid.waterQueryFields.length ||
    !text(row.bodyGuid) ||
    !integer(row.bodyGeneration) ||
    !integer(row.adjustedFlags) ||
    typeof row.excluded !== 'boolean' ||
    !oneOf(row.source, ['plane', 'terrain', 'spline', 'baked', 'exclusion']) ||
    !['locationM', 'surfaceM', 'normalYUp', 'planeNormalYUp', 'velocityMPerSec'].every((key) =>
      optional(row, key, vector),
    ) ||
    !['depthM', 'immersionM', 'splineKey'].every((key) => optional(row, key, finite)) ||
    !optional(row, 'localResidual', (value) => {
      const residual = record(value);
      if (
        !residual ||
        Object.keys(residual).some((key) => !['ok', 'value', 'error'].includes(key)) ||
        row.excluded
      )
        return false;
      if (
        residual.ok === true &&
        residual.error === undefined &&
        isWaterResidualQuerySample(residual.value) &&
        residual.value.bodyGuid === row.bodyGuid &&
        residual.value.bodyGeneration === row.bodyGeneration
      ) {
        row.localResidual = ok(residual.value);
        return true;
      }
      if (
        residual.ok === false &&
        residual.value === undefined &&
        isWaterResidualQueryError(residual.error)
      ) {
        row.localResidual = err(residual.error);
        return true;
      }
      return false;
    }) ||
    !optional(row, 'terrainSample', (value) => {
      const sample = record(value);
      return (
        !!sample &&
        finite(sample.heightM) &&
        text(sample.providerGuid) &&
        ['providerVersion', 'zoneGeneration', 'groundGeneration'].every((key) =>
          integer(sample[key]),
        )
      );
    }) ||
    !optional(row, 'waveInfo', (value) => {
      const wave = record(value);
      return (
        !!wave &&
        numbers(wave, ['timeSeconds', 'heightM', 'maxHeightM', 'attenuation']) &&
        vector(wave.normalYUp)
      );
    })
  )
    return false;
  row.valid = new Set(valid.waterQueryFields as WaterQueryField[]);
  return true;
}
function candidate(value: unknown): boolean {
  const row = record(value),
    result = row && restoreResult(row.result, query);
  if (
    !row ||
    !result ||
    !overlap(row.overlap) ||
    typeof row.isInWater !== 'boolean' ||
    !optional(row, 'bodyGuid', text) ||
    !optional(row, 'bodyGeneration', integer) ||
    !optional(row, 'splineSample', spline) ||
    (result.ok &&
      (result.value.bodyGuid !== row.bodyGuid ||
        result.value.bodyGeneration !== row.bodyGeneration))
  )
    return false;
  row.result = result;
  return true;
}
function pontoonTrace(value: unknown): boolean {
  const row = record(value),
    result = row && restoreResult(row.result, nothing);
  if (
    !row ||
    !result ||
    !['physicsStep', 'completedOverlapStep', 'rootEntity', 'rootGeneration', 'queryFlags'].every(
      (key) => integer(row[key]),
    ) ||
    !text(row.pontoonId) ||
    typeof row.enabled !== 'boolean' ||
    typeof row.inWater !== 'boolean' ||
    !oneOf(row.anchor, ['relative', 'socket']) ||
    !oneOf(row.coefficientSpace, ['root-local', 'socket-parent-local']) ||
    !numbers(row, [
      'fixedDeltaSeconds',
      'fixedTimeSeconds',
      'radiusM',
      'immersionM',
      'volumeM3',
      'sprungMassKg',
      'coefficient',
      'rampCoefficientNPerM3',
      'dampingN',
      'preCapForceN',
      'postCapForceN',
    ]) ||
    !vectors(row, [
      'coefficientPositionM',
      'massFramePositionM',
      'centerM',
      'queryPointM',
      'buoyancyForceN',
      'riverForceN',
      'dragForceN',
      'applicationPointM',
      'torqueNm',
    ]) ||
    !optional(row, 'selectedBodyGuid', text) ||
    !optional(row, 'selectedBodyGeneration', integer) ||
    !optional(row, 'waterYM', finite) ||
    !optional(row, 'splineSample', spline) ||
    !array(row.candidateRoster, candidate)
  )
    return false;
  row.result = result;
  return true;
}
function contactMatches(value: unknown, expected: WaterSplashWakeEvent['contact']): boolean {
  const row = record(value);
  if (!row || row.kind !== expected.kind) return false;
  if (expected.kind === 'none')
    return Object.keys(row).length === 2 && row.reason === expected.reason;
  return (
    Object.keys(row).length === 4 &&
    row.radiusM === expected.radiusM &&
    Array.isArray(row.positionM) &&
    row.positionM.length === 3 &&
    row.positionM.every((value, index) => value === expected.positionM[index]) &&
    Array.isArray(row.relativeVelocityMps) &&
    row.relativeVelocityMps.length === 3 &&
    row.relativeVelocityMps.every((value, index) => value === expected.relativeVelocityMps[index])
  );
}

function matchesStepOwnerClosure(admitted: WaterBuoyancyStep): boolean {
  if (
    new Set(admitted.pontoons.map((point) => point.pontoonId)).size !== admitted.pontoons.length ||
    new Set(admitted.splashWakeEvents.map((event) => event.pontoonId)).size !==
      admitted.splashWakeEvents.length ||
    admitted.pontoons.some(
      (point) =>
        point.rootEntity !== admitted.rootEntity ||
        point.rootGeneration !== admitted.rootGeneration ||
        point.physicsStep !== admitted.physicsStep ||
        point.completedOverlapStep !== admitted.dynamics.completedStep ||
        point.candidateRoster.some(
          (candidate) =>
            candidate.result.ok &&
            candidate.result.value.localResidual?.ok === true &&
            candidate.result.value.localResidual.value.queryPhysicsStep !==
              admitted.dynamics.completedStep,
        ),
    ) ||
    admitted.forceEvents.some(
      (event) =>
        event.rootEntity !== admitted.rootEntity ||
        event.rootGeneration !== admitted.rootGeneration ||
        event.physicsStep !== admitted.physicsStep,
    )
  )
    return false;
  for (const event of admitted.splashWakeEvents) {
    const point = admitted.pontoons.find((point) => point.pontoonId === event.pontoonId);
    if (
      point === undefined ||
      !point.enabled ||
      event.rootEntity !== admitted.rootEntity ||
      event.rootGeneration !== admitted.rootGeneration ||
      event.sourcePhysicsStep !== admitted.physicsStep ||
      event.queryTimeSeconds !== point.fixedTimeSeconds ||
      event.fixedDeltaSeconds !== point.fixedDeltaSeconds ||
      (event.bodyGuid === undefined) !== (event.bodyGeneration === undefined) ||
      (point.inWater &&
        (event.bodyGuid !== point.selectedBodyGuid ||
          event.bodyGeneration !== point.selectedBodyGeneration)) ||
      (event.phase === 'exited') === point.inWater ||
      event.positionM.some((value, index) => value !== point.centerM[index]) ||
      !contactMatches(event.contact, waterPontoonContact(point, admitted.dynamics))
    )
      return false;
  }
  return true;
}

function step(value: unknown): value is WaterBuoyancyStep {
  const row = record(value),
    cache = row && record(row.coefficientCache);
  const force = row && restoreResult(row.bodyForceResult, nothing),
    torque = row && restoreResult(row.bodyTorqueResult, nothing);
  const admitStepShape = (): boolean =>
    !(
      !row ||
      !cache ||
      !force ||
      !torque ||
      !['physicsStep', 'rootEntity', 'rootGeneration'].every((key) => integer(row[key])) ||
      !dynamics(row.dynamics) ||
      !overlaps(row.overlaps) ||
      !coefficients(row.coefficientSolve) ||
      !integer(cache.enabledMask) ||
      cache.enabledMask > 0xffff_ffff ||
      typeof cache.hit !== 'boolean' ||
      !array(row.pontoons, pontoonTrace, 32) ||
      row.pontoons.length < 1 ||
      row.pontoons.length !== row.coefficientSolve.points.length ||
      row.physicsStep !== row.dynamics.nextFixedStep ||
      row.rootEntity !== row.dynamics.entity ||
      row.rootGeneration !== row.dynamics.generation ||
      !vectors(row, [
        'riverAccelerationMps2',
        'dragAccelerationMps2',
        'angularAccelerationRadps2',
        'angularDragTorqueNm',
      ]) ||
      !array(
        row.forceEvents,
        (value) => {
          const event = record(value);
          return (
            !!event &&
            ['physicsStep', 'rootEntity', 'rootGeneration', 'bodyGeneration'].every((key) =>
              integer(event[key]),
            ) &&
            text(event.pontoonId) &&
            text(event.bodyGuid) &&
            vectors(event, ['positionM', 'forceN', 'torqueNm'])
          );
        },
        32,
      ) ||
      !array(
        row.splashWakeEvents,
        (value) => {
          const event = record(value);
          return (
            !!event &&
            ['sourcePhysicsStep', 'rootEntity', 'rootGeneration'].every((key) =>
              integer(event[key]),
            ) &&
            text(event.pontoonId) &&
            oneOf(event.phase, ['entered', 'exited', 'wake']) &&
            optional(event, 'bodyGuid', text) &&
            optional(event, 'bodyGeneration', integer) &&
            numbers(event, ['queryTimeSeconds', 'fixedDeltaSeconds']) &&
            vectors(event, ['positionM', 'forceN'])
          );
        },
        32,
      )
    );
  if (!admitStepShape() || row === undefined || !force || !torque) return false;
  const admitted = row as unknown as WaterBuoyancyStep;
  if (!matchesStepOwnerClosure(admitted)) return false;
  row.splashWakeEvents = Object.freeze(
    admitted.splashWakeEvents.map((event) =>
      Object.freeze({
        ...event,
        positionM: Object.freeze(event.positionM),
        forceN: Object.freeze(event.forceN),
        contact:
          event.contact.kind === 'none'
            ? Object.freeze(event.contact)
            : Object.freeze({
                ...event.contact,
                positionM: Object.freeze(event.contact.positionM),
                relativeVelocityMps: Object.freeze(event.contact.relativeVelocityMps),
              }),
      }),
    ),
  );
  row.bodyForceResult = force;
  row.bodyTorqueResult = torque;
  return true;
}

function snapshot(value: unknown): value is WaterBuoyancySolverSnapshot {
  const row = record(value),
    resolution = row && record(row.coefficientResolution);
  const admitSnapshotHeader = (): boolean =>
    !(
      !row ||
      Object.keys(row).some(
        (key) =>
          ![
            'schema',
            'nativePhysicsTimeSeconds',
            'sourceDynamics',
            'overlaps',
            'pontoons',
            'coefficientResolution',
            'settings',
            'bodies',
          ].includes(key),
      ) ||
      row.schema !== 'forgeax-water-solver/3' ||
      !(row.nativePhysicsTimeSeconds === null || finite(row.nativePhysicsTimeSeconds)) ||
      !dynamics(row.sourceDynamics) ||
      !overlaps(row.overlaps) ||
      !resolution ||
      !integer(resolution.enabledMask) ||
      resolution.enabledMask > 0xffff_ffff ||
      typeof resolution.hit !== 'boolean' ||
      !array(
        row.pontoons,
        (value) => {
          const point = record(value),
            previous = point && record(point.previousWaterState);
          return (
            !!point &&
            text(point.id) &&
            finite(point.radiusM) &&
            point.radiusM > 0 &&
            typeof point.enabled === 'boolean' &&
            oneOf(point.anchor, ['relative', 'socket']) &&
            vectors(point, ['centerM', 'coefficientPositionM']) &&
            (point.previousWaterState === undefined ||
              (!!previous &&
                typeof previous.inWater === 'boolean' &&
                optional(previous, 'bodyGuid', text) &&
                optional(previous, 'bodyGeneration', integer)))
          );
        },
        32,
      ) ||
      row.pontoons.length < 1
    );
  if (
    !admitSnapshotHeader() ||
    !row ||
    !resolution ||
    !Array.isArray(row.pontoons) ||
    !overlaps(row.overlaps)
  )
    return false;
  const result = restoreResult(resolution.result, coefficients),
    settings = record(row.settings);
  if (
    !result ||
    (result.ok
      ? result.value.points.length !== row.pontoons.length
      : !Object.hasOwn(buoyancyCodes, result.error.code)) ||
    !settings ||
    Object.keys(settings).length !== Object.keys(WATER_BUOYANCY_DEFAULTS).length ||
    !Object.entries(WATER_BUOYANCY_DEFAULTS).every(([key, fallback]) =>
      typeof fallback === 'boolean' ? typeof settings[key] === 'boolean' : finite(settings[key]),
    ) ||
    !array(
      row.bodies,
      (value) => {
        const capture = record(value),
          body = capture && record(capture.body),
          binding = body && record(body.binding);
        const admitsSnapshotBody = (): boolean =>
          !(
            !capture ||
            !integer(capture.entity) ||
            !integer(capture.groundGeneration) ||
            !array(capture.terrainEntities, integer) ||
            !optional(capture, 'localResidual', isWaterResidualQuerySource) ||
            !body ||
            !binding ||
            !text(body.guid) ||
            !integer(body.sceneGeneration) ||
            !vector(body.worldMatrixM, 16) ||
            !array(body.exclusionVolumes, () => false, 0) ||
            !(
              (binding.kind === 'bound' &&
                text(binding.zoneGuid) &&
                integer(binding.zoneGeneration) &&
                vector(binding.worldMatrixM, 16)) ||
              (binding.kind === 'zone-unbound' &&
                binding.retryOnCatalogChange === true &&
                optional(binding, 'requestedGuid', text))
            )
          );
        if (!admitsSnapshotBody() || capture === undefined || body === undefined) return false;
        const checked = validateWaterRuntimeBody(body.asset);
        const residual = capture.localResidual;
        if (
          isWaterResidualQuerySource(residual) &&
          (residual.binding.bodyGuid !== body.guid ||
            residual.binding.bodyGeneration !== body.sceneGeneration ||
            row.nativePhysicsTimeSeconds === null ||
            (residual.field &&
              (residual.field.timeSeconds > Number(row.nativePhysicsTimeSeconds) + 1e-7 ||
                (residual.field.sourcePhysicsStep !== null &&
                  residual.field.sourcePhysicsStep >
                    Number(record(row.sourceDynamics)?.completedStep)))))
        )
          return false;
        return (
          checked.ok &&
          array(body.dependencies, (value) => {
            const dependency = record(value);
            if (
              !dependency ||
              !text(dependency.guid) ||
              dependency.kind !== 'water-wave-set' ||
              dependency.field !== 'waveSetGuid' ||
              !oneOf(dependency.status, [
                'valid',
                'pending',
                'unavailable',
                'invalid-kind',
                'failed',
              ])
            )
              return false;
            if (dependency.status !== 'valid') return true;
            const wave = validateWaterRuntimeAsset(dependency.payload);
            return wave.ok && wave.value.kind === 'water-wave-set';
          })
        );
      },
      row.overlaps.current.length,
    )
  )
    return false;
  resolution.result = result;
  return true;
}

export function decodeWaterSolverSnapshot(
  task: PhysicsSolverTask,
): Result<WaterBuoyancySolverSnapshot, PhysicsFixedError> {
  const parsed = parse(task.payload, task.entity);
  if (!parsed.ok) return parsed;
  if (sha256(decoder.decode(task.payload)) !== task.snapshotHash)
    return invalid(task.entity, 'Water snapshot digest mismatch');
  try {
    return snapshot(parsed.value)
      ? ok(parsed.value)
      : invalid(task.entity, 'Water solver Snapshot/3 shape is invalid');
  } catch {
    return invalid(task.entity, 'Water solver Snapshot/3 source admission failed');
  }
}

export function encodeWaterSolverResult(
  result: Result<WaterBuoyancyStep, WaterBuoyancyFailure>,
  entity: number,
): Result<Uint8Array, PhysicsFixedError> {
  try {
    const bytes = encoder.encode(
      JSON.stringify({ schema: 'forgeax-water-solver-output/2', result }, (key, value: unknown) => {
        if (typeof value === 'number' && !Number.isFinite(value))
          throw new RangeError('nonfinite Water output');
        if (key === 'valid' && value && typeof value === 'object' && 'values' in value)
          return { waterQueryFields: Array.from(value as ReadonlySet<WaterQueryField>) };
        if (value instanceof PhysicsFixedError)
          return {
            code: value.code,
            detail: value.detail,
            expected: value.expected,
            hint: value.hint,
            message: value.message,
          };
        return value;
      }),
    );
    return bytes.byteLength <= PHYSICS_SOLVER_MAX_PAYLOAD_BYTES
      ? ok(bytes)
      : invalid(entity, 'Water solver output exceeds the Physics byte capacity');
  } catch {
    return invalid(entity, 'Water solver output must contain finite serializable data');
  }
}

export function decodeWaterSolverOutput(
  output: PhysicsSolverOutput,
): Result<WaterBuoyancyStep, WaterBuoyancyFailure> {
  if (!output.result.ok) return output.result;
  const parsed = parse(output.result.value, output.entity);
  if (!parsed.ok) return parsed;
  const envelope = record(parsed.value);
  if (
    !envelope ||
    envelope.schema !== 'forgeax-water-solver-output/2' ||
    Object.keys(envelope).some((key) => !['schema', 'result'].includes(key))
  )
    return invalid(
      output.entity,
      'Water solver output requires version forgeax-water-solver-output/2',
    );
  try {
    const result = restoreResult(envelope.result, step);
    if (!result)
      return invalid(output.entity, 'Water solver output Result or nested trace shape is invalid');
    if (
      result.ok &&
      (result.value.rootEntity !== output.entity ||
        result.value.rootGeneration !== output.entityGeneration ||
        result.value.physicsStep !== output.solveStep ||
        result.value.dynamics.completedStep !== output.sourceStep ||
        result.value.pontoons.some((point) =>
          point.candidateRoster.some(
            (candidate) =>
              candidate.result.ok &&
              candidate.result.value.localResidual?.ok === true &&
              Math.abs(
                candidate.result.value.localResidual.value.queryPhysicsTimeSeconds -
                  output.outputTimestampSeconds,
              ) > 1e-7,
          ),
        ))
    )
      return invalid(
        output.entity,
        'Water solver output does not match its exact Physics identity',
      );
    return result;
  } catch {
    return invalid(output.entity, 'Water solver output trace admission failed');
  }
}
