import { Inject } from '@forgeax/engine-plugin';
import type { Context, Plugin } from '@forgeax/engine-plugin';
import type { ViewFrontendConfig } from './config.ts';
import additionalPlugins from './frontend-plugins.ts';
import { viewInspectorFrontendPlugin } from '@forgeax/view-plugin-plugins/runtime';
import { createViewProductPlan, VIEW_FRONTEND_ROOT_PROGRAM } from './catalog-shared.ts';
import { VIEW_PRODUCT_FRONTEND_CATALOG } from './frontend-catalog.ts';
export { VIEW_FRONTEND_ROOT_PROGRAM } from './catalog-shared.ts';

/** One native root for the optional View surface. The Host resolves only this program. */
export function createViewFrontendRoot(browserConfig: ViewFrontendConfig = {}) {
  return {
    name: VIEW_FRONTEND_ROOT_PROGRAM,
    async apply(ctx: Context, config: { disabledPages?: readonly string[]; frontendConfig?: ViewFrontendConfig } = {}) {
      const plan = createViewProductPlan({ disabledPages: config.disabledPages });
      const shared = {
        ...(config.frontendConfig ?? {}),
        ...browserConfig,
        workspace: {
          ...(config.frontendConfig?.workspace ?? {}),
          ...(browserConfig.workspace ?? {}),
        },
      };
      const deferred: Plugin.Object<ViewFrontendConfig>[] = [];
      for (const component of plan.frontend) {
        const record = VIEW_PRODUCT_FRONTEND_CATALOG.get(component.module);
        if (!record) throw new Error(`View frontend program is missing: ${component.module}`);
        const { default: plugin } = await record.load();
        if (ctx.fiber.uid === null) return;
        if (shared.embedded && !shared.presentation && !shared.targetPresentation && record.requiresWorkspacePresentation) {
          deferred.push(plugin);
          continue;
        }
        // Cordis fibers are thenable. Starting the page plugins must not await
        // their injection of Engine's presentation, which is supplied only
        // after the frontend root activates and the App bootstrap begins.
        const fiber = ctx.plugin(plugin, shared);
        if (component === plan.frontend[0]) await fiber.await();
      }
      if (ctx.fiber.uid === null) return;
      ctx.plugin(viewInspectorFrontendPlugin, shared);
      for (const plugin of additionalPlugins) ctx.plugin(plugin, shared);
      if (deferred.length) {
        let started = false;
        const startPresentationPages = () => {
          if (started || !ctx.get('engineWorkspacePresentation')) return;
          started = true;
          for (const plugin of deferred) ctx.plugin({
            ...plugin,
            inject: { ...Inject.resolve(plugin.inject), engineWorkspacePresentation: null },
          }, shared);
        };
        ctx.on('internal/service', (name) => {
          if (name === 'engineWorkspacePresentation') startPresentationPages();
        });
        startPresentationPages();
      }
    },
  };
}

export default createViewFrontendRoot();
