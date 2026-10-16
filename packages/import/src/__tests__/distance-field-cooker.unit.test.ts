import { decodeMeshDistanceField } from '@forgeax/engine-geometry';
import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { expect, it } from 'vitest';
import {
  createMeshDistanceFieldCooker,
  type DistanceFieldCookPayload,
} from '../distance-field-cooker';

const positions = [
  -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
];
const indices = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6,
  1, 6, 5,
];
it('derives a checked field on the source GUID and preserves lastKnownGood across failure and retry', async () => {
  const registry = new NativeCookerRegistry();
  registry.register(createMeshDistanceFieldCooker());
  const input = { meshGuid: 'source-mesh-guid', positions, indices, resolution: 12 };
  let published = 0;
  const first = (
    await registry.runTransaction<DistanceFieldCookPayload>({
      key: 'mesh-distance-field',
      input,
      publish: () => {
        published++;
      },
    })
  ).unwrap();
  expect(first.status).toBe('committed');
  expect(first.draft.guid).toBe(input.meshGuid);
  const bytes = first.draft.artifacts['distance-field.bin']?.bytes;
  expect(bytes).toBeDefined();
  if (!bytes) throw new Error('missing derived field');
  const field = (await decodeMeshDistanceField(bytes, first.draft.payload.meshDigest)).unwrap();
  expect(field.values.some((v) => v < 0)).toBe(true);
  const cold = (
    await registry.runDraft<DistanceFieldCookPayload>('mesh-distance-field', input)
  ).unwrap();
  expect(cold.inputFingerprint).toBe(first.draft.inputFingerprint);
  expect(cold.artifacts['distance-field.bin']?.bytes).toEqual(bytes);
  const failed = (
    await registry.runTransaction({
      key: 'mesh-distance-field',
      input: { ...input, indices: indices.slice(3) },
      previous: first,
      publish: () => {
        published++;
      },
    })
  ).unwrap();
  expect(failed.status).toBe('recovered');
  expect(failed.generation).toBe(first.generation);
  expect(published).toBe(1);
  const retried = (
    await registry.runTransaction({
      key: 'mesh-distance-field',
      input: { ...input, resolution: 16 },
      previous: first,
      publish: () => {
        published++;
      },
    })
  ).unwrap();
  expect(retried.status).toBe('committed');
  expect(retried.generation).toBe(2);
  expect(retried.draft.inputFingerprint).not.toBe(first.draft.inputFingerprint);
  expect(published).toBe(2);
  const changed = (
    await registry.runDraft<DistanceFieldCookPayload>('mesh-distance-field', {
      ...input,
      positions: positions.map((v) => v * 2),
    })
  ).unwrap();
  expect(changed.payload.meshDigest).not.toBe(first.draft.payload.meshDigest);
  expect((await decodeMeshDistanceField(bytes, changed.payload.meshDigest)).ok).toBe(false);
  expect((await decodeMeshDistanceField(bytes.slice(0, -4), field.meshDigest)).ok).toBe(false);
  for (const offset of [16, bytes.length - 65, bytes.length - 1]) {
    const corrupt = bytes.slice();
    corrupt[offset] = (corrupt[offset] ?? 0) ^ 1;
    expect((await decodeMeshDistanceField(corrupt, field.meshDigest)).ok).toBe(false);
  }
  expect((await decodeMeshDistanceField(new Uint8Array(), field.meshDigest)).ok).toBe(false);
  const publishFailed = (
    await registry.runTransaction({
      key: 'mesh-distance-field',
      input,
      previous: retried,
      publish: () => {
        throw new Error('disk failed');
      },
    })
  ).unwrap();
  expect(publishFailed.status).toBe('recovered');
  expect(publishFailed.generation).toBe(2);
});

it('includes two-sided policy in derived identity and preserves the geometry identity', async () => {
  const registry = new NativeCookerRegistry();
  registry.register(createMeshDistanceFieldCooker());
  const input = { meshGuid: 'mesh', positions, indices, resolution: 12 };
  const signed = (
    await registry.runDraft<DistanceFieldCookPayload>('mesh-distance-field', input)
  ).unwrap();
  const two = (
    await registry.runDraft<DistanceFieldCookPayload>('mesh-distance-field', {
      ...input,
      twoSided: true,
    })
  ).unwrap();
  expect(two.payload.meshDigest).toBe(signed.payload.meshDigest);
  expect(two.inputFingerprint).not.toBe(signed.inputFingerprint);
  expect(two.payload.policy).toBe('two-sided');
  const bytes = two.artifacts['distance-field.bin']?.bytes;
  if (!bytes) throw new Error('missing field');
  const loaded = (await decodeMeshDistanceField(bytes, two.payload.meshDigest)).unwrap();
  expect(loaded.policy.kind).toBe('two-sided');
  expect(loaded.values.every((v) => v >= 0)).toBe(true);
  expect(loaded.quality.negativeSamples).toBe(0);
});

it('publishes visibility through the same GUID and invalidates on triangle policy changes', async () => {
  const registry = new NativeCookerRegistry();
  registry.register(createMeshDistanceFieldCooker());
  const input = {
    meshGuid: 'visibility-mesh',
    positions,
    indices,
    policy: 'sampled-visibility',
    voxelSize: 0.5,
    triangleSidedness: Array(12).fill(0),
  };
  const first = (
    await registry.runDraft<DistanceFieldCookPayload>('mesh-distance-field', input)
  ).unwrap();
  expect(first.guid).toBe(input.meshGuid);
  expect(first.payload.policy).toBe('sampled-visibility');
  const second = (
    await registry.runDraft<DistanceFieldCookPayload>('mesh-distance-field', {
      ...input,
      triangleSidedness: Array(12).fill(1),
    })
  ).unwrap();
  expect(second.payload.meshDigest).toBe(first.payload.meshDigest);
  expect(second.inputFingerprint).not.toBe(first.inputFingerprint);
  const bytes = second.artifacts['distance-field.bin']?.bytes;
  assertBytes(bytes);
  const decoded = (await decodeMeshDistanceField(bytes, second.payload.meshDigest)).unwrap();
  expect(decoded.policy.kind).toBe('sampled-visibility');
  expect(decoded.quality.negativeSamples).toBe(0);
});

function assertBytes(bytes: Uint8Array | undefined): asserts bytes is Uint8Array {
  if (!bytes) throw new Error('missing distance-field artifact');
}
