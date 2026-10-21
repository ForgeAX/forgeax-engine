import type { AnimationPlaybackOptions } from '@forgeax/engine-animation';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { Plugin, PluginPrograms } from '@forgeax/engine-plugin';
import type { Renderer } from '@forgeax/engine-render';
import type { AssetRuntimeAssembly } from '../assets-runtime-assembly';
import type { RuntimePackOptions } from '../runtime-packs.js';
import {
  assetRegistryPlugin,
  assetsWorldPlugin,
  rendererAssetsPlugin,
} from './assets-world-plugin';

export interface EngineProfileBase {
  readonly assetAssembly?: AssetRuntimeAssembly;
  readonly renderer: Renderer;
  readonly animation?: AnimationPlaybackOptions;
  readonly assets?: AssetRegistry;
  readonly pluginPrograms?: PluginPrograms;
  readonly runtimePacks?: RuntimePackOptions;
  readonly extensions?: readonly Plugin[];
}

/** The same asset authority and World lease are installed by every Engine profile. */
export function assetProfilePlugins(
  options: Pick<EngineProfileBase, 'assets' | 'assetAssembly' | 'pluginPrograms' | 'runtimePacks'>,
): Plugin[] {
  return [
    options.assetAssembly === undefined
      ? rendererAssetsPlugin(options.assets)
      : assetRegistryPlugin(options.assetAssembly, options.pluginPrograms, options.runtimePacks),
    assetsWorldPlugin(),
  ];
}
