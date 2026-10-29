import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspaceState } from '@forgeax/view-workspace-core/contract';
import { mountMeshPropertiesPanel } from '../../packages/view-plugin-mesh/src/ui/mount';
import { setLocale } from '../../packages/view-plugin-mesh/src/i18n/index.ts';

setLocale('en');
let generation = 4, revision = 1, thumbnailEpoch = 0;
let wireframe = false, removed = false, failed = false, pending = false, defer = false;
let finish: (() => void) | undefined;
const calls: { operation: string; args: Record<string, unknown>; aborted: boolean }[] = [];
const listeners = new Set<(state: WorkspaceState) => void>();
const asset = { guid: 'mesh', kind: 'mesh', name: 'Astral Bloom', path: 'assets/fantasy.pack.ts' };
const materials = ['Azure Flux', 'Violet Rift'].map((name, index) => ({ guid: `material-${index}`, kind: 'material', name: `material/${name.toLowerCase().replaceAll(' ', '-')}`, path: asset.path }));
const slots = [{ slotName: 'Azure Flux', sourceKey: 'game-3d:fantasy:azure', defaultMaterial: 53 },
  { slotName: 'Violet Rift', sourceKey: 'game-3d:fantasy:violet', defaultMaterial: 54 },
  { slotName: 'Azure Repeated', defaultMaterial: 53 }, { slotName: 'Engine default' }];
const state = (): WorkspaceState => {
  const preview = { target: { targetId: 'mesh-preview', generation, worldId: 'world' }, asset,
    assetBinding: { publication: { generation, digest: 'sha256:retained-bound-mesh-publication', producerRevision: 'fixture', kind: 'memory' },
      meta: { kind: 'mesh', materialSlots: slots, submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 }], collision: { present: false } } } };
  return { revision, thumbnailEpoch, catalogEpoch: removed ? 2 : 1, browserGeneration: 1,
    project: { id: 'project', root: '/fixture', name: 'Material slots fixture' },
    projectTarget: { targetId: 'project', generation: 1 },
    previews: [preview], resourceOpens: { mesh: { asset, preview } }, assets: [asset, ...materials.filter((_, index) => !removed || index !== 1)] } as unknown as WorkspaceState;
};
const changed = () => { revision++; for (const listener of listeners) listener(state()); };
const client = {
  subscribe(listener: (value: WorkspaceState) => void) { listeners.add(listener); listener(state()); return () => listeners.delete(listener); },
  async getState() { return state(); },
  async call(operation: string, args: Record<string, unknown>, options: { signal?: AbortSignal } = {}) {
    const call = { operation, args, aborted: false }; calls.push(call);
    options.signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
    if (operation === 'scene.tree.get') return { targetId: 'mesh-preview', worldId: 'world', revision: 1, nextOffset: null,
      nodes: [{ entityId: 'entity', componentNames: ['MeshFilter', 'MeshRenderer'] }] };
    if (operation === 'entity.inspect') {
      const result = { entityId: 'entity', targetId: 'mesh-preview', worldId: 'world', assetReferences: { truncated: false, references: [
        { key: 'mesh', component: 'MeshFilter', field: 'assetHandle', kind: 'mesh', status: 'resolved', guid: wireframe ? 'helper' : 'mesh' },
        ...slots.map((slot, index) => ({ key: `materials[${index}]`, component: 'MeshRenderer', field: 'materials', kind: 'material', index, slotName: slot.slotName,
          origin: slot.defaultMaterial ? 'mesh-default' : 'engine-default', status: slot.defaultMaterial ? 'resolved' : 'builtin',
          handle: slot.defaultMaterial ?? 0, guid: slot.defaultMaterial ? `material-${slot.defaultMaterial === 54 ? 1 : 0}` : undefined })),
      ] } };
      if (defer) { defer = false; pending = true; await new Promise<void>(resolve => { finish = resolve; }); pending = false; }
      return result;
    }
    if (operation === 'assets.thumbnails') return { thumbnails: (args.guids as string[]).map(guid => ({ guid,
      state: failed ? 'failed' : 'ready', dataUrl: '/thumbnail.png' })) };
    return {};
  },
};
Object.assign(globalThis, { meshSlotsFixture: {
  calls, pending: () => pending,
  replace() { generation++; changed(); },
  wireframe(value: boolean) { wireframe = value; changed(); },
  removeMaterial() { removed = true; changed(); },
  failThumbnails() { failed = true; thumbnailEpoch++; changed(); },
  defer() { defer = true; }, finish() { finish?.(); },
  longName() { materials[0].name = 'material/' + 'VeryLongMaterialName'.repeat(12); changed(); },
} });
await mountMeshPropertiesPanel({ client: client as unknown as ViewWorkspaceClient,
  mountElement: document.getElementById('app')!,
  assetActions: value => {
    const guid = (value as { guid: string }).guid;
    return {
      onOpen: () => { void client.call('asset.open', { projectId: 'project', targetId: 'project', targetGeneration: 1, guid }); },
      onBrowse: () => { void client.call('asset.browse', { guid }); },
    };
  },
});
