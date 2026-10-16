import { ok, type Result } from '@forgeax/engine-types';
import {
  type DistanceFieldError,
  distanceFieldFailure,
  MAX_VISIBILITY_DISTANCE_FIELD_AXIS,
  type MeshDistanceField,
} from './distance-field';
import { fieldBrickNegativeSamples, MAX_DISTANCE_FIELD_BYTES } from './distance-field-bricks';

/** Structural admission is shared by decoded artifacts and direct query snapshots. */
export function validateMeshDistanceField(
  field: MeshDistanceField,
): Result<void, DistanceFieldError> {
  const policy = field.policy;
  if (!policy || !['signed-solid', 'two-sided', 'sampled-visibility'].includes(policy.kind))
    return distanceFieldFailure('unknown distance-field policy');
  const visibility = policy.kind === 'sampled-visibility';
  if (
    !/^[a-f0-9]{64}$/.test(field.meshDigest) ||
    field.dimensions.length !== 3 ||
    field.origin.length !== 3 ||
    field.bounds.min.length !== 3 ||
    field.bounds.max.length !== 3 ||
    field.dimensions.some(
      (v) =>
        !Number.isInteger(v) || v < 3 || v > (visibility ? MAX_VISIBILITY_DISTANCE_FIELD_AXIS : 68),
    ) ||
    !Number.isFinite(field.spacing) ||
    field.spacing <= 0 ||
    ![...field.origin, ...field.bounds.min, ...field.bounds.max].every((v) =>
      Number.isFinite(Math.fround(v)),
    ) ||
    field.bounds.min.some(
      (v, a) =>
        (policy.kind === 'signed-solid'
          ? v >= (field.bounds.max[a] ?? -Infinity)
          : v > (field.bounds.max[a] ?? -Infinity)) || v < (field.origin[a] ?? Infinity),
    ) ||
    field.bounds.max.some(
      (v, a) => v > (field.origin[a] ?? 0) + ((field.dimensions[a] ?? 0) - 1) * field.spacing,
    ) ||
    !Number.isInteger(field.quality.negativeSamples) ||
    field.quality.negativeSamples < 0 ||
    (policy.kind === 'two-sided' && field.quality.negativeSamples !== 0) ||
    (policy.kind === 'signed-solid' && field.quality.negativeSamples < 1) ||
    !Number.isInteger(field.quality.testedTriangles) ||
    field.quality.testedTriangles < (policy.kind === 'signed-solid' ? 4 : 1) ||
    field.quality.testedTriangles >
      (visibility ? 1_048_576 : policy.kind === 'two-sided' ? 65536 : 1024)
  )
    return distanceFieldFailure('invalid, incomplete or inconsistent distance-field payload');
  if (fieldBrickNegativeSamples(field) !== field.quality.negativeSamples)
    return distanceFieldFailure(
      'invalid brick addresses, padding, storage budget or negative count',
    );
  if (policy.kind !== 'sampled-visibility') {
    if (
      !Number.isFinite(policy.errorBound) ||
      policy.errorBound < (Math.sqrt(3) * field.spacing) / 2
    )
      return distanceFieldFailure('invalid geometric distance bound');
  } else {
    const bounds = policy.traceBounds;
    if (
      !/^[a-f0-9]{64}$/.test(policy.sourceDigest) ||
      typeof policy.mostlyTwoSided !== 'boolean' ||
      !bounds ||
      bounds.min.length !== 3 ||
      bounds.max.length !== 3 ||
      ![...bounds.min, ...bounds.max, policy.distanceBand].every((v) =>
        Number.isFinite(Math.fround(v)),
      ) ||
      policy.distanceBand !== Math.fround(4 * Math.sqrt(3) * field.spacing) ||
      field.values.some((v) => Math.abs(v) > policy.distanceBand) ||
      bounds.min.some(
        (v, a) =>
          v >= (bounds.max[a] ?? -Infinity) ||
          v > (field.bounds.min[a] ?? -Infinity) ||
          v !== Math.fround((field.origin[a] ?? NaN) + field.spacing) ||
          v - (field.origin[a] ?? Infinity) < field.spacing * 0.99,
      ) ||
      bounds.max.some(
        (v, a) =>
          v < (field.bounds.max[a] ?? Infinity) ||
          (field.origin[a] ?? 0) + ((field.dimensions[a] ?? 0) - 1) * field.spacing - v <
            field.spacing * 0.99,
      )
    )
      return distanceFieldFailure('invalid visibility bounds, band or source policy');
    for (const axis of [0, 1, 2] as const) {
      let previous = -Infinity;
      for (let i = 0; i < field.dimensions[axis]; i++) {
        const center = Math.fround(field.origin[axis] + Math.fround(i * field.spacing));
        if (!Number.isFinite(center) || center <= previous)
          return distanceFieldFailure('visibility samples must have distinct finite f32 centers');
        previous = center;
      }
    }
  }
  return ok(undefined);
}
async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
/** Version 4 stores one brick address table and exact little-endian f32 payloads. */
export async function encodeMeshDistanceField(
  field: MeshDistanceField,
): Promise<Result<Uint8Array, DistanceFieldError>> {
  const valid = validateMeshDistanceField(field);
  if (!valid.ok) return valid;
  const samples = new Uint8Array(field.bricks.byteLength + field.values.byteLength),
    view = new DataView(samples.buffer);
  field.bricks.forEach((offset, i) => {
    view.setUint32(i * 4, offset, true);
  });
  field.values.forEach((value, i) => {
    view.setFloat32(field.bricks.byteLength + i * 4, value, true);
  });
  const { values: _, bricks: __, ...metadata } = field;
  const header = new TextEncoder().encode(JSON.stringify({ version: 4, ...metadata }));
  const bytes = new Uint8Array(4 + header.length + samples.length + 64);
  new DataView(bytes.buffer).setUint32(0, header.length, true);
  bytes.set(header, 4);
  bytes.set(samples, 4 + header.length);
  bytes.set(new TextEncoder().encode(await digest(bytes.subarray(0, -64))), bytes.length - 64);
  return ok(bytes);
}
/** Stale dense artifacts require a producer rebuild; no second runtime representation. */
export async function decodeMeshDistanceField(
  bytes: Uint8Array,
  expectedMeshDigest: string,
): Promise<Result<MeshDistanceField, DistanceFieldError>> {
  try {
    if (bytes.byteLength < 68 || bytes.byteLength > 4 + 4096 + MAX_DISTANCE_FIELD_BYTES + 64)
      return distanceFieldFailure('invalid artifact byte length');
    if ((await digest(bytes.subarray(0, -64))) !== new TextDecoder().decode(bytes.subarray(-64)))
      return distanceFieldFailure('distance-field artifact digest mismatch');
    const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      0,
      true,
    );
    if (headerLength > 4096 || headerLength + 4 >= bytes.length - 64)
      return distanceFieldFailure('missing artifact header or samples');
    const header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + headerLength)),
    );
    if (header.version !== 4 || header.meshDigest !== expectedMeshDigest)
      return distanceFieldFailure(
        'unsupported or stale distance-field artifact; rebuild its producer',
      );
    if (
      !Array.isArray(header.dimensions) ||
      header.dimensions.length !== 3 ||
      header.dimensions.some(
        (n: number) => !Number.isInteger(n) || n < 3 || n > MAX_VISIBILITY_DISTANCE_FIELD_AXIS,
      )
    )
      return distanceFieldFailure('invalid artifact dimensions');
    const brickCount = header.dimensions.reduce((n: number, d: number) => n * Math.ceil(d / 4), 1);
    const samples = bytes.subarray(4 + headerLength, -64);
    if (samples.length % 4 !== 0 || samples.length < brickCount * 4 + 256)
      return distanceFieldFailure('truncated distance-field samples');
    const view = new DataView(samples.buffer, samples.byteOffset, samples.byteLength),
      bricks = new Uint32Array(brickCount),
      values = new Float32Array(samples.length / 4 - brickCount);
    for (let i = 0; i < bricks.length; i++) bricks[i] = view.getUint32(i * 4, true);
    for (let i = 0; i < values.length; i++)
      values[i] = view.getFloat32(bricks.byteLength + i * 4, true);
    const { version: _, ...metadata } = header;
    const field: MeshDistanceField = { ...metadata, bricks, values };
    const valid = validateMeshDistanceField(field);
    return valid.ok ? ok(field) : valid;
  } catch {
    return distanceFieldFailure('malformed distance-field artifact');
  }
}
