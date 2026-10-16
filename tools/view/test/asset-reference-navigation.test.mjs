import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createToolApi, defineTool, toolJsonSchema } from '@forgeax/engine/tool-runtime';
import { ViewWorkspaceBroker } from '../packages/view-workspace-core/src/broker.ts';
import { serializeWorkspaceOpenRequest } from '../packages/view-workspace-core/src/contract.ts';
import { createResourcePageTitleController } from '../packages/view-workspace-core/src/page-title.ts';
import { createViewPageHost, createViewPageTypeRegistry, resolveResourcePageType } from '../packages/viewer/src/host/page-registry.ts';

it('a Catalog kind without a View preview opens inspect-only without invoking an Engine preview', async () => {
  const asset = { guid: 'effect', kind: 'vfx', sourceKey: 'vfx/smoke', previewable: true };
  const api = createToolApi();
  const calls = [];
  const schema = toolJsonSchema({ type: 'object' });
  api.registerProvider({ providerId: 'engine', sourceId: 'engine-workspace', realm: 'host', tools: [defineTool({
    id: 'engine.asset.inspect', path: ['engine', 'asset', 'inspect'], title: 'Inspect', summary: 'Inspect asset identity', realm: 'host',
    argsSchema: schema, resultSchema: schema, inputSchema: {}, outputSchema: {}, evidence: [],
  }, args => { calls.push(args); return { inspection: { guid: asset.guid, asset } }; })] });
  const broker = new ViewWorkspaceBroker({ toolApi: api, engine: { project: { project: { id: 'project', root: '/project' } }, previews: [] } });
  broker.assets = [asset];
  const state = await broker.invoke('asset.open', { projectId: 'project', guid: asset.guid });
  assert.equal(calls.length, 1);
  assert.equal(state.openRequest.detailsOnly, true);
  assert.equal(state.openRequest.preview, undefined);
  assert.equal(state.resourceOpens.vfx.detailsOnly, true);
  assert.equal(state.previews.length, 0);
  await api.dispose();
});

it('details-only opens explicitly select the fallback page and preserve the request marker', () => {
  const registry = createViewPageTypeRegistry();
  const base = { title: 'Resource', context: 'project', closable: true, singleton: true, initial: false, openable: true, layout: 'dock', showPanelRail: true, hideWhenInactive: true, order: 0 };
  registry.registerType({ ...base, typeId: 'mesh', resourceSelector: { kinds: ['mesh'] } });
  registry.registerType({ ...base, typeId: 'asset', resourceSelector: { fallback: true } });
  const request = serializeWorkspaceOpenRequest({ requestId: 'open', sequence: 1, detailsOnly: true, asset: { guid: 'mesh', kind: 'mesh' } });
  assert.equal(request.detailsOnly, true);
  assert.equal(resolveResourcePageType(registry.getTypes(), request).pageType.typeId, 'asset');
});

it('page capability follows dedicated page removal and restoration', () => {
  const registry = createViewPageTypeRegistry();
  const host = createViewPageHost({ registry });
  const base = { title: 'Resource', context: 'project', closable: true, singleton: true, initial: false, openable: true, layout: 'dock', showPanelRail: true, hideWhenInactive: true, order: 0 };
  host.registerType({ ...base, typeId: 'asset', resourceSelector: { fallback: true }, resourcePresentation: 'details' });
  const descriptor = { ...base, typeId: 'mesh', resourceSelector: { kinds: ['mesh'] }, resourcePresentation: 'preview' };
  const remove = host.registerType(descriptor);
  assert.equal(host.getAssetPresentation({ kind: 'mesh' }), 'preview');
  remove();
  assert.equal(host.getAssetPresentation({ kind: 'mesh' }), 'details');
  host.registerType(descriptor);
  assert.equal(host.getAssetPresentation({ kind: 'mesh' }), 'preview');
});

it('the generic resource title retains its own asset when other pages open', () => {
  let state = { openRequest: { detailsOnly: true, asset: { guid: 'audio', kind: 'audio', sourceKey: 'audio/ambient' } },
    resourceOpens: { audio: { detailsOnly: true, sequence: 1, asset: { guid: 'audio', kind: 'audio', sourceKey: 'audio/ambient' } } } };
  const listeners = new Set();
  const controller = createResourcePageTitleController({ subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); }, async getState() { return state; } }, []);
  const unsubscribe = controller.subscribeTitle(() => {});
  assert.equal(controller.getTitle(), 'ambient');
  state = { ...state, openRequest: { asset: { guid: 'mesh', kind: 'mesh', sourceKey: 'mesh/cube' } } };
  for (const listener of listeners) listener(state);
  assert.equal(controller.getTitle(), 'ambient');
  unsubscribe();
  controller.dispose();
});
