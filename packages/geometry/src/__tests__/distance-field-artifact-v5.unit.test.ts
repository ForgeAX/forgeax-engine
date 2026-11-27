import type { MeshDistanceField } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { MESH_DISTANCE_FIELD_GENERATION_VERSION } from '../distance-field';
import {
  decodeMeshDistanceField,
  encodeMeshDistanceField,
  validateMeshDistanceField,
} from '../distance-field-artifact';
import { MESH_DISTANCE_FIELD_ARTIFACT_VERSION } from '../distance-field-artifact-layout';
import { FieldBrickBuilder } from '../distance-field-bricks';
import {
  MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
  meshDistanceFieldSource,
  validateMeshDistanceFieldAttachment,
} from '../mesh-distance-field-product';
import { createPlaneGeometry } from '../plane';
import { buildVisibilityDistanceField } from '../visibility-distance-field';

async function field() {
  return (
    await buildVisibilityDistanceField(
      [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
      [0, 1, 2, 0, 2, 3],
      { voxelSize: 0.5, triangleSidedness: [1, 1] },
    )
  ).unwrap();
}
const header = (bytes: Uint8Array) => {
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  return { length, value: JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) };
};
async function digest(bytes: Uint8Array) {
  const result = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
  return new TextEncoder().encode(
    Array.from(result, (v) => v.toString(16).padStart(2, '0')).join(''),
  );
}
async function rewrite(
  bytes: Uint8Array,
  edit: (value: Record<string, unknown>) => void,
  whitespace = '',
) {
  const old = header(bytes);
  edit(old.value);
  const json = new TextEncoder().encode(JSON.stringify(old.value) + whitespace),
    start = Math.ceil((4 + json.length) / 16) * 16;
  const body = bytes.subarray(Math.ceil((4 + old.length) / 16) * 16, -64),
    result = new Uint8Array(start + body.length + 64);
  new DataView(result.buffer).setUint32(0, json.length, true);
  result.set(json, 4);
  result.set(body, start);
  result.set(await digest(result.subarray(0, -64)), result.length - 64);
  return result;
}
it('roundtrips required source surface and unsigned proof under one v5 codec/generation6 authority', async () => {
  const source = await field(),
    bytes = (await encodeMeshDistanceField(source)).unwrap(),
    meta = header(bytes);
  expect(MESH_DISTANCE_FIELD_ARTIFACT_VERSION).toBe(5);
  expect(MESH_DISTANCE_FIELD_GENERATION_VERSION).toBe(6);
  expect(MESH_VISIBILITY_DISTANCE_FIELD_CODEC.version).toBe(
    String(MESH_DISTANCE_FIELD_ARTIFACT_VERSION),
  );
  expect(meta.value.version).toBe(5);
  expect(meta.value.surfaceCounts.vertices).toBe(4);
  expect((await decodeMeshDistanceField(bytes, source.meshDigest)).unwrap()).toEqual(source);
  expect(source.policy.kind).toBe('sampled-visibility');
  if (source.policy.kind === 'sampled-visibility')
    expect(Number.isFinite(source.policy.unsignedSampleError)).toBe(true);
  const stale = await rewrite(bytes, (h) => {
    h.version = 4;
  });
  expect((await decodeMeshDistanceField(stale, source.meshDigest)).ok).toBe(false);
});
it('rejects missing proof, invalid unsigned bounds and forged surface source identity', async () => {
  const source = await field();
  if (source.policy.kind !== 'sampled-visibility' || !source.surface)
    throw Error('Sampled producer required');
  const absent = { ...source, surface: undefined } as unknown as MeshDistanceField;
  expect(validateMeshDistanceField(absent).ok).toBe(false);
  for (const bound of [-1, NaN, Infinity])
    expect(
      validateMeshDistanceField({
        ...source,
        policy: { ...source.policy, unsignedSampleError: bound },
      }).ok,
    ).toBe(false);
  const flags = source.surface.triangleSidedness.slice();
  flags[0] = (flags[0] ?? 0) ^ 1;
  const forged = { ...source, surface: { ...source.surface, triangleSidedness: flags } };
  expect(validateMeshDistanceField(forged).ok).toBe(true);
  expect((await encodeMeshDistanceField(forged)).ok).toBe(false);
});
it('rejects rehashed counts, truncation and nonzero alignment bytes before source publication', async () => {
  const source = await field(),
    bytes = (await encodeMeshDistanceField(source)).unwrap();
  for (const edit of [
    (h: Record<string, unknown>) => {
      h.valueCount = 0;
    },
    (h: Record<string, unknown>) => {
      h.surfaceCounts = { vertices: 4, indices: 6, nodes: 1, order: 1 };
    },
    (h: Record<string, unknown>) => {
      h.surfaceCounts = { vertices: 2 ** 30, indices: 6, nodes: 1, order: 2 };
    },
    (h: Record<string, unknown>) => {
      h.surfaceCounts = { vertices: 4, indices: 6, nodes: 1, order: 2, unknown: 1 };
    },
    (h: Record<string, unknown>) => {
      delete h.surfaceCounts;
    },
  ])
    expect((await decodeMeshDistanceField(await rewrite(bytes, edit), source.meshDigest)).ok).toBe(
      false,
    );
  const suffix = (4 + header(bytes).length + 1) % 16 === 0 ? '  ' : ' ';
  const padded = await rewrite(bytes, () => {}, suffix),
    h = header(padded),
    start = Math.ceil((4 + h.length) / 16) * 16;
  if (start === 4 + h.length)
    throw Error('Expected padding witness requires another whitespace character');
  padded[4 + h.length] = 1;
  padded.set(await digest(padded.subarray(0, -64)), padded.length - 64);
  expect((await decodeMeshDistanceField(padded, source.meshDigest)).ok).toBe(false);
  expect(
    (await decodeMeshDistanceField(bytes.subarray(0, bytes.length - 16), source.meshDigest)).ok,
  ).toBe(false);
});
it('retains a canonical nonzero-area triangle whose old float cross cancelled to zero', async () => {
  const n = 2 ** 100,
    source = (
      await buildVisibilityDistanceField([n, n, 0, 0, 0, 0, 1, 2, 0], [0, 1, 2], {
        voxelSize: 2 ** 96,
        triangleSidedness: [1],
      })
    ).unwrap();
  expect(source.quality.testedTriangles).toBe(1);
  expect(source.surface?.primitiveOrder).toEqual(new Uint32Array([0]));
  expect(validateMeshDistanceField(source).ok).toBe(true);
});
it('reserves the shared source budget before storing unique bricks without losing deduplication', () => {
  const storage = new FieldBrickBuilder([8, 4, 4], 8 + 256),
    ones = new Float32Array(64).fill(1);
  expect(storage.store(0, ones)).toBe(true);
  expect(storage.store(1, ones)).toBe(true);
  expect(storage.finish().values.length).toBe(64);
  expect(storage.store(1, new Float32Array(64).fill(2))).toBe(false);
  expect(storage.finish().values.length).toBe(64);
  expect(new FieldBrickBuilder([4, 4, 4], -1).store(0, ones)).toBe(false);
});

it('binds direct sampled attachments to actual surface bytes before publication', async () => {
  const mesh = createPlaneGeometry(2, 2).unwrap(),
    descriptor = { sectionSidedness: [1] },
    input = meshDistanceFieldSource(mesh, descriptor).unwrap(),
    source = (
      await buildVisibilityDistanceField(input.positions, input.indices, {
        voxelSize: 0.5,
        triangleSidedness: input.triangleSidedness,
      })
    ).unwrap();
  expect((await validateMeshDistanceFieldAttachment(mesh, descriptor, source)).ok).toBe(true);
  const positions = source.surface.positions.slice(),
    flags = source.surface.triangleSidedness.slice();
  positions[0] = (positions[0] ?? NaN) * 0.5;
  flags[0] = (flags[0] ?? 0) ^ 1;
  for (const surface of [
    { ...source.surface, positions },
    { ...source.surface, triangleSidedness: flags },
  ]) {
    const forged = { ...source, surface };
    expect(validateMeshDistanceField(forged).ok).toBe(true);
    expect((await validateMeshDistanceFieldAttachment(mesh, descriptor, forged)).ok).toBe(false);
  }
});
