import type { Context, Plugin } from '@forgeax/engine-plugin';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { VIEW_FILE_GET_SERVICE, VIEW_PACK_SOURCES_SERVICE } from '@forgeax/view-workspace-core/contract';
import type { Dispose, FrontendConfig } from '@forgeax/view-workspace-core/frontend-contract';
import { createPackAuthoringClient } from '@forgeax/view-workspace-core/pack-authoring';
import { createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { type ModelingContext, type ModelingHost, modelingOperations, projectRelative } from './model.ts';

/**
 * The human modeling window (design 12) as a project page: checkpoints, parameter
 * sliders over the existing Pack draft, and picks turned into selector expressions by
 * `model.synthesize`. It writes nothing but draft literals.
 */
export default {
 name: 'forgeax.engine.view.modeling',
 inject: ['viewOperationClient'],
 async apply(ctx: Context, config: FrontendConfig = {}) {
  const document = config.document ?? globalThis.document;
  if (!document?.createElement) return;
  const page = config.pageHost ?? ctx.get('pageHost', false);
  const panelHost = config.panelHost ?? ctx.get('panelHost', false);
  if (!page || !panelHost) throw new Error('The modeling page requires its native PageHost and PanelHost');
  const client = ctx.get('viewOperationClient') as unknown as ViewWorkspaceClient;
  const reader = createWorkspaceStateReader(client);
  // One context object per published workspace state: React compares snapshots by identity.
  let cached: { state: unknown; context: ModelingContext } | undefined;
  const context = (): ModelingContext => {
   const state = reader.getSnapshot();
   if (cached?.state === state) return cached.context;
   cached = { state, context: derive(state) };
   return cached.context;
  };
  const derive = (state: ReturnType<typeof reader.getSnapshot>): ModelingContext => {
   const project = state?.project;
   return {
    ...(project?.id === undefined ? {} : { projectId: project.id }),
    ...(project?.root === undefined ? {} : { root: project.root }),
    previews: (state?.previews ?? []).map(p => ({
     targetId: p.target.targetId,
     ...(p.target.generation === undefined ? {} : { generation: p.target.generation }),
     label: p.asset?.sourceKey ?? p.asset?.name ?? p.target.targetId,
    })),
   };
  };
  const host: ModelingHost = {
   context,
   subscribe: listener => reader.subscribe(listener),
   async listSources() {
    const { projectId, root } = context();
    if (!projectId) return [];
    const reply = await client.transport.request<{ projectId: string }, { sources?: { sourcePath: string }[] }>(VIEW_PACK_SOURCES_SERVICE, { projectId });
    return [...new Set((reply.sources ?? []).map(s => projectRelative(s.sourcePath, root)).filter(p => p.endsWith('.pack.ts')))].sort();
   },
   operations: modelingOperations((service, payload) => client.transport.request(service, payload)),
   async readImage(path) {
    const file = await client.transport.request<{ path: string }, { dataUrl?: string }>(VIEW_FILE_GET_SERVICE, { path });
    return file.dataUrl;
   },
   draft(sourcePath) {
    const state = reader.getSnapshot();
    const projectId = state?.project?.id;
    const sessionId = state?.projectTarget?.sessionId;
    const targetId = state?.projectTarget?.targetId;
    if (!projectId || !sessionId || !targetId) return undefined;
    const author = createPackAuthoringClient(client, { projectId, sessionId, targetId, sourcePath });
    return {
     getSnapshot: () => author.getSnapshot(),
     subscribe: listener => author.subscribe(listener),
     open: () => author.open(),
     edit: (field, value) => author.edit(field, value),
     flush: () => author.flush(),
     save: () => author.act('save'),
     dispose: () => author.dispose(),
    };
   },
   async setOverlays(target, overlays) {
    await client.setPreviewDisplay({ overlays } as never, {
     targetId: target.targetId,
     ...(target.generation === undefined ? {} : { targetGeneration: target.generation }),
    });
   },
   async copy(text) { await globalThis.navigator?.clipboard?.writeText(text); },
  };
  const node = document.createElement('section');
  node.dataset.forgeaxViewSurface = 'modeling';
  node.style.cssText = 'height:100%;min-height:0;overflow:auto';
  const unregister = page.registerType({ typeId: 'modeling', context: 'project', title: 'Modeling', order: 12,
   closable: true, singleton: true, initial: false, openable: true, layout: 'surface', showPanelRail: false, hideWhenInactive: true });
  const unmount = page.mount('modeling', node);
  let dispose: Dispose | undefined;
  let live = true;
  ctx.effect(() => async () => { live = false; await dispose?.(); unmount(); unregister(); reader.dispose(); });
  const mounted = await panelHost.mountPanelInto({ element: node, panel: 'Modeling', props: { host } });
  if (live) dispose = mounted; else await mounted?.();
 },
} satisfies Plugin.Object;
