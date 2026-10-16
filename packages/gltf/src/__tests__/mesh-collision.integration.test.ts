import { decodeMeshBinary } from '@forgeax/engine-geometry';
import { ImporterRegistry, runImport } from '@forgeax/engine-import';
import { expect, test } from 'vitest';
import { gltfImporter } from '../gltf-importer';

async function produce(setting: unknown) {
  const positions = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]);
  const source = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: '2.0' },
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [
        {
          byteLength: positions.byteLength,
          uri: `data:application/octet-stream;base64,${Buffer.from(positions.buffer).toString('base64')}`,
        },
      ],
      bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    }),
  );
  const registry = new ImporterRegistry();
  registry.register(gltfImporter);
  return runImport(
    {
      importer: 'gltf',
      source: 'collision.gltf',
      importSettings: { meshCollision: setting },
      subAssets: [
        {
          guid: '11111111-1111-4111-8111-111111111111',
          sourceIndex: 0,
          sourceKey: 'mesh:collision',
          kind: 'mesh',
        },
      ],
    },
    registry,
    { readSource: async () => ({ ok: true as const, value: source }) },
  );
}

test('G28 glTF source Meta cooks collision on the same GUID and portable body', async () => {
  const enabledResult = await produce(true),
    disabledResult = await produce(false);
  if (!enabledResult.ok) throw enabledResult.error;
  if (!disabledResult.ok) throw disabledResult.error;
  const enabled = enabledResult.value,
    disabled = disabledResult.value;
  if ('skipped' in enabled || 'skipped' in disabled) throw new Error('expected imported mesh');
  expect(enabled.pack.assets.map((asset) => asset.guid)).toEqual(
    disabled.pack.assets.map((asset) => asset.guid),
  );
  const asset = enabled.pack.assets[0];
  if (!asset?.artifacts.body) throw new Error('missing cooked mesh');
  const mesh = decodeMeshBinary(asset.artifacts.body.bytes, []);
  expect(mesh?.collision?.positions.length).toBe(9);
  expect(mesh?.collision?.indices.length).toBe(3);
  expect(disabled.pack.assets[0]?.payload.collision).toBeUndefined();
  expect((await produce('guess')).ok).toBe(false);
});
