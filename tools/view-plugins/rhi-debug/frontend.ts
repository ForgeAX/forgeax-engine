import type { Context, Plugin } from '@forgeax/engine-plugin';
import type { Dispose } from '@forgeax/view-workspace-core/frontend-contract';
/** Domain operations remain in the existing RHI viewer and RHI Debug packages. */
export default {
 name: 'forgeax.engine.view.rhi-debug',
 inject: ['pageHost', 'panelHost'],
 async apply(ctx: Context) {
  const page = ctx.pageHost;
  const node = document.createElement('section');
  node.dataset.forgeaxDiagnostic = 'rhi-debug';
  node.style.cssText = 'height:100%;min-height:0;overflow:auto';
  const unregister = page.registerType({ typeId: 'rhi-debug', context: 'artifact', title: 'RHI Debug', order: 40,
   closable: true, singleton: true, initial: true, openable: true, layout: 'surface', showPanelRail: false, hideWhenInactive: true });
  const unmount = page.mount('rhi-debug', node);
  let dispose: Dispose | undefined;
  let live = true;
  ctx.effect(() => async () => { live = false; await dispose?.(); unmount(); unregister(); });
  const mounted = await ctx.panelHost.mountPanelInto({ element: node, panel: 'RhiDebug' });
  if (live) dispose = mounted; else await mounted?.();
 },
} satisfies Plugin.Object;
