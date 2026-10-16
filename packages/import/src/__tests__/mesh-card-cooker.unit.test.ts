import { decodeMeshCardLayout } from '@forgeax/engine-geometry';
import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { expect, it } from 'vitest';
import { createMeshCardCooker, type MeshCardCookPayload } from '../mesh-card-cooker';

it('retains source GUID, publishes card settings revisions and preserves LKG after rejected cook', async () => {
  const registry = new NativeCookerRegistry();
  registry.register(createMeshCardCooker());
  const input = {
    meshGuid: 'source-mesh-guid',
    positions: [-1, -1, 0, 1, -1, 0, -1, 1, 0],
    indices: [0, 1, 2],
  };
  let publications = 0;
  const publish = () => {
    publications++;
  };
  const first = (
    await registry.runTransaction<MeshCardCookPayload>({ key: 'mesh-card-layout', input, publish })
  ).unwrap();
  expect(first.status).toBe('committed');
  expect(first.draft.guid).toBe(input.meshGuid);
  expect(first.draft.inputFingerprint).toMatch(/^mesh-card-layout:5:/);
  const bytes = first.draft.artifacts['mesh-cards.json']?.bytes;
  if (!bytes) throw new Error('Missing cooked card layout');
  expect(decodeMeshCardLayout(bytes, first.draft.payload.meshDigest).unwrap().cards).toHaveLength(
    1,
  );
  const cold = (await registry.runDraft<MeshCardCookPayload>('mesh-card-layout', input)).unwrap();
  expect(cold.inputFingerprint).toBe(first.draft.inputFingerprint);
  expect(cold.artifacts['mesh-cards.json']?.bytes).toEqual(bytes);
  const failed = (
    await registry.runTransaction({
      key: 'mesh-card-layout',
      input: { ...input, indices: [0, 0, 0] },
      previous: first,
      publish,
    })
  ).unwrap();
  expect(failed.status).toBe('recovered');
  expect(failed.generation).toBe(first.generation);
  expect(publications).toBe(1);
  const changed = (
    await registry.runTransaction<MeshCardCookPayload>({
      key: 'mesh-card-layout',
      input: { ...input, triangleSidedness: new Uint8Array(input.indices.length / 3).fill(1) },
      previous: first,
      publish,
    })
  ).unwrap();
  expect(changed.status).toBe('committed');
  expect(changed.generation).toBe(2);
  expect(changed.draft.inputFingerprint).not.toBe(first.draft.inputFingerprint);
  expect(changed.draft.payload.meshDigest).toBe(first.draft.payload.meshDigest);
  expect(publications).toBe(2);
});
