import { createBoxGeometry, decodeMeshBinary } from '@forgeax/engine-geometry';
import { expect, test } from 'vitest';
import { cookMeshCollision } from '../mesh-collision';
import { meshAssetOutputProducer } from '../scriptable-pack-output-producers';

test('G28 ScriptablePack producer preserves GUID, refs, and portable collision geometry', async () => {
  const source = createBoxGeometry(2, 3, 4).unwrap();
  expect(cookMeshCollision(source, false).unwrap()).toBe(source);
  expect(cookMeshCollision(source, 'trimesh').ok).toBe(false);
  const mesh = cookMeshCollision(source, true).unwrap();
  const guid = '019ffa97-3000-7000-8000-000000000010';
  const product = (
    await meshAssetOutputProducer.produce({ guid, sourceKey: 'collision/box', asset: mesh })
  ).unwrap();
  expect(product.refs).toEqual([]);
  const body = product.artifacts.body;
  if (!body) throw new Error('missing mesh artifact');
  const decoded = decodeMeshBinary(body.bytes, []);
  if (!decoded) throw new Error('collision mesh failed decode');
  expect(decoded.collision).toEqual(mesh.collision);
});
