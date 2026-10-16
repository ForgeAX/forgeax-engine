import {
  type AssetRegistry,
  type CatalogSource,
  createCatalogSource,
  type PackageFetcher,
} from '@forgeax/engine-assets-runtime';
import { err, type Loader, ok, type Result, type RuntimeAssetBinding } from '@forgeax/engine-types';

/** The decoder contribution shape is the existing Loader contract, not a second facade. */
export type AssetDecoderContribution = Loader<unknown>;

/** Explicit inputs accepted by the app's Registry assembly seam. */
export interface AssetRuntimeAssemblyOptions {
  readonly registry?: AssetRegistry;
  readonly catalogSource?: CatalogSource;
  readonly fetcher?: PackageFetcher;
  readonly decoderContributions?: readonly AssetDecoderContribution[];
  readonly runtimeBinding?: RuntimeAssetBinding;
}

export interface AssetRuntimeAssemblyError {
  readonly code: 'asset-assembly-failed';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly kind: string; readonly cause: unknown };
}

export interface AssetRuntimeAssembly {
  readonly registry: AssetRegistry;
  readonly catalogSource: CatalogSource;
  readonly fetcher: PackageFetcher;
  readonly decoderContributions: readonly AssetDecoderContribution[];
  readonly ownsRegistry: boolean;
  dispose(): void;
}

export const DEFAULT_ASSET_CATALOG_URL = '/pack-index.json' as const;

function defaultAssetCatalogUrl(): string {
  return typeof document === 'undefined' || !document.baseURI
    ? DEFAULT_ASSET_CATALOG_URL
    : new URL(DEFAULT_ASSET_CATALOG_URL.slice(1), document.baseURI).href;
}

interface AssetRuntimeAssemblyInstallOptions {
  readonly catalogSource?: CatalogSource;
  readonly fetcher?: PackageFetcher;
  readonly runtimeBinding?: RuntimeAssetBinding;
  readonly ownsRegistry?: boolean;
}

function assemblyError(kind: string, cause: unknown): AssetRuntimeAssemblyError {
  return {
    code: 'asset-assembly-failed',
    expected: 'one AssetRegistry with non-conflicting decoder contributions and one catalog source',
    hint: 'inspect the Registry owner, catalog source, and decoder contribution list before retrying App assembly',
    detail: { kind, cause },
  };
}

/**
 * Build the default catalog projection explicitly. A standalone app has no
 * game-specific RuntimeAssetBinding, so its shipped catalog is relative to the
 * document base. A binding replaces it with its fenced catalog URL; realms
 * without a document base retain the root-relative default.
 */
export function createDefaultAssetCatalogSource(
  runtimeBinding?: RuntimeAssetBinding,
  packIndexUrl: string = defaultAssetCatalogUrl(),
): CatalogSource {
  const expectedScope =
    runtimeBinding === undefined
      ? undefined
      : { scopeId: runtimeBinding.scopeId, generation: runtimeBinding.generation };
  return createCatalogSource({
    url: runtimeBinding?.catalogUrl ?? packIndexUrl,
    ...(expectedScope === undefined ? {} : { expectedScope }),
  });
}

/** Install decoder contributions and make the CatalogSource part of the same lease. */
export function assembleAssetRuntime(
  registry: AssetRegistry,
  contributions: readonly AssetDecoderContribution[],
  options: AssetRuntimeAssemblyInstallOptions = {},
): Result<AssetRuntimeAssembly, AssetRuntimeAssemblyError> {
  const disposers: Array<() => void> = [];
  let catalogSource: CatalogSource | undefined;
  try {
    for (const contribution of contributions) {
      disposers.push(registry.loaders.register(contribution));
    }

    if (options.runtimeBinding !== undefined) {
      registry.configureRuntimeBinding(options.runtimeBinding);
    } else if (registry.packIndexUrl === undefined && options.catalogSource === undefined) {
      registry.configurePackIndex(defaultAssetCatalogUrl());
    }
    catalogSource =
      options.catalogSource ??
      createDefaultAssetCatalogSource(options.runtimeBinding, registry.packIndexUrl);
    registry.setCatalogSource(catalogSource, options.fetcher);
  } catch (cause) {
    for (const dispose of disposers.reverse()) dispose();
    return err(assemblyError(contributions[disposers.length]?.kind ?? 'catalog', cause));
  }

  const installedCatalogSource = catalogSource;
  const ownsRegistry = options.ownsRegistry === true;
  let disposed = false;
  return ok({
    registry,
    catalogSource: installedCatalogSource,
    fetcher: (input, init) =>
      (installedCatalogSource.openPackage?.(input) ?? options.fetcher ?? globalThis.fetch)(
        input,
        init,
      ),
    decoderContributions: Object.freeze([...contributions]),
    ownsRegistry,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers.reverse()) dispose();
      registry.clearCatalogSource();
      if (ownsRegistry) registry.invalidateAll();
    },
  });
}

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

  const contributions = options.decoderContributions ?? [];
  return assembleAssetRuntime(registry, contributions, {
    ...(options.catalogSource === undefined ? {} : { catalogSource: options.catalogSource }),
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    ...(options.runtimeBinding === undefined ? {} : { runtimeBinding: options.runtimeBinding }),
  });
}
