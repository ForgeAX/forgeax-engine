import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import type { MaterialAsset, MaterialRootAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { readMaterialContent } from '../internal/resolve-asset';
import { runtimeAssets } from '../internal/runtime-assets';
import { prepareRuntimeAsset } from '../runtime-asset-prepare';
import { publishRuntimeAssets } from './fixtures/runtime-publication';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();

const parentGuid = '00000000-0000-4000-8000-000000000001';
const otherGuid = '00000000-0000-4000-8000-000000000002';
const mat = (values: Partial<MaterialRootAsset> = {}): MaterialAsset => ({
  kind: 'material',
  passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
  ...values,
});
const setup = () => {
  const assets = new AssetRegistry();
  return { assets, world: new World({ assets }) };
};

describe('runtime asset reads', () => {
  it('adopts builtins through the same owner as created content', () => {
    const { assets, world } = setup();
    const reference = assets.create(BUILTIN_CUBE).unwrap();
    expect(runtimeAssets(world.assets).resolveAsset(reference).unwrap().kind).toBe('mesh');
    expect(() => runtimeAssets(new World().assets)).toThrow('runtime asset owner is required');
  });

  it('borrows owner content without retaining caller aliases', () => {
    const { assets, world } = setup();
    const input = mat({ values: { roughness: 0.5 } });
    const reference = assets.create(input).unwrap();
    const read = runtimeAssets(world.assets).resolveAsset(reference).unwrap();
    expect(read).not.toBe(input);
    expect(runtimeAssets(world.assets).resolveAsset(reference).unwrap()).toBe(read);
    expect(runtimeAssets(world.assets).resolveAsset(0).ok).toBe(false);
    expect(runtimeAssets(world.assets).resolveAsset(0xffffffff).ok).toBe(false);
  });

  it('rejects retired and foreign identities without exposing replacement content', () => {
    const { assets, world } = setup();
    const retired = assets.create(mat({ values: { amount: 1 } })).unwrap();
    assets.release(retired).unwrap();
    const replacement = assets.create(mat({ values: { amount: 2 } })).unwrap();
    expect(replacement).not.toBe(retired);
    expect(runtimeAssets(world.assets).resolveAsset(retired)).toMatchObject({
      ok: false,
      error: { code: 'asset-reference-invalid' },
    });
    expect(runtimeAssets(setup().world.assets).resolveAsset(replacement).ok).toBe(false);
    expect(readMaterialContent(runtimeAssets(world.assets), replacement).unwrap().values).toEqual({
      amount: 2,
    });
    expect(
      readMaterialContent(runtimeAssets(world.assets), assets.create(BUILTIN_CUBE).unwrap()).ok,
    ).toBe(false);
  });
});

describe('prepared material content', () => {
  it('removes disabled defaults and values before runtime admission', () => {
    const selected = prepareRuntimeAsset(
      mat({
        parameters: [
          { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
          { name: 'subsurfaceWeight', type: 'f32', default: 1 },
          { name: 'baseColorTexture', type: 'texture' },
        ],
        values: { baseColorTexture: 'inactive' },
        staticSwitches: { subsurfaceDiffusion: false, textures: false },
      }),
      () => undefined,
    ).unwrap() as MaterialAsset;
    expect(selected.parameters?.map((parameter) => parameter.name)).toEqual(['baseColor']);
    expect(selected.values).toEqual({ baseColor: [1, 1, 1, 1] });
  });

  it('preserves passes, inherited values, root defaults and child zero overrides', async () => {
    const { assets, world } = setup();
    const parent = mat({
      parameters: [
        { name: 'extra', type: 'f32' },
        { name: 'amount', type: 'f32', default: 0.7 },
        { name: 'tint', type: 'color', default: [0.5, 0.5, 0.5, 1] },
      ],
      values: { extra: 2 },
    });
    publishRuntimeAssets(assets, [
      { guid: parentGuid, asset: parent },
      {
        guid: otherGuid,
        asset: { kind: 'material', parent: parentGuid as never, values: { amount: 0 } },
        refs: [parentGuid],
      },
    ]);
    const child = (await assets.load(otherGuid, 'material')).unwrap();
    const root = (await assets.load(parentGuid, 'material')).unwrap();
    expect(readMaterialContent(runtimeAssets(world.assets), root).unwrap().values.amount).toBe(0.7);
    expect(readMaterialContent(runtimeAssets(world.assets), child).unwrap()).toMatchObject({
      passes: [{ name: 'main' }],
      values: { amount: 0, tint: [0.5, 0.5, 0.5, 1], extra: 2 },
    });
    assets.update(root, { values: { amount: 9 } }).unwrap();
    expect(readMaterialContent(runtimeAssets(world.assets), child).unwrap().values.amount).toBe(0);
    expect(parent.values).toEqual({ extra: 2 });
  });

  it.each([
    'parameters',
    'passes',
  ] as const)('rejects child %s contract overrides before creation', async (field) => {
    const { assets } = setup();
    publishRuntimeAssets(assets, [
      { guid: parentGuid, asset: mat() },
      {
        guid: otherGuid,
        refs: [parentGuid],
        asset: {
          kind: 'material',
          parent: parentGuid as never,
          [field]: field === 'passes' ? mat().passes : [{ name: 'x', type: 'f32' }],
        } as MaterialAsset,
      },
    ]);
    const result = await assets.load(otherGuid, 'material');
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'asset-package-invalid',
        detail: { reason: 'material owner validation failed' },
      },
    });
  });

  it('rejects missing parents and cycles before runtime admission', () => {
    expect(
      prepareRuntimeAsset({ kind: 'material', parent: parentGuid as never }, () => undefined),
    ).toMatchObject({ ok: false, error: { code: 'material-parent-not-found' } });
    const sources = new Map([
      [parentGuid, { kind: 'material' as const, parent: otherGuid as never }],
      [otherGuid, { kind: 'material' as const, parent: parentGuid as never }],
    ]);
    expect(
      prepareRuntimeAsset({ kind: 'material', parent: parentGuid as never }, (guid) =>
        sources.get(guid),
      ),
    ).toMatchObject({ ok: false, error: { code: 'material-circular-inheritance' } });
  });
});
