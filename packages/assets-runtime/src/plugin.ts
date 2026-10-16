import type { Plugin } from '@forgeax/engine-plugin';
import type { Loader } from '@forgeax/engine-types';

import type { AssetRegistry } from './asset-registry';
import type { PackLoader } from './loader-registry';

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    assets?: AssetRegistry;
  }
}

/** Provide one renderer-owned asset registry to the current Cordis realm. */
export function assetsPlugin(assets: AssetRegistry): Plugin {
  return {
    name: 'assets',
    provide: 'assets',
    apply(ctx) {
      ctx.provide('assets', assets);
    },
  };
}

/** Reversibly register one runtime asset loader. */
export function assetLoaderPlugin(loader: Loader<unknown>): Plugin {
  return {
    name: `asset-loader:${loader.kind}`,
    inject: ['assets'],
    apply(ctx) {
      const assets = ctx.assets;
      if (assets === undefined) throw new Error('asset loader plugin requires the assets service');
      ctx.effect(() => assets.loaders.register(loader), `assets/loader:${loader.kind}`);
    },
  };
}

/** Reversibly register one pack loader. */
export function packLoaderPlugin(loader: PackLoader): Plugin {
  return {
    name: `pack-loader:${loader.kind}`,
    inject: ['assets'],
    apply(ctx) {
      const assets = ctx.assets;
      if (assets === undefined) throw new Error('pack loader plugin requires the assets service');
      ctx.effect(() => assets.loaders.registerPackLoader(loader), `assets/pack:${loader.kind}`);
    },
  };
}
