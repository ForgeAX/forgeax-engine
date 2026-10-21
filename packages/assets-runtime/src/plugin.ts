import type { Plugin } from '@forgeax/engine-plugin';
import type { AssetDecoderContribution } from '@forgeax/engine-types';

import type { AssetRegistry } from './asset-registry';

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    assets?: AssetRegistry;
  }
}

/** Provide the gameplay asset owner to the current Cordis realm. */
export function assetsPlugin(assets: AssetRegistry): Plugin {
  return {
    name: 'assets',
    provide: 'assets',
    apply(ctx) {
      ctx.provide('assets', assets);
    },
  };
}

/** Lease one owner decoder for the current Cordis Fiber. */
export function assetDecoderPlugin<P, K extends string>(
  contribution: AssetDecoderContribution<P, K>,
): Plugin {
  return {
    name: `asset-decoder:${contribution.kind.kind}`,
    inject: ['assets'],
    apply(ctx) {
      const assets = ctx.assets;
      if (assets === undefined) throw new Error('asset decoder plugin requires the assets service');
      ctx.effect(() => {
        const lease = assets.installDecoder(contribution.kind, contribution.decoder);
        return () => lease.dispose();
      }, `assets/decoder:${contribution.kind.kind}`);
    },
  };
}
