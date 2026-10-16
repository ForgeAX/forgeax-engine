declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): import('@forgeax/engine/runtime').BundlerOptions;
}
declare module 'virtual:forgeax/pack-runtime' {
  export const runtimeBinding: import('@forgeax/engine/types').RuntimeAssetBinding | undefined;
  export function createRuntimeAssetImportTransport(
    binding?: import('@forgeax/engine/types').RuntimeAssetBinding,
  ): import('@forgeax/engine/types').ImportTransport | undefined;
}
