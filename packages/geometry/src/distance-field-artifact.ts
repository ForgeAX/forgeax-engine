import {
  type FieldVec3,
  type MeshDistanceFieldSurface,
  ok,
  type Result,
} from '@forgeax/engine-types';
import {
  type DistanceFieldError,
  distanceFieldFailure,
  distanceFieldMeshDigest,
  MAX_VISIBILITY_DISTANCE_FIELD_AXIS,
  type MeshDistanceField,
} from './distance-field';
import {
  distanceFieldDataLayout,
  distanceFieldSurfaceCounts,
  MESH_DISTANCE_FIELD_ARTIFACT_VERSION,
  readFieldData,
  writeFieldData,
} from './distance-field-artifact-layout';
import { fieldBrickNegativeSamples, MAX_DISTANCE_FIELD_BYTES } from './distance-field-bricks';
import { validateDistanceFieldSurface } from './distance-field-surface';
import { visibilityDistanceFieldSourceDigest } from './visibility-distance-field';

function qualityValid(field: MeshDistanceField, visibility: boolean) {
  const policy = field.policy,
    quality = field.quality;
  return (
    Number.isInteger(quality.negativeSamples) &&
    quality.negativeSamples >= 0 &&
    (policy.kind !== 'two-sided' || quality.negativeSamples === 0) &&
    (policy.kind !== 'signed-solid' || quality.negativeSamples >= 1) &&
    Number.isInteger(quality.testedTriangles) &&
    quality.testedTriangles >= (policy.kind === 'signed-solid' ? 4 : 1) &&
    quality.testedTriangles <= (visibility ? 1_048_576 : policy.kind === 'two-sided' ? 65536 : 1024)
  );
}

function validateSampledSurface(field: MeshDistanceField): Result<void, DistanceFieldError> {
  const policy = field.policy;
  if (
    policy.kind !== 'sampled-visibility' ||
    !field.surface ||
    !Number.isFinite(policy.unsignedSampleError) ||
    policy.unsignedSampleError < 0
  )
    return distanceFieldFailure(
      'sampled field requires a finite unsigned sample error and complete source surface',
    );
  const valid = validateDistanceFieldSurface(field.surface);
  if (!valid.ok) return valid;
  return field.surface.primitiveOrder.length === field.quality.testedTriangles
    ? ok(undefined)
    : distanceFieldFailure('sampled field surface coverage differs from the producer query');
}

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
    !qualityValid(field, visibility)
  )
    return distanceFieldFailure('invalid, incomplete or inconsistent distance-field payload');
  if (fieldBrickNegativeSamples(field) !== field.quality.negativeSamples)
    return distanceFieldFailure(
      'invalid brick addresses, padding, storage budget or negative count',
    );
  const layout = distanceFieldDataLayout(
    field.bricks.length,
    field.values.length,
    field.surface ? distanceFieldSurfaceCounts(field.surface) : undefined,
  );
  if (!layout.ok) return layout;
  if (policy.kind !== 'sampled-visibility') {
    if (field.surface !== undefined)
      return distanceFieldFailure('geometric field cannot borrow a sampled source surface');
    if (
      !Number.isFinite(policy.errorBound) ||
      policy.errorBound < (Math.sqrt(3) * field.spacing) / 2
    )
      return distanceFieldFailure('invalid geometric distance bound');
  } else {
    const surface = validateSampledSurface(field);
    if (!surface.ok) return surface;
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
/** Shared source-byte gate for codec and direct attachment publication. */
export async function validateDistanceFieldSourceIdentity(
  field: MeshDistanceField,
): Promise<Result<void, DistanceFieldError>> {
  if (field.policy.kind !== 'sampled-visibility') return ok(undefined);
  const surface = field.surface;
  if (
    !surface ||
    (await distanceFieldMeshDigest(surface.positions, surface.indices)) !== field.meshDigest
  )
    return distanceFieldFailure(
      'flat surface does not match canonical mesh digest; recook the source',
    );
  const flags = new Uint8Array(surface.indices.length / 3);
  for (let i = 0; i < flags.length; i++)
    flags[i] = ((surface.triangleSidedness[i >>> 5] ?? 0) >>> (i & 31)) & 1;
  if (
    (await visibilityDistanceFieldSourceDigest(field.meshDigest, flags)) !==
    field.policy.sourceDigest
  )
    return distanceFieldFailure('flat surface sidedness does not match the source policy');
  return ok(undefined);
}

/** Version 5 stores exact samples and flat, source-closed triangle/BVH channels.
 * Channel spans derive from one directory authority; old artifacts require recook. */
export async function encodeMeshDistanceField(
  field: MeshDistanceField,
): Promise<Result<Uint8Array, DistanceFieldError>> {
  const valid = validateMeshDistanceField(field);
  if (!valid.ok) return valid;
  const identity = await validateDistanceFieldSourceIdentity(field);
  if (!identity.ok) return identity;
  const surface = field.surface,
    surfaceCounts = surface ? distanceFieldSurfaceCounts(surface) : undefined;
  const layout = distanceFieldDataLayout(field.bricks.length, field.values.length, surfaceCounts);
  if (!layout.ok) return layout;
  const channels = new Map<string, ArrayLike<number>>([
    ['bricks', field.bricks],
    ['values', field.values],
  ]);
  if (surface) {
    for (const [name, array] of Object.entries(surface)) channels.set(name, array);
  }
  const samples = new Uint8Array(layout.value.byteLength);
  if (!writeFieldData(samples, layout.value, channels))
    return distanceFieldFailure('derived field channel writer mismatch');
  const { values: _, bricks: __, surface: ___, ...metadata } = field;
  const header = new TextEncoder().encode(
    JSON.stringify({
      version: MESH_DISTANCE_FIELD_ARTIFACT_VERSION,
      ...metadata,
      valueCount: field.values.length,
      ...(surfaceCounts ? { surfaceCounts } : {}),
    }),
  );
  if (header.length > 4096)
    return distanceFieldFailure(
      'derived field metadata exceeds artifact header budget',
      'distance-field-limit',
    );
  const start = Math.ceil((4 + header.length) / 16) * 16,
    bytes = new Uint8Array(start + samples.length + 64);
  new DataView(bytes.buffer).setUint32(0, header.length, true);
  bytes.set(header, 4);
  bytes.set(samples, start);
  bytes.set(new TextEncoder().encode(await digest(bytes.subarray(0, -64))), bytes.length - 64);
  return ok(bytes);
}

function artifactDimensionsValid(dimensions: unknown): dimensions is FieldVec3 {
  return (
    Array.isArray(dimensions) &&
    dimensions.length === 3 &&
    dimensions.every(
      (n) => Number.isInteger(n) && n >= 3 && n <= MAX_VISIBILITY_DISTANCE_FIELD_AXIS,
    )
  );
}
function decodeFlatSurface(
  channels: NonNullable<ReturnType<typeof readFieldData>>,
): Result<MeshDistanceFieldSurface, DistanceFieldError> {
  const positions = channels.get('positions'),
    indices = channels.get('indices'),
    triangleSidedness = channels.get('triangleSidedness'),
    nodes = channels.get('nodes'),
    primitiveOrder = channels.get('primitiveOrder');
  if (
    !(positions instanceof Float32Array) ||
    !(indices instanceof Uint32Array) ||
    !(triangleSidedness instanceof Uint32Array) ||
    !(nodes instanceof Uint8Array) ||
    !(primitiveOrder instanceof Uint32Array)
  )
    return distanceFieldFailure('artifact flat surface channels missing');
  return ok({ positions, indices, triangleSidedness, nodes, primitiveOrder });
}
function alignedArtifactBody(bytes: Uint8Array, headerLength: number): Uint8Array | null {
  const start = Math.ceil((4 + headerLength) / 16) * 16;
  for (let i = 4 + headerLength; i < start; i++) if (bytes[i] !== 0) return null;
  return bytes.subarray(start, -64);
}
/** Stale dense artifacts require a producer rebuild; no second runtime representation. */
export async function decodeMeshDistanceField(
  bytes: Uint8Array,
  expectedMeshDigest: string,
): Promise<Result<MeshDistanceField, DistanceFieldError>> {
  try {
    if (bytes.byteLength < 80 || bytes.byteLength > 16 + 4096 + MAX_DISTANCE_FIELD_BYTES + 64)
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
    if (
      header.version !== MESH_DISTANCE_FIELD_ARTIFACT_VERSION ||
      header.meshDigest !== expectedMeshDigest
    )
      return distanceFieldFailure(
        'unsupported or stale distance-field artifact; rebuild its producer',
      );
    if (!artifactDimensionsValid(header.dimensions))
      return distanceFieldFailure('invalid artifact dimensions');
    const brickCount = header.dimensions.reduce((n: number, d: number) => n * Math.ceil(d / 4), 1);
    const visibility = header.policy?.kind === 'sampled-visibility';
    if (visibility !== (header.surfaceCounts !== undefined))
      return distanceFieldFailure('artifact source surface does not match its policy');
    const layout = distanceFieldDataLayout(brickCount, header.valueCount, header.surfaceCounts);
    if (!layout.ok) return layout;
    const body = alignedArtifactBody(bytes, headerLength);
    if (!body) return distanceFieldFailure('nonzero artifact alignment padding');
    const channels = readFieldData(body, layout.value);
    if (!channels)
      return distanceFieldFailure(
        'truncated, overlapping or noncanonical derived field channel span',
      );
    const bricks = channels.get('bricks'),
      values = channels.get('values');
    if (!(bricks instanceof Uint32Array) || !(values instanceof Float32Array))
      return distanceFieldFailure('artifact sample channels missing');
    const { version: _, valueCount: __, surfaceCounts: ___, ...metadata } = header;
    let field: MeshDistanceField;
    if (visibility) {
      const surface = decodeFlatSurface(channels);
      if (!surface.ok) return surface;
      field = {
        ...metadata,
        bricks,
        values,
        surface: surface.value,
      };
    } else field = { ...metadata, bricks, values };
    const valid = validateMeshDistanceField(field);
    if (!valid.ok) return valid;
    const identity = await validateDistanceFieldSourceIdentity(field);
    return identity.ok ? ok(field) : identity;
  } catch {
    return distanceFieldFailure('malformed distance-field artifact');
  }
}
