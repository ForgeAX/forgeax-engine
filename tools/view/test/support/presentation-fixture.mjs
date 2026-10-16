import { Context } from '@forgeax/engine-plugin';
import { createViewFrontendRoot } from '../../packages/viewer/src/frontend-root.ts';
import { VIEW_PRODUCT_FRONTEND_CATALOG } from '../../packages/viewer/src/frontend-catalog.ts';
import { applyResourcePagePlugin } from '../../packages/view-workspace-core/src/resource-page.ts';
import * as mesh from '../../packages/view-plugin-mesh/src/identity.ts';
import * as viewportIdentity from '../../packages/view-plugin-viewport/src/identity.ts';
import viewport from '../../packages/view-plugin-viewport/src/frontend.ts';

export function presentationFixture() {
  const ctx = new Context();
  const fibers = [];
  const pages = new Set();
  let mounts = 0, unmounts = 0, claims = 0, releases = 0;
  ctx.on('internal/plugin', fiber => { if (!fibers.includes(fiber)) fibers.push(fiber); });
  ctx.provide('viewOperationClient', {});
  ctx.provide('viewScenePage', {});
  ctx.provide('viewPlayPresentation', {});
  const config = {
    embedded: true, document: {},
    pageHost: { registerType({ typeId }) {
      pages.add(typeId);
      return () => pages.delete(typeId);
    } },
    panelHost: {
      claim() { claims++; return () => { releases++; }; },
      async mountPanel() { mounts++; return () => { unmounts++; }; },
    },
  };
  const saved = new Map(VIEW_PRODUCT_FRONTEND_CATALOG);
  for (const [name, record] of saved) {
    const plugin = name === mesh.FRONTEND_MODULE ? {
      name: mesh.FRONTEND_PLUGIN_ID,
      inject: ['viewOperationClient'],
      apply: (inner, options) => applyResourcePagePlugin(inner, options, mesh),
    } : name === viewportIdentity.FRONTEND_MODULE ? viewport : { name, apply() {} };
    VIEW_PRODUCT_FRONTEND_CATALOG.set(name, {
      ...record,
      requiresWorkspacePresentation: name === mesh.FRONTEND_MODULE,
      load: async () => ({ default: plugin }),
    });
  }
  return {
    ctx, fibers, config, root: createViewFrontendRoot(config), pages,
    pageType: mesh.PAGE_TYPE, childName: mesh.FRONTEND_PLUGIN_ID,
    counts: () => ({ mounts, unmounts, claims, releases }),
    async dispose() {
      try { await ctx.fiber.dispose(); }
      finally {
        VIEW_PRODUCT_FRONTEND_CATALOG.clear();
        for (const [name, record] of saved) VIEW_PRODUCT_FRONTEND_CATALOG.set(name, record);
      }
    },
  };
}

export const surfaces = f => f.fibers.filter(fiber => fiber.runtime.name === f.childName);
export async function providePresentation(ctx, name) {
  const fiber = ctx.plugin({ name, apply(inner) { inner.provide('engineWorkspacePresentation', {}); } });
  await fiber.await();
  return fiber;
}
