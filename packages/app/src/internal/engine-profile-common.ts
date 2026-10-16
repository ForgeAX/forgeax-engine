import type { AnimationPlaybackOptions } from '@forgeax/engine-animation';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { Plugin, PluginPrograms } from '@forgeax/engine-plugin';
import type { Renderer } from '@forgeax/engine-render';
import type { RuntimePackOptions } from '../runtime-packs.js';

export interface EngineProfileBase {
  readonly renderer: Renderer;
  readonly animation?: AnimationPlaybackOptions;
  readonly assets?: AssetRegistry;
  readonly pluginPrograms?: PluginPrograms;
  readonly runtimePacks?: RuntimePackOptions;
  readonly extensions?: readonly Plugin[];
}
