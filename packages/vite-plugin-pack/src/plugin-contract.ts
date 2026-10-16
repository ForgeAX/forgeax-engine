import type { ProducerReadiness } from '@forgeax/engine-import';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import type { Importer, PackIndexEntry, RuntimeAssetBinding } from '@forgeax/engine-types';
import type { Plugin } from 'vite';

interface AssetHostRefreshServer {
  readonly ws?: { send(payload: { type: 'full-reload' }): void } | undefined;
}

export type AssetHostRefreshPolicy = (server: AssetHostRefreshServer) => void;

/**
 * Vite Pack producer plus the host-control seam used by dynamic game hosts.
 * The runtime binding is read-only from the consumer side; `rebind` remains
 * the sole owner operation that changes the active catalog scope.
 */
export type PluginPack = Plugin & {
  readonly readPluginDefinitions: () => Promise<
    readonly {
      readonly definition: import('@forgeax/engine-types').PluginAssetDefinition;
      readonly sourcePath: string;
      readonly refs: readonly string[];
    }[]
  >;
  readonly catalogSnapshot: () => readonly PackIndexEntry[];
  readonly runtimeBinding: () => RuntimeAssetBinding | undefined;
  /**
   * Resolve the first accepted dev Catalog generation. Vite does not wait for
   * async work started by `configureServer`, so DevKit's live host uses this
   * fence before it admits a browser page. Build/preview callers can ignore
   * it because they never consume the dev transport.
   */
  readonly ready: () => Promise<void>;
  readonly rebind: (
    binding: RuntimeAssetBinding,
    roots: readonly string[],
    projectDdcRoot?: string,
  ) => Promise<RuntimeAssetBinding>;
  /**
   * Rebuild the serving catalog projection and emit `forgeax:catalog-delta`
   * without a page reload or a new executable session. Allowed while `watch`
   * is false. Returns whether an authoritative delta was published.
   */
  readonly rebuildCatalogInPlace: (filenames: readonly string[]) => Promise<boolean>;
};

/** Public plugin inputs; execution owners remain in engine-pack/import/ddc. */
export interface PluginPackOptions {
  readonly roots?: readonly string[] | undefined;
  /** Take the first inventory's captured bytes once; later generations read fresh disk. */
  readonly takeInitialSourceSnapshot?: () =>
    | import('@forgeax/engine-pack/source-node').ScriptablePackSourceSnapshot
    | undefined;
  readonly producerReadiness?: ProducerReadiness | undefined;
  readonly importers?: readonly Importer[] | undefined;
  readonly cookers?: readonly NativeCooker[] | undefined;
  readonly refresh?: AssetHostRefreshPolicy | undefined;
  /** False keeps this catalog session fixed; the host replaces the entire session on edits. */
  readonly watch?: boolean;
  /** Host-owned source filter shared by build and dev catalog scans. */
  readonly ignorePath?: ((path: string) => boolean) | undefined;
  /**
   * Host-owned projection from physical source paths to stable logical
   * identities. This keeps catalog/publication facts portable across Vite
   * symlink farms while file reads continue to use physical paths.
   */
  readonly sourceIdentityFor?: ((sourcePath: string) => string) | undefined;
  readonly runtimeBinding?: RuntimeAssetBinding;
  readonly ddc?: PluginPackDdcOptions;
}

export interface PluginPackDdcOptions {
  readonly buildCacheRoot?: string | undefined;
  readonly projectDdcRoot?: string | undefined;
}

/** Internal fixture seams; the public Vite contract does not expose these owners. */
export interface PluginPackInternalOptions extends PluginPackOptions {
  readonly transportBase?: string | undefined;
}
