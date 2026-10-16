import { createBoxGeometry } from '@forgeax/engine/geometry';
import { createStandardAssetOutputProducerRegistry } from '@forgeax/engine/import';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import type { AssetGuid as AssetGuidType, MaterialAsset, MeshAsset } from '@forgeax/engine/types';
import { ok } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

function guid(value: string): AssetGuidType {
  const parsed = AssetGuid.parse(value);
  return (parsed.ok ? parsed.value : AssetGuid.random()) as unknown as AssetGuidType;
}

const MATERIAL = '019ffa97-3000-7000-8000-000000000001';
const PARENT = '019ffa97-3000-7000-8000-000000000002';
const TEXTURE = '019ffa97-3000-7000-8000-000000000003';

export default defineFeature({
  title: 'Asset output producers',
  catalog: 'Asset output producers',
  kind: 'headless',
  summary:
    'An injected AssetOutputProducerRegistry turns ScriptablePack outputs into payload + refs + artifacts per kind.',
  expect:
    'Mesh/material producers emit refs with sourceField provenance; a custom kind can be registered next to them.',
  async run(checks) {
    const registry = createStandardAssetOutputProducerRegistry();
    for (const kind of ['mesh', 'material', 'scene', 'texture'])
      checks.ok(`standard registry has ${kind} producer`, registry.get(kind) !== undefined);

    const mesh: MeshAsset = {
      ...createBoxGeometry(1, 1, 1).unwrap(),
      materialSlots: [{ slotName: 'Shell', sourceKey: 'shell', defaultMaterial: guid(MATERIAL) }],
    };
    const meshProduct = await registry.get('mesh')?.produce({
      guid: '019ffa97-3000-7000-8000-000000000010',
      sourceKey: 'geometry/shell',
      asset: mesh,
    });
    checks.ok('mesh producer succeeds', meshProduct?.ok === true);
    if (meshProduct?.ok === true) {
      checks.equal('mesh refs record the material slot provenance', meshProduct.value.refs, [
        { guid: MATERIAL, sourceField: { fieldName: 'materialSlots', arrayIndex: 0 } },
      ]);
      checks.equal(
        'mesh bytes go to a binary artifact',
        meshProduct.value.artifacts.body?.mediaType,
        'application/x-forgeax-mesh',
      );
    }

    const material: MaterialAsset = {
      kind: 'material',
      parent: guid(PARENT),
      values: { baseColorTexture: { texture: guid(TEXTURE) } },
    };
    const materialProduct = await registry
      .get('material')
      ?.produce({ guid: MATERIAL, sourceKey: 'material/shell', asset: material });
    checks.ok('material producer succeeds', materialProduct?.ok === true);
    if (materialProduct?.ok === true) {
      checks.equal(
        'material refs list parent then texture slot',
        materialProduct.value.refs.map((ref) => ref.guid),
        [PARENT, TEXTURE],
      );
    }

    registry.register({
      kind: 'lab-note',
      version: '1',
      produce: (input) =>
        ok({
          payload: input.asset as never,
          refs: [],
          artifacts: {},
          inputFingerprint: `lab:${input.sourceKey}`,
        }),
    });
    checks.equal(
      'custom producer is injected, not hardcoded',
      registry.versions()['lab-note'],
      '1',
    );
    const custom = await registry
      .get('lab-note')
      ?.produce({ guid: MATERIAL, sourceKey: 'notes/a', asset: { kind: 'lab-note' } as never });
    checks.equal(
      'custom producer records its fingerprint',
      custom?.ok === true ? custom.value.inputFingerprint : undefined,
      'lab:notes/a',
    );
  },
});
