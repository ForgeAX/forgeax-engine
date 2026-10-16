import type { AssetRegistry, CatalogSource } from '@forgeax/engine-assets-runtime';
import type { EngineContextServices } from '@forgeax/engine-plugin';
import type { Loader, RuntimeAssetBinding } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';

import type { App, AppAssembleArgs, CreateAppOptions } from '../index';

describe('App Registry assembly types', () => {
  it('exposes one required AssetRegistry on App', () => {
    expectTypeOf<App['assets']>().toEqualTypeOf<AssetRegistry | undefined>();
  });

  it('projects the one AssetRegistry through the App context service', () => {
    expectTypeOf<EngineContextServices['assets']>().toEqualTypeOf<AssetRegistry | undefined>();
  });

  it('accepts only explicit Registry, catalog, binding, and decoder contributions', () => {
    expectTypeOf<AppAssembleArgs['assets']>().toEqualTypeOf<AssetRegistry | undefined>();
    expectTypeOf<CreateAppOptions['assets']>().toEqualTypeOf<AssetRegistry | undefined>();
    expectTypeOf<CreateAppOptions['assetCatalog']>().toEqualTypeOf<CatalogSource | undefined>();
    expectTypeOf<CreateAppOptions['assetDecoders']>().toEqualTypeOf<
      readonly Loader<unknown>[] | undefined
    >();
    expectTypeOf<CreateAppOptions['assetRuntimeBinding']>().toEqualTypeOf<
      RuntimeAssetBinding | undefined
    >();
  });
});
