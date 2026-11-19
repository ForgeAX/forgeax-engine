import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AssetGuid } from '@forgeax/engine-pack/source';
import { loadScriptablePack } from '@forgeax/engine-pack/source-node';
import { expect, it } from 'vitest';

it('cooks the lake starter and resolves its published project root', async () => {
  const example = resolve(import.meta.dirname, '../../../water/examples/lake');
  const manifest = JSON.parse(await readFile(resolve(example, 'forge.json'), 'utf8'));
  const source = 'assets/lake/lake.pack.ts';
  expect(manifest.assetRoots).toContain('assets/lake');
  expect(manifest.assetLibraries).toContain('@forgeax/engine/content');
  const pack = (await loadScriptablePack(resolve(example, source))).unwrap();
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(pack.packageId, key));
  const result = await pack.build({
    packageId: pack.packageId,
    values: {},
    readByGuid: async () => {
      throw new Error('The lake starter should only reference stock materials by GUID');
    },
  });
  if (!result.ok) throw result.error;

  expect(manifest.roots.engine).toBe(guid('plugin/engine'));
  expect(result.value['plugin/engine']).toMatchObject({
    kind: 'plugin',
    config: { scene: { $asset: guid('scene/lake') } },
  });
  expect(result.value['scene/lake']).toMatchObject({
    kind: 'scene',
    entities: {
      zone: { components: { WaterZoneInstance: { zone: guid('zone/lake') } } },
      lake: { components: { WaterBodyInstance: { body: guid('body/lake') } } },
    },
  });
  expect(result.value['body/lake']).toMatchObject({
    kind: 'water-body',
    type: 'lake',
    zoneGuid: guid('zone/lake'),
    waveSetGuid: guid('waves/lake'),
    waterInfoMeshGuid: expect.any(String),
  });
  expect(result.value['waves/lake']).toMatchObject({
    kind: 'water-wave-set',
    timeSource: 'scene-clock',
  });
}, 30_000);
