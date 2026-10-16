import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { Plugin, PluginPrograms } from '@forgeax/engine-plugin';

import type { AssetRuntimeAssembly } from '../assets-runtime-assembly';
import { assembleRuntimePacks, type RuntimePackOptions } from '../runtime-packs.js';

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    /** App-owned AssetRegistry projected into the World resource seam. */
    assets?: AssetRegistry;
  }
}

const ASSET_REGISTRY_RESOURCE_KEY = 'AssetRegistry' as const;

/** Project the Host-owned AssetRegistry as a declared dependent service. */
export function rendererAssetsPlugin(assets: AssetRegistry | undefined): Plugin {
  return {
    name: 'renderer-assets',
    inject: ['renderer'],
    provide: 'assets',
    apply(ctx) {
      if (assets !== undefined) ctx.provide('assets', assets);
    },
  };
}

/** Project the assembled Registry into the explicit Cordis service seam. */
export function assetRegistryPlugin(
  assembly: AssetRuntimeAssembly,
  programs?: PluginPrograms,
  runtimePacks?: RuntimePackOptions,
): Plugin {
  return {
    name: 'asset-registry',
    provide: [
      'assets',
      ...(programs ? ['pluginPrograms'] : []),
      ...(runtimePacks ? ['runtimePacks'] : []),
    ],
    apply(ctx) {
      if (runtimePacks && !programs)
        throw new TypeError('Runtime Pack assembly requires the realm program projection');
      ctx.provide('assets', assembly.registry);
      ctx.effect(() => () => assembly.dispose(), 'assets/registry');
      if (programs) ctx.provide('pluginPrograms', programs);
      if (runtimePacks)
        ctx.provide('runtimePacks', assembleRuntimePacks(ctx, assembly, runtimePacks));
    },
  };
}

/** Project the realm AssetRegistry into World resource lookup reversibly. */
export function assetsWorldPlugin(): Plugin {
  return {
    name: 'assets-world',
    inject: ['world', 'assets'],
    apply(ctx) {
      if (ctx.assets === undefined) return;
      ctx.effect(() => {
        ctx.world.insertResource(ASSET_REGISTRY_RESOURCE_KEY, ctx.assets);
        return () => {
          ctx.world.removeResource(ASSET_REGISTRY_RESOURCE_KEY);
        };
      }, 'assets/world-resource');
    },
  };
}
