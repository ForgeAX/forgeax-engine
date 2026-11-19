import { Inject } from '@forgeax/engine-plugin';
import type { Context, Plugin } from '@forgeax/engine-plugin';
import type { ViewFrontendConfig } from './config.ts';
import additionalPlugins from './frontend-plugins.ts';
import { viewInspectorFrontendPlugin } from '@forgeax/view-plugin-plugins/runtime';
import { createViewProductPlan, VIEW_FRONTEND_ROOT_PROGRAM, type ViewFrontendRole } from './catalog-shared.ts';
import { VIEW_PRODUCT_FRONTEND_CATALOG } from './frontend-catalog.ts';
import { viewportInputPlugin } from '@forgeax/view-plugin-viewport/input';
export { VIEW_FRONTEND_ROOT_PROGRAM } from './catalog-shared.ts';

/** Product resolution validates the admitted root against these compiled bytes. */
export async function resolveViewFrontendRoot(root: HostRootDescriptor, localConfig?: ViewFrontendConfig) {
  if (root.program !== VIEW_FRONTEND_ROOT_PROGRAM)
    throw new Error(`Unexpected View frontend root: ${root.program}`);
  if (root.codeRevision !== buildRevision)
    throw new Error(`Incompatible View frontend revision: Host ${root.codeRevision}, presentation ${buildRevision}. Rebuild the selected View package and reconnect.`);
  return createViewFrontendRoot(localConfig);
}

/** One native root for the optional View surface. The Host resolves only this program. */
export function createViewFrontendRoot(browserConfig: ViewFrontendConfig = {}) {
  return {
    name: VIEW_FRONTEND_ROOT_PROGRAM,
    async apply(ctx: Context, config: { disabledPages?: readonly string[]; frontendConfig?: ViewFrontendConfig; role?: ViewFrontendRole } = {}) {
      const role = config.role ?? 'shell';
      if (role !== 'shell' && role !== 'project-document') throw new TypeError(`Unknown View frontend role: ${String(role)}`);
      const plan = createViewProductPlan({ disabledPages: config.disabledPages, role });
      const shared = {
        ...(config.frontendConfig ?? {}),
        ...browserConfig,
        workspace: {
          ...(config.frontendConfig?.workspace ?? {}),
          ...(browserConfig.workspace ?? {}),
        },
        role,
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
        if (component === plan.frontend[0] || role === 'project-document') await fiber.await();
      }
      if (ctx.fiber.uid === null) return;
      if (role === 'project-document') {
        let started = false;
        const startProjectInput = () => {
          if (started || !ctx.get('engineWorkspacePresentation', false)) return;
          started = true;
          ctx.plugin(viewportInputPlugin, shared);
        };
        ctx.on('internal/service', (name) => {
          if (name === 'engineWorkspacePresentation') startProjectInput();
        });
        startProjectInput();
        return;
      }
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
import buildRevision from './build-identity.ts';
import type { HostRootDescriptor } from '@forgeax/engine-host/protocol';
