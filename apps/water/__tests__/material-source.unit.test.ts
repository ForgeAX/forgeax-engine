import { AssetGuid, type PackBuildReadContext } from '@forgeax/engine/pack/source';
import {
  err,
  type MaterialAsset,
  ok,
  resolveMaterialAsset,
  selectMaterialStaticContract,
} from '@forgeax/engine/types';
import { expect, it } from 'vitest';
import { resolveDemoMaterialSource } from '../material-source';

const rootGuid = '019ffa97-7000-7000-8000-000000000091';
const oceanGuid = '019ffa97-7000-7000-8000-000000000092';
const shallowNames = [
  'waterShallowGridTexture',
  'waterShallowNormalTexture',
  'waterShallowFoamTexture',
  'waterShallowMappingTexture',
];
const root: MaterialAsset = {
  kind: 'material',
  colorSpace: 'linear',
  passes: [{ name: 'forward', program: { module: 'forgeax_material::water_surface' } }],
  parameters: [
    { name: 'roughness', type: 'f32' },
    ...shallowNames.map((name) => ({ name, type: 'texture' as const })),
    { name: 'NormalDetailTex', type: 'texture' },
  ],
  values: { roughness: 0.065 },
  staticSwitches: { waterShallowSimulation: false, waterVisualNormalDetail: false },
};
const ocean: MaterialAsset = {
  kind: 'material',
  parent: rootGuid,
  values: { roughness: 0.12 },
  staticSwitches: { waterOceanFoam: true },
};

it('preserves the complete authored opt-in contract and exact inherited semantics before selection', async () => {
  const parentGuid = AssetGuid.parse(oceanGuid);
  if (!parentGuid.ok) throw parentGuid.error;
  const leaf: MaterialAsset = {
    kind: 'material',
    parent: parentGuid.value,
    staticSwitches: { waterShallowSimulation: true, waterVisualNormalDetail: true },
    values: { roughness: 0.045 },
  };
  const table = { [rootGuid]: root, [oceanGuid]: ocean, leaf };
  const before = structuredClone(table);
  const reads: string[] = [];
  const readByGuid: PackBuildReadContext['readByGuid'] = async <TAsset>(guid: AssetGuid) => {
    const key = AssetGuid.format(guid);
    reads.push(key);
    const source = table[key as keyof typeof table];
    return ok({ ...source, cooked: { obsoleteParentReceipt: true } } as TAsset);
  };
  // The runtime-selected parent is insufficient to recover enabled declarations.
  expect(selectMaterialStaticContract(root).parameters?.map((row) => row.name)).toEqual([
    'roughness',
  ]);
  const resolved = (await resolveDemoMaterialSource(leaf, readByGuid)).unwrap();
  expect(resolved).toEqual(resolveMaterialAsset('leaf', table).unwrap().asset);
  expect(resolved.parent).toBeUndefined();
  expect(resolved).not.toHaveProperty('cooked');
  expect(reads).toEqual([oceanGuid, rootGuid]);
  expect(table).toEqual(before);
  expect(selectMaterialStaticContract(resolved).parameters?.map((row) => row.name)).toEqual([
    'roughness',
    ...shallowNames,
    'NormalDetailTex',
  ]);
});

it('propagates tracked reader failure and delegates cycles to the material resolver', async () => {
  const failure = { code: 'asset-not-found', detail: 'tracked source missing' };
  const missing: PackBuildReadContext['readByGuid'] = async () => err(failure);
  expect(await resolveDemoMaterialSource(ocean, missing)).toEqual(err(failure));
  const cycle: PackBuildReadContext['readByGuid'] = async <TAsset>() =>
    ok({ kind: 'material', parent: rootGuid } as TAsset);
  const result = await resolveDemoMaterialSource(ocean, cycle);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toMatchObject({ code: 'material-circular-inheritance' });
});

it('retains roots unchanged and rejects non-material parent sources', async () => {
  const wrongKind: PackBuildReadContext['readByGuid'] = async <TAsset>() =>
    ok({ kind: 'texture' } as TAsset);
  expect((await resolveDemoMaterialSource(root, wrongKind)).unwrap()).toBe(root);
  const result = await resolveDemoMaterialSource(ocean, wrongKind);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toMatchObject({ code: 'asset-invalid-value' });
});
