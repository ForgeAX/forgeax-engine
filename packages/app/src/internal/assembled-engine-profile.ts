import type { Plugin } from '@forgeax/engine-plugin';
import type { AssetRuntimeAssembly } from '../assets-runtime-assembly';
import { rendererPlugin } from '../renderer-plugin';
import {
  assetRegistryPlugin,
  assetsWorldPlugin,
  rendererAssetsPlugin,
} from './assets-world-plugin';
import type { EngineProfileBase } from './engine-profile-common';

/** Assemble-form roots plus explicitly selected host capabilities. */
export function assembledEngineProfile(
  options: EngineProfileBase & { readonly assetAssembly?: AssetRuntimeAssembly },
): Plugin[] {
  return [
    rendererPlugin(options.renderer),
    ...(options.assetAssembly === undefined
      ? [rendererAssetsPlugin(options.assets)]
      : [assetRegistryPlugin(options.assetAssembly, options.pluginPrograms, options.runtimePacks)]),
    assetsWorldPlugin(),
    ...(options.extensions ?? []),
  ];
}
