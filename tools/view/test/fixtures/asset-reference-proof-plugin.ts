import type { Context } from '@forgeax/engine-plugin';
import type { AssetReferenceService } from '@forgeax/view-workspace-core/asset-references';

declare global { var assetReferenceProof: AssetReferenceService | undefined; }
export default [{
  name: 'view-test:asset-reference-proof',
  inject: ['viewAssetReferences'],
  apply(ctx: Context) {
    const service = ctx.get('viewAssetReferences');
    globalThis.assetReferenceProof = service;
    ctx.effect(() => () => { if (globalThis.assetReferenceProof === service) globalThis.assetReferenceProof = undefined; });
  },
}];
