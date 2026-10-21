import { viewPlayPresentationPlugin } from './play-presentation.ts';
import { PRESENTATION_PLUGIN_ID } from './presentation-identity.ts';
import type { Context } from '@forgeax/engine-plugin';
import type { ViewportFrontendConfig } from './frontend.ts';
import { createNativePreviewPresentation } from '@forgeax/view-workspace-core/preview-surface';
export { PRESENTATION_PLUGIN_ID, PRESENTATION_MODULE } from './presentation-identity.ts';

/** The connection owns Play resources; page panels only borrow their placement. */
export default {
  ...viewPlayPresentationPlugin,
  name: PRESENTATION_PLUGIN_ID,
  apply(ctx: Context, config: ViewportFrontendConfig = {}) {
    viewPlayPresentationPlugin.apply(ctx, config);
    if (config.presentation?.surfacePlacement === 'owner') {
      ctx.plugin({ name: `${PRESENTATION_PLUGIN_ID}.native`, inject: ['frontendPlatform'], provide: ['viewNativePreviewPresentation'], apply(owner: Context) {
        const platform = owner.get('frontendPlatform')!;
        const adapter = createNativePreviewPresentation({ presentation: config.presentation!, client: owner.get('viewOperationClient')!,
          document: config.document ?? platform.document, window: platform.window });
        owner.provide('viewNativePreviewPresentation', adapter.presentation);
        owner.effect(() => () => adapter.dispose());
      } });
    }
  },
};
