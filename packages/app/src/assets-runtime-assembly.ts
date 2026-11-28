import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defaultAssetDecoderContributions } from '@forgeax/engine-runtime';
import { err, type Result } from '@forgeax/engine-types';
import {
  type AssetRuntimeAssembly,
  type AssetRuntimeAssemblyError,
  type AssetRuntimeAssemblyOptions,
  assembleAssetRuntime,
  assemblyError,
} from './asset-runtime-catalog';

export {
  type AssetDecoderContributionRef,
  type AssetRuntimeAssembly,
  type AssetRuntimeAssemblyError,
  type AssetRuntimeAssemblyOptions,
  assembleAssetRuntime,
  createDefaultAssetCatalogSource,
  DEFAULT_ASSET_CATALOG_URL,
} from './asset-runtime-catalog';

/**
 * Resolve the one Registry for an App. Runtime Host construction already owns
 * an AssetRegistry and passes it through the Host assembly result. Supplying a
 * different Registry is rejected because this branch cannot make the renderer
 * consume two owners atomically.
 */
export function createAssetRuntimeAssembly(
  rendererAssets: AssetRegistry | undefined,
  options: AssetRuntimeAssemblyOptions = {},
): Result<AssetRuntimeAssembly, AssetRuntimeAssemblyError> {
  if (
    rendererAssets !== undefined &&
    options.registry !== undefined &&
    rendererAssets !== options.registry
  ) {
    return err(
      assemblyError(
        'registry',
        new TypeError(
          'Renderer host already owns a different AssetRegistry; this App cannot be assembled with two registry owners',
        ),
      ),
    );
  }

  const registry = options.registry ?? rendererAssets;
  if (registry === undefined) {
    return err(
      assemblyError(
        'registry',
        new TypeError(
          'AssetRuntimeAssembly requires an AssetRegistry from the renderer host or App options',
        ),
      ),
    );
  }

  const contributions = [
    ...defaultAssetDecoderContributions,
    ...(options.decoderContributions ?? []),
  ];
  return assembleAssetRuntime(registry, contributions, {
    ...(options.catalogSource === undefined ? {} : { catalogSource: options.catalogSource }),
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    ...(options.runtimeBinding === undefined ? {} : { runtimeBinding: options.runtimeBinding }),
    catalogOwner: options.catalogOwner,
  });
}
