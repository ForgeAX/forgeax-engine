import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type Vec3,
  type WaterError,
  WaterQueryFlags,
  type WaterQueryInput,
  type WaterQueryResult,
} from './contracts.js';

export type WaterResidualQueryReceiver = Readonly<{ entity: number; generation: number }>;

export function isWaterResidualQueryReceiver(value: unknown): value is WaterResidualQueryReceiver {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 2 &&
    ['entity', 'generation'].every(
      (key) =>
        typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && Number(row[key]) >= 0,
    )
  );
}

export type WaterResidualQueryBinding = Readonly<{
  worldIdentity: string;
  bodyGuid: string;
  bodyGeneration: number;
  maximumAgeSeconds: number;
}>;
export type WaterResidualQueryRegion = Readonly<{
  offset: readonly [number, number];
  size: readonly [number, number];
}>;
export type WaterResidualQueryDomain = Readonly<{
  resolution: number;
  centerXZ: readonly [number, number];
  domainLengthM: number;
  baseHeightM: number;
  yawRadians: number;
}>;
export type WaterResidualQueryField = WaterResidualQueryRegion &
  WaterResidualQueryDomain &
  Readonly<{
    binding: WaterResidualQueryBinding;
    recipeGuid: string;
    recipeVersion: string;
    patchGeneration: number;
    deviceGeneration: number;
    sourceSequence: number;
    sourcePhysicsStep: number;
    timeSeconds: number;
    simulationTimeSeconds: number;
    completedFrame: number;
    resolution: number;
    centerXZ: readonly [number, number];
    domainLengthM: number;
    baseHeightM: number;
    yawRadians: number;
    /** Plane zero is the full field; each following plane excludes the corresponding native receiver. */
    receivers?: readonly WaterResidualQueryReceiver[];
    /** Exact source cells, X-fast within each plane. Tile edges never become patch boundaries. */
    heightsM: Float32Array | readonly number[];
  }>;
export type WaterResidualQuerySource = Readonly<{
  binding: WaterResidualQueryBinding;
  domain: WaterResidualQueryDomain;
  field?: WaterResidualQueryField;
}>;
export type WaterResidualQuerySample = Readonly<{
  worldIdentity: string;
  bodyGuid: string;
  bodyGeneration: number;
  recipeGuid: string;
  recipeVersion: string;
  patchGeneration: number;
  deviceGeneration: number;
  sourceSequence: number;
  sourcePhysicsStep: number;
  timeSeconds: number;
  simulationTimeSeconds: number;
  completedFrame: number;
  ageSeconds: number;
  maximumAgeSeconds: number;
  queryPhysicsStep: number;
  queryPhysicsTimeSeconds: number;
  heightM: number;
  weight: number;
  receiver?: WaterResidualQueryReceiver;
}>;

const RESIDUAL_QUERY_REASONS = Object.freeze({
  'body-generation': true,
  'source-binding': true,
  'not-completed': true,
  'native-clock-unavailable': true,
  'future-step': true,
  'future-time': true,
  expired: true,
  'outside-completed-tile': true,
  'region-request-limit': true,
  'region-limit': true,
  'unissued-readback': true,
  'retired-readback': true,
  'readback-unavailable': true,
  'nonfinite-readback': true,
  'receiver-unavailable': true,
  'receiver-limit': true,
});
export type WaterResidualQueryError = Readonly<{
  code: 'query-data-unavailable';
  expected: string;
  hint: string;
  detail: Readonly<{
    kind: 'local-residual';
    reason: keyof typeof RESIDUAL_QUERY_REASONS;
    ageSeconds?: number;
    maximumCellsPerAxis?: number;
  }>;
}>;
export type WaterResidualQueryResult = Result<WaterResidualQuerySample, WaterResidualQueryError>;

export function residualQueryFailure(
  reason: WaterResidualQueryError['detail']['reason'],
  detail?: Pick<WaterResidualQueryError['detail'], 'ageSeconds' | 'maximumCellsPerAxis'>,
): WaterResidualQueryError {
  return {
    code: 'query-data-unavailable',
    expected: 'a current completed local residual covering this query on the native Physics clock',
    hint: 'refresh the bounded query region and wait for its completed GPU sample',
    detail: {
      kind: 'local-residual',
      reason,
      ...detail,
    },
  };
}

export function isWaterResidualQueryError(value: unknown): value is WaterResidualQueryError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>,
    detail = row.detail as Record<string, unknown> | undefined;
  return (
    Object.keys(row).every((key) => ['code', 'expected', 'hint', 'detail'].includes(key)) &&
    row.code === 'query-data-unavailable' &&
    typeof row.expected === 'string' &&
    typeof row.hint === 'string' &&
    !!detail &&
    typeof detail === 'object' &&
    !Array.isArray(detail) &&
    detail.kind === 'local-residual' &&
    typeof detail.reason === 'string' &&
    Object.hasOwn(RESIDUAL_QUERY_REASONS, detail.reason) &&
    Object.keys(detail).every((key) =>
      ['kind', 'reason', 'ageSeconds', 'maximumCellsPerAxis'].includes(key),
    ) &&
    ['ageSeconds', 'maximumCellsPerAxis'].every(
      (key) =>
        detail[key] === undefined ||
        (typeof detail[key] === 'number' && Number.isFinite(detail[key])),
    )
  );
}

export function isWaterResidualQuerySample(value: unknown): value is WaterResidualQuerySample {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const textKeys = ['worldIdentity', 'bodyGuid', 'recipeGuid', 'recipeVersion'];
  const integerKeys = [
    'bodyGeneration',
    'patchGeneration',
    'deviceGeneration',
    'sourceSequence',
    'sourcePhysicsStep',
    'completedFrame',
    'queryPhysicsStep',
  ];
  const numberKeys = [
    'timeSeconds',
    'simulationTimeSeconds',
    'ageSeconds',
    'maximumAgeSeconds',
    'queryPhysicsTimeSeconds',
    'heightM',
    'weight',
  ];
  return (
    Object.keys(row).length ===
      textKeys.length +
        integerKeys.length +
        numberKeys.length +
        Number(row.receiver !== undefined) &&
    (row.receiver === undefined || isWaterResidualQueryReceiver(row.receiver)) &&
    textKeys.every((key) => typeof row[key] === 'string' && row[key].length > 0) &&
    integerKeys.every(
      (key) =>
        typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && Number(row[key]) >= 0,
    ) &&
    numberKeys.every((key) => typeof row[key] === 'number' && Number.isFinite(row[key])) &&
    Number(row.queryPhysicsStep) >= Number(row.sourcePhysicsStep) &&
    Number(row.timeSeconds) >= 0 &&
    Number(row.maximumAgeSeconds) > 0 &&
    Number(row.maximumAgeSeconds) <= 0.5 &&
    Number(row.ageSeconds) >= 0 &&
    Number(row.ageSeconds) <= Number(row.maximumAgeSeconds) &&
    Number(row.queryPhysicsTimeSeconds) >= Number(row.timeSeconds) - 1e-7 &&
    Math.abs(
      Number(row.ageSeconds) -
        Math.max(0, Number(row.queryPhysicsTimeSeconds) - Number(row.timeSeconds)),
    ) < 1e-7 &&
    Number(row.weight) >= 0 &&
    Number(row.weight) <= 1
  );
}

/** Shared wire admission for the bounded detached Worker source. */
export function isWaterResidualQuerySource(value: unknown): value is WaterResidualQuerySource {
  const record = (candidate: unknown): Record<string, unknown> | undefined =>
    candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : undefined;
  const finite = (candidate: unknown): candidate is number =>
    typeof candidate === 'number' && Number.isFinite(candidate);
  const integer = (candidate: unknown): candidate is number =>
    finite(candidate) && Number.isSafeInteger(candidate) && candidate >= 0;
  const pair = (candidate: unknown): candidate is [number, number] =>
    Array.isArray(candidate) && candidate.length === 2 && candidate.every(finite);
  const text = (candidate: unknown) => typeof candidate === 'string' && candidate.length > 0;
  const keys = (candidate: Record<string, unknown>, allowed: readonly string[]) =>
    Object.keys(candidate).every((key) => allowed.includes(key));

  function validSourceBinding(
    binding: Record<string, unknown> | undefined,
  ): binding is Record<string, unknown> & WaterResidualQueryBinding {
    return !(
      !binding ||
      !keys(binding, ['worldIdentity', 'bodyGuid', 'bodyGeneration', 'maximumAgeSeconds']) ||
      !text(binding.worldIdentity) ||
      !text(binding.bodyGuid) ||
      !integer(binding.bodyGeneration) ||
      !finite(binding.maximumAgeSeconds) ||
      binding.maximumAgeSeconds <= 0 ||
      binding.maximumAgeSeconds > 0.5
    );
  }
  function validSourceDomain(
    domain: Record<string, unknown> | undefined,
  ): domain is Record<string, unknown> & WaterResidualQueryDomain {
    return !(
      !domain ||
      !keys(domain, ['resolution', 'centerXZ', 'domainLengthM', 'baseHeightM', 'yawRadians']) ||
      !integer(domain.resolution) ||
      Number(domain.resolution) < 1 ||
      Number(domain.resolution) > 4096 ||
      !pair(domain.centerXZ) ||
      !finite(domain.domainLengthM) ||
      domain.domainLengthM <= 0 ||
      !finite(domain.baseHeightM) ||
      !finite(domain.yawRadians)
    );
  }
  const source = record(value),
    binding = source && record(source.binding),
    domain = source && record(source.domain);
  if (
    !source ||
    !keys(source, ['binding', 'domain', 'field']) ||
    !validSourceBinding(binding) ||
    !validSourceDomain(domain)
  )
    return false;
  if (source.field === undefined) return true;
  const centerXZ = domain.centerXZ;

  function validCompletedFieldData(field: Record<string, unknown>): boolean {
    return (
      ['recipeGuid', 'recipeVersion'].every((key) => text(field[key])) &&
      [
        'patchGeneration',
        'deviceGeneration',
        'sourceSequence',
        'completedFrame',
        'resolution',
      ].every((key) => integer(field[key])) &&
      Number(field.resolution) > 0 &&
      Number(field.resolution) <= 4096 &&
      integer(field.sourcePhysicsStep) &&
      ['timeSeconds', 'simulationTimeSeconds', 'baseHeightM', 'yawRadians', 'domainLengthM'].every(
        (key) => finite(field[key]),
      ) &&
      Number(field.domainLengthM) > 0 &&
      pair(field.centerXZ) &&
      pair(field.offset) &&
      pair(field.size) &&
      field.offset.every(
        (offset) =>
          Number.isSafeInteger(offset) && offset >= 0 && offset < Number(field.resolution),
      ) &&
      field.size.every(
        (size) =>
          Number.isSafeInteger(size) && size > 0 && size <= Math.min(128, Number(field.resolution)),
      ) &&
      validCompletedFieldReceivers(field) &&
      Array.isArray(field.heightsM) &&
      field.heightsM.length ===
        field.size[0] *
          field.size[1] *
          (1 + (Array.isArray(field.receivers) ? field.receivers.length : 0)) &&
      field.heightsM.every(finite)
    );
  }
  const field = record(source.field),
    fieldBinding = field && record(field.binding);
  return (
    !!field &&
    keys(field, [
      'binding',
      'recipeGuid',
      'recipeVersion',
      'patchGeneration',
      'deviceGeneration',
      'sourceSequence',
      'sourcePhysicsStep',
      'timeSeconds',
      'simulationTimeSeconds',
      'completedFrame',
      'resolution',
      'centerXZ',
      'domainLengthM',
      'baseHeightM',
      'yawRadians',
      'offset',
      'size',
      'heightsM',
      'receivers',
    ]) &&
    !!fieldBinding &&
    keys(fieldBinding, ['worldIdentity', 'bodyGuid', 'bodyGeneration', 'maximumAgeSeconds']) &&
    ['worldIdentity', 'bodyGuid', 'bodyGeneration', 'maximumAgeSeconds'].every(
      (key) => fieldBinding[key] === binding[key],
    ) &&
    ['resolution', 'domainLengthM', 'baseHeightM', 'yawRadians'].every(
      (key) => field[key] === domain[key],
    ) &&
    pair(field.centerXZ) &&
    field.centerXZ.every((value, index) => value === centerXZ[index]) &&
    validCompletedFieldData(field)
  );
}

/** Matches shallowSampleCells and shallowComposeNormal, including the original four-cell edge. */
export function composeWaterQueryResidual(
  result: WaterQueryResult,
  input: WaterQueryInput,
  source: WaterResidualQuerySource | undefined,
): Result<WaterQueryResult, WaterError> {
  if (!source || result.excluded || (input.flags & WaterQueryFlags.IncludeWaves) === 0)
    return ok(result);
  const unavailable = (error: WaterResidualQueryError) =>
    ok(Object.freeze({ ...result, localResidual: err(error) }));
  const { binding, field, domain } = source;
  if (binding.bodyGuid !== result.bodyGuid || binding.bodyGeneration !== result.bodyGeneration)
    return unavailable(residualQueryFailure('body-generation'));
  const c = Math.cos(domain.yawRadians),
    s = Math.sin(domain.yawRadians);
  const dx = input.positionM[0] - domain.centerXZ[0],
    dz = input.positionM[2] - domain.centerXZ[1];
  const uv = [
    (c * dx + s * dz) / domain.domainLengthM + 0.5,
    (-s * dx + c * dz) / domain.domainLengthM + 0.5,
  ] as const;
  if (uv.some((value) => value < 0 || value > 1)) return ok(result);
  if (!field) return unavailable(residualQueryFailure('not-completed'));
  if (
    field.binding.worldIdentity !== binding.worldIdentity ||
    field.binding.bodyGuid !== binding.bodyGuid ||
    field.binding.bodyGeneration !== binding.bodyGeneration ||
    field.binding.maximumAgeSeconds !== binding.maximumAgeSeconds
  )
    return unavailable(residualQueryFailure('source-binding'));
  const clock = completedResidualClock(input, field, binding);
  if (!clock.ok) return unavailable(clock.error);
  const { age, native } = clock.value;
  let plane = 0;
  if (input.receiver !== undefined) {
    if (!isWaterResidualQueryReceiver(input.receiver))
      return unavailable(residualQueryFailure('receiver-unavailable'));
    const index =
      field.receivers?.findIndex(
        (receiver) =>
          receiver.entity === input.receiver?.entity &&
          receiver.generation === input.receiver.generation,
      ) ?? -1;
    if (index < 0) return unavailable(residualQueryFailure('receiver-unavailable'));
    plane = index + 1;
  }
  return composeCompletedWaterResidual(result, input, field, uv, plane, c, s, binding, age, native);
}

function validCompletedFieldReceivers(field: Record<string, unknown>): boolean {
  return (
    field.receivers === undefined ||
    (Array.isArray(field.receivers) &&
      field.receivers.length <= 32 &&
      field.receivers.every(isWaterResidualQueryReceiver) &&
      new Set(field.receivers.map((receiver) => `${receiver.entity}:${receiver.generation}`))
        .size === field.receivers.length)
  );
}

function composeCompletedWaterResidual(
  result: WaterQueryResult,
  input: WaterQueryInput,
  field: WaterResidualQueryField,
  uv: readonly [number, number],
  plane: number,
  c: number,
  s: number,
  binding: WaterResidualQueryBinding,
  age: number,
  native: NonNullable<WaterQueryInput['nativePhysics']>,
): Result<WaterQueryResult, WaterError> {
  const unavailable = (error: WaterResidualQueryError) =>
    ok(Object.freeze({ ...result, localResidual: err(error) }));
  const n = field.resolution,
    pixel = uv.map((value) => value * n - 0.5);
  const ix = Math.floor(pixel[0] ?? 0),
    iz = Math.floor(pixel[1] ?? 0);
  const tx = (pixel[0] ?? 0) - ix,
    tz = (pixel[1] ?? 0) - iz;
  const clamp = (value: number) => Math.max(0, Math.min(n - 1, value));
  const height = (x: number, z: number): number | undefined => {
    const atX = (((x - field.offset[0]) % n) + n) % n,
      atZ = (((z - field.offset[1]) % n) + n) % n;
    if (atX < 0 || atZ < 0 || atX >= field.size[0] || atZ >= field.size[1]) return;
    return field.heightsM[plane * field.size[0] * field.size[1] + atZ * field.size[0] + atX];
  };
  const corners = [
    [clamp(ix), clamp(iz)],
    [clamp(ix + 1), clamp(iz)],
    [clamp(ix), clamp(iz + 1)],
    [clamp(ix + 1), clamp(iz + 1)],
  ] as const;
  const values = corners.map(([x, z]) => {
    const eta = height(x, z),
      left = height(x - 1, z),
      right = height(x + 1, z),
      down = height(x, z - 1),
      up = height(x, z + 1);
    if ([eta, left, right, down, up].some((value) => value === undefined)) return undefined;
    const normal: Vec3 = [
      (-(Number(right) - Number(left)) * n) / (2 * field.domainLengthM),
      1,
      (-(Number(up) - Number(down)) * n) / (2 * field.domainLengthM),
    ];
    const length = Math.hypot(...normal);
    return [Number(eta), normal[0] / length, normal[1] / length, normal[2] / length] as const;
  });
  if (values.some((value) => value === undefined))
    return unavailable(residualQueryFailure('outside-completed-tile'));
  const mix = (lane: number) => {
    const a = Number(values[0]?.[lane]) * (1 - tx) + Number(values[1]?.[lane]) * tx;
    const b = Number(values[2]?.[lane]) * (1 - tx) + Number(values[3]?.[lane]) * tx;
    return a * (1 - tz) + b * tz;
  };
  const edges = [Math.min(uv[0], 1 - uv[0]) * n, Math.min(uv[1], 1 - uv[1]) * n];
  const t = Math.max(0, Math.min(1, Math.min(...edges) / 4)),
    weight = t * t * (3 - 2 * t);
  const gradient = (((6 * t * (1 - t)) / 4) * n) / field.domainLengthM;
  const gx = Number(edges[0]) <= Number(edges[1]) ? (uv[0] > 0.5 ? -gradient : gradient) : 0;
  const gz = Number(edges[0]) > Number(edges[1]) ? (uv[1] > 0.5 ? -gradient : gradient) : 0;
  const eta = mix(0),
    nx = c * mix(1) - s * mix(3),
    nz = s * mix(1) + c * mix(3);
  const baseNormal = result.normalYUp ?? [0, 1, 0];
  const normal: Vec3 = [
    baseNormal[0] / Math.max(baseNormal[1], 0.0001) +
      (nx / Math.max(mix(2), 0.0001)) * weight -
      eta * (c * gx - s * gz),
    1,
    baseNormal[2] / Math.max(baseNormal[1], 0.0001) +
      (nz / Math.max(mix(2), 0.0001)) * weight -
      eta * (s * gx + c * gz),
  ];
  const normalLength = Math.hypot(...normal),
    displacement = eta * weight;
  return ok(
    Object.freeze({
      ...result,
      ...(result.surfaceM
        ? {
            surfaceM: [
              result.surfaceM[0],
              result.surfaceM[1] + displacement,
              result.surfaceM[2],
            ] satisfies Vec3,
          }
        : {}),
      ...(result.normalYUp
        ? {
            normalYUp: [
              normal[0] / normalLength,
              normal[1] / normalLength,
              normal[2] / normalLength,
            ] satisfies Vec3,
          }
        : {}),
      ...(result.depthM === undefined ? {} : { depthM: Math.max(0, result.depthM + displacement) }),
      ...(result.immersionM === undefined ? {} : { immersionM: result.immersionM + displacement }),
      localResidual: ok({
        worldIdentity: binding.worldIdentity,
        recipeGuid: field.recipeGuid,
        recipeVersion: field.recipeVersion,
        bodyGuid: binding.bodyGuid,
        bodyGeneration: binding.bodyGeneration,
        patchGeneration: field.patchGeneration,
        deviceGeneration: field.deviceGeneration,
        sourceSequence: field.sourceSequence,
        sourcePhysicsStep: field.sourcePhysicsStep,
        timeSeconds: field.timeSeconds,
        completedFrame: field.completedFrame,
        ageSeconds: Math.max(0, age),
        simulationTimeSeconds: field.simulationTimeSeconds,
        maximumAgeSeconds: binding.maximumAgeSeconds,
        queryPhysicsStep: native.completedStep,
        queryPhysicsTimeSeconds: native.timeSeconds,
        heightM: displacement,
        weight,
        ...(input.receiver === undefined ? {} : { receiver: input.receiver }),
      }),
    }),
  );
}

function completedResidualClock(
  input: WaterQueryInput,
  field: WaterResidualQueryField,
  binding: WaterResidualQueryBinding,
): Result<
  { readonly age: number; readonly native: NonNullable<WaterQueryInput['nativePhysics']> },
  WaterResidualQueryError
> {
  const native = input.nativePhysics;
  if (
    !native ||
    !Number.isFinite(native.timeSeconds) ||
    !Number.isSafeInteger(native.completedStep)
  )
    return err(residualQueryFailure('native-clock-unavailable'));
  const age = native.timeSeconds - field.timeSeconds;
  if (native.completedStep < field.sourcePhysicsStep)
    return err(residualQueryFailure('future-step'));
  if (age < -1e-7 || age > binding.maximumAgeSeconds)
    return err(residualQueryFailure(age < 0 ? 'future-time' : 'expired', { ageSeconds: age }));
  return ok({ age, native });
}
