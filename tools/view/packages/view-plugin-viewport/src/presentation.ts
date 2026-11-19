import { viewPlayPresentationPlugin } from './play-presentation.ts';
import { PRESENTATION_PLUGIN_ID } from './presentation-identity.ts';
import type { Context } from '@forgeax/engine-plugin';
import type { ViewportFrontendConfig } from './frontend.ts';
import { createNativePreviewPresentation, createProjectDocumentFrameOwner } from '@forgeax/view-workspace-core/preview-surface';
declare module '@forgeax/engine-plugin' { interface EngineContextServices { viewProjectDocumentFrameOwner: ReturnType<typeof createProjectDocumentFrameOwner>; } }
export { PRESENTATION_PLUGIN_ID, PRESENTATION_MODULE } from './presentation-identity.ts';

/** The connection owns Play resources; page panels only borrow their placement. */
export default {
  ...viewPlayPresentationPlugin,
  name: PRESENTATION_PLUGIN_ID,
  apply(ctx: Context, config: ViewportFrontendConfig = {}) {
    if (config.role === 'project-document') {
      ctx.provide('viewPlayPresentation', { attach: () => () => {} });
      return;
    }
    viewPlayPresentationPlugin.apply(ctx, config);
    const platform = ctx.get('frontendPlatform', false);
    // An embedding Shell already occupies the Engine target document.
    const ownsProjectDocument = platform && new URL(platform.window.location.href).searchParams.has('forgeaxWorkspaceTarget');
    if (config.role === 'shell' && platform && !ownsProjectDocument) {
      ctx.plugin({ name: `${PRESENTATION_PLUGIN_ID}.native`, inject: ['frontendPlatform'], provide: ['viewNativePreviewPresentation', 'viewProjectDocumentFrameOwner'], apply(owner: Context) {
        const platform = owner.get('frontendPlatform')!;
        const client = owner.get('viewOperationClient')!;
        const frameOwner = createProjectDocumentFrameOwner({ client, platform });
        owner.provide('viewProjectDocumentFrameOwner', frameOwner);
        const adapter = createNativePreviewPresentation({ frameOwner, client,
          document: config.document ?? platform.document, window: platform.window });
        owner.provide('viewNativePreviewPresentation', adapter.presentation);
        owner.effect(() => async () => { await adapter.dispose(); await frameOwner.dispose(); });
      } });
    }
  },
};
