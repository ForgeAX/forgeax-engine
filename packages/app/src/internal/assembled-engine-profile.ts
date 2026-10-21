import type { Plugin } from '@forgeax/engine-plugin';
import { rendererPlugin } from '../renderer-plugin';
import { assetProfilePlugins, type EngineProfileBase } from './engine-profile-common';

/** Assemble-form roots plus explicitly selected host capabilities. */
export function assembledEngineProfile(options: EngineProfileBase): Plugin[] {
  return [
    rendererPlugin(options.renderer),
    ...assetProfilePlugins(options),
    ...(options.extensions ?? []),
  ];
}
