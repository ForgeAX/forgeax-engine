import type { AssetHandle, MaterialAsset } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import type { AssetRegistry } from '../index.js';

declare const assets: Pick<AssetRegistry, 'load' | 'read'>;
declare const materialGuid: string;

describe('Material asset owner consumer', () => {
  it('narrows the loaded handle and copied payload without casts', async () => {
    const loaded = await assets.load(materialGuid, 'material');
    if (!loaded.ok) return;
    expectTypeOf(loaded.value).toEqualTypeOf<AssetHandle<'material'>>();
    const read = assets.read(loaded.value);
    if (!read.ok) return;
    expectTypeOf(read.value).toEqualTypeOf<MaterialAsset>();
    expectTypeOf(read.value.values).toMatchTypeOf<MaterialAsset['values']>();
    expectTypeOf(read.value.passes).toMatchTypeOf<MaterialAsset['passes']>();
  });
});
