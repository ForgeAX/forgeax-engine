declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): import('@forgeax/engine-app').BundlerAdapter;
}

declare module 'virtual:forgeax/pack-runtime' {
  import type { ImportTransport, RuntimeAssetBinding } from '@forgeax/engine-types';

  export const runtimeBinding: RuntimeAssetBinding | undefined;
  export function createRuntimeAssetImportTransport(
    binding?: RuntimeAssetBinding,
  ): ImportTransport | undefined;
}
