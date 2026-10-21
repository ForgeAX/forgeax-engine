import {
  buildMeshCollision,
  createBoxGeometry,
  meshAssetDecoder,
  packMeshBin,
} from '@forgeax/engine-geometry';
import { type MeshAsset, ok } from '@forgeax/engine-types';
import { expect, test } from 'vitest';

test('the runtime body-artifact loader retains the cooked collision attachment', async () => {
  const source = createBoxGeometry(2, 3, 4).unwrap();
  const mesh = { ...source, collision: buildMeshCollision(source).unwrap() };
  const bytes = packMeshBin(mesh, 'collision/box').unwrap();
  const loaded = await meshAssetDecoder.decode({
    envelope: {
      guid: '019ffa97-3000-7000-8000-000000000010',
      kind: 'mesh',
      payload: { kind: 'mesh' } as MeshAsset,
      refs: [],
      artifacts: {
        body: {
          path: 'mesh.bin',
          mediaType: 'application/octet-stream',
          byteLength: bytes.byteLength,
        },
      },
    },
    artifacts: { read: async () => ok(bytes) },
    signal: new AbortController().signal,
  });
  expect(loaded.unwrap().kind).toBe('mesh');
  expect(loaded.unwrap().collision).toEqual(mesh.collision);
});

test('inline loading refuses a stale attachment instead of repairing collision geometry', async () => {
  const source = createBoxGeometry(2, 3, 4).unwrap();
  const collision = buildMeshCollision(source).unwrap();
  collision.positions[0] = 999;
  const loaded = await meshAssetDecoder.decode({
    envelope: {
      guid: '019ffa97-3000-7000-8000-000000000010',
      kind: 'mesh',
      payload: { ...source, collision },
      refs: [],
      artifacts: {},
    },
    artifacts: { read: async () => ok(new Uint8Array()) },
    signal: new AbortController().signal,
  });
  expect(loaded.ok).toBe(false);
});
