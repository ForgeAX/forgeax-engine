import type { AssetGuid, MaterialAsset } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import type { AssetRegistry } from '../index.js';
import { loadMaterialReadyByGuid } from '../registry/load-by-guid.js';

declare const assets: Pick<AssetRegistry, 'loadByGuid'>;
declare const materialGuid: AssetGuid;

describe('MaterialAsset loadByGuid consumer', () => {
  it('narrows the successful load result without a cast', async () => {
    const loaded = await assets.loadByGuid<MaterialAsset>(materialGuid);
    if (!loaded.ok) return;

    expectTypeOf(loaded.value.values).toMatchTypeOf<MaterialAsset['values']>();
    expectTypeOf(loaded.value.passes).toMatchTypeOf<MaterialAsset['passes']>();
  });

  it('exposes the complete MaterialReady tuple and closed error union', async () => {
    const ready = await loadMaterialReadyByGuid(assets as AssetRegistry, {
      guid: 'material-guid',
      specializationKey: 'specialization-key',
    });
    if (ready.status === 'Ready') {
      expectTypeOf(ready.record.materialGuid).toBeString();
      expectTypeOf(ready.record.publicationGeneration).toBeNumber();
      expectTypeOf(ready.record.specializationKey).toBeString();
      expectTypeOf(ready.record.artifactDigest).toBeString();
      expectTypeOf(ready.record.sourceClosure).toEqualTypeOf<readonly string[]>();
      expectTypeOf(ready.record.parameterContract).toHaveProperty('parameters');
      return;
    }
    switch (ready.error.code) {
      case 'material-specialization-not-cooked':
      case 'asset-artifact-missing':
      case 'asset-artifact-integrity-mismatch':
      case 'material-cook-record-invalid':
      case 'material-reference-not-ready':
        return;
    }
    expectTypeOf(ready.error.code).toBeNever();
  });
});
