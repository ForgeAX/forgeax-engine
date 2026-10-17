import type { Context } from '@forgeax/engine-plugin';
import type { FrontendConfig } from '@forgeax/view-workspace-core/frontend-contract';
import type { AssetReferenceService } from '@forgeax/view-workspace-core/asset-references';
import { sameAssetReferenceScope } from '@forgeax/view-workspace-core/asset-references';
import { FRONTEND_PLUGIN_ID } from './identity.ts';
import { assetReferenceScope, createAssetReferenceSession } from './session.ts';
import assetReferenceProgram from './runtime/program.ts';

export default {
  name: FRONTEND_PLUGIN_ID,
  inject: ['viewOperationClient', 'toolApi'],
  provide: ['viewAssetReferences'],
  apply(ctx: Context, config: FrontendConfig = {}) {
    const client = ctx.get('viewOperationClient');
    const api = ctx.get('toolApi');
    if (!client || !api) return;
    const session = createAssetReferenceSession({ client, api, program: assetReferenceProgram });
    const service: AssetReferenceService = { ...session, open: async guid => {
      const scope = session.getState().scope;
      if (!scope) return Promise.reject(new Error('asset-reference-scene-unavailable'));
      const snapshot = await client.getState();
      if (!sameAssetReferenceScope(scope, assetReferenceScope(snapshot)) || !sameAssetReferenceScope(scope, session.getState().scope))
        throw new DOMException('Asset navigation scope changed', 'AbortError');
      const asset = snapshot.assets?.find(asset => asset.guid === guid);
      if (!asset) throw new Error('asset-reference-catalog-identity-unavailable');
      const pageHost = config.pageHost ?? ctx.get('pageHost', false);
      const mode = pageHost?.getAssetPresentation?.(asset);
      if (pageHost?.getAssetPresentation && mode === undefined) throw new Error('view-resource-page-unavailable');
      const detailsOnly = mode === 'details' || asset.previewable === false;
      return client.call('asset.open', { ...scope, guid, ...(detailsOnly ? { detailsOnly: true } : {}) }, { reportError: true });
    } };
    ctx.provide('viewAssetReferences', service);
    ctx.effect(() => () => session.dispose());
  },
};
