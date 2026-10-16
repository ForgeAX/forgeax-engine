import type { Context, Plugin } from '@forgeax/engine-plugin';
import type { Dispose } from '@forgeax/view-workspace-core/frontend-contract';
import { buildProfileModel, validateProfileCapture } from '@forgeax/engine-profiler';
export default {
 name: 'forgeax.engine.view.profiler',
 inject: ['pageHost', 'panelHost'],
 async apply(ctx: Context) {
  const page = ctx.pageHost;
  const node = document.createElement('section');
  node.dataset.forgeaxDiagnostic = 'profiler';
  node.style.cssText = 'height:100%;min-height:0;overflow:auto';
  const unregister = page.registerType({ typeId: 'profiler', context: 'artifact', title: 'CPU Profiler', order: 30,
   closable: true, singleton: true, initial: true, openable: true, layout: 'surface', showPanelRail: false, hideWhenInactive: true });
  const unmount = page.mount('profiler', node);
  let dispose: Dispose | undefined;
  let live = true;
  ctx.effect(() => async () => { live = false; await dispose?.(); unmount(); unregister(); });
  const mounted = await ctx.panelHost.mountPanelInto({ element: node, panel: 'Profiler', props: {
   readCapture(bytes: string) {
    const capture = JSON.parse(bytes);
    const result = validateProfileCapture(capture);
    return result.ok ? buildProfileModel(result.value) : result;
   },
  } });
  if (live) dispose = mounted; else await mounted?.();
 },
} satisfies Plugin.Object;
