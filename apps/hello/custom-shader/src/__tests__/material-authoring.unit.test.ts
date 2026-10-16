import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AssetGuid, MaterialAsset, MaterialTextureValue } from '@forgeax/engine-types';

function authoredMaterial(texture: AssetGuid, sampler: AssetGuid): MaterialAsset {
  const authoredLiteral = {
    kind: 'material',
    parameters: [{ name: 'baseColorTexture', type: 'texture', optional: true }],
    values: {
      baseColorTexture: {
        texture,
        sampler,
        coordinates: { set: 1, transform: { offset: [0.1, 0.2], scale: [2, 2], rotation: 0.25 } },
      },
    },
  } satisfies MaterialAsset;
  return authoredLiteral;
}

type MaterialLoader = {
  loadByGuid<T>(guid: AssetGuid): Promise<{ ok: true; value: T } | { ok: false; error: unknown }>;
};

async function readLoadedMaterial(loader: MaterialLoader, guid: AssetGuid): Promise<void> {
  const loaded = await loader.loadByGuid<MaterialAsset>(guid);
  if (loaded.ok) {
    expectTypeOf(loaded.value.parameters).toEqualTypeOf<MaterialAsset['parameters']>();
    expectTypeOf(loaded.value.values).toEqualTypeOf<MaterialAsset['values']>();
    expectTypeOf(loaded.value.passes).toEqualTypeOf<MaterialAsset['passes']>();
  }
}

describe('custom-shader MaterialAsset author/load surface', () => {
  it('accepts authored literals and preserves structured texture values', () => {
    expectTypeOf(authoredMaterial).toEqualTypeOf<
      (texture: AssetGuid, sampler: AssetGuid) => MaterialAsset
    >();
    expectTypeOf(readLoadedMaterial).toEqualTypeOf<
      (loader: MaterialLoader, guid: AssetGuid) => Promise<void>
    >();
    expectTypeOf<MaterialTextureValue['coordinates']>().toMatchTypeOf<
      | { readonly set?: number; readonly transform?: object }
      | undefined
    >();
    expect(true).toBe(true);
  });
});
