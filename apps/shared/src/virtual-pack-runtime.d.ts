declare module 'virtual:forgeax/pack-runtime' {
  import type { ImportTransport, RuntimeAssetBinding } from '@forgeax/engine-types';

  const runtimeBinding: RuntimeAssetBinding | undefined;
  const createRuntimeAssetImportTransport: (
    binding?: RuntimeAssetBinding,
  ) => ImportTransport | undefined;

  export { createRuntimeAssetImportTransport, runtimeBinding };
}
