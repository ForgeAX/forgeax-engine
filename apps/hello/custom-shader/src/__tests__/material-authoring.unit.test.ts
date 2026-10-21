import { type AssetRegistry } from '@forgeax/engine-assets-runtime';
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

type MaterialLoader = AssetRegistry;

async function readLoadedMaterial(loader: MaterialLoader, guid: AssetGuid): Promise<void> {
  const loaded = await loader.load(guid, 'material');
  if (loaded.ok) {
    const material = loader.read(loaded.value).unwrap();
    expectTypeOf(material.parameters).toEqualTypeOf<MaterialAsset['parameters']>();
    expectTypeOf(material.values).toEqualTypeOf<MaterialAsset['values']>();
    expectTypeOf(material.passes).toEqualTypeOf<MaterialAsset['passes']>();
    loader.release(loaded.value).unwrap();
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
